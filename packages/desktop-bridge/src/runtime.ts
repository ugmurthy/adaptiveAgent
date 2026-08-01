import { AgentSdk, type AgentSdkOptions, type ResolvedAgentSdkConfig } from '@adaptive-agent/agent-sdk';
import {
  ADAPTIVE_AGENT_CLI_COMMANDS,
  ADAPTIVE_AGENT_CLI_SUBCOMMANDS,
  parseCliArgs,
  type AdaptiveAgentCliCommand,
  type ManualTestCliOptions,
} from '@adaptive-agent/agent-sdk/cli';
import type { AgentEvent, JsonValue, UUID } from '@adaptive-agent/core';
import {
  GatewayClient,
  type InferenceMode,
  type InferenceTier,
  type ProfileRef,
} from '@adaptive-agent/gateway-client';

import {
  DESKTOP_BRIDGE_VERSION,
  DESKTOP_PROTOCOL_VERSION,
  DESKTOP_RPC_METHODS,
  JSON_RPC_ERROR_CODES,
  SUPPORTED_DESKTOP_PROTOCOL_VERSIONS,
  DesktopProtocolError,
  type CliExecuteParams,
  type DesktopClientInfo,
  type DesktopMessage,
  type DesktopProtocolVersion,
  type DesktopRpcRequest,
  type JsonRpcId,
  type RuntimeInitializeParams,
} from './protocol.js';

export type DesktopMessageWriter = (message: DesktopMessage) => void;

export interface CliExecutionOutput {
  stream: 'stdout' | 'stderr';
  line: string;
}

export interface CliExecutionRequest extends CliExecuteParams {
  environment?: NodeJS.ProcessEnv;
  onOutput: (output: CliExecutionOutput) => void;
}

export interface CliExecutionResult {
  exitCode: number;
  signal?: string;
  timedOut: boolean;
}

export interface CliExecutor {
  execute(request: CliExecutionRequest): Promise<CliExecutionResult>;
}

export interface SafeResolvedConfiguration {
  agent: { id: string; name: string; description?: string; defaultInvocationMode: string };
  model: { provider: string; model: string; credentialAvailable: boolean };
  inference: { mode: string; tier: string };
  runtime: { mode: string; sqlitePath?: string };
  workspace: { root: string; shellCwd: string };
  interaction: { approvalMode: string; clarificationMode: string };
}

const CLI_EXECUTE_DENYLIST = new Map<AdaptiveAgentCliCommand, string>([
  ['ambient', 'ambient start is a long-running supervisor; use a dedicated lifecycle API instead'],
  ['update', 'the desktop sidecar must not replace installed binaries'],
  ['uninstall', 'the desktop sidecar must not remove installed binaries'],
]);

const RUN_REFERENCING_CLI_COMMANDS = new Set<ManualTestCliOptions['command']>([
  'inspect',
  'resume',
  'recover',
  'continue',
  'interrupt',
  'replay',
]);

export class DesktopRuntime {
  private sdk: AgentSdk | undefined;
  private sdkInitialization: Promise<AgentSdk> | undefined;
  private rpcInitialized = false;
  private clientInfo: DesktopClientInfo | undefined;
  private negotiatedProtocolVersion: DesktopProtocolVersion = DESKTOP_PROTOCOL_VERSION;
  private accessToken: string | undefined;
  private gatewayClient: GatewayClient | undefined;
  private executionSelection: { inferenceMode: InferenceMode; inferenceTier: InferenceTier; profileRef?: ProfileRef } | undefined;
  private configurationDriven = false;

  constructor(
    private readonly write: DesktopMessageWriter,
    private readonly cliExecutor?: CliExecutor,
  ) {}

  readyMessage(): DesktopMessage {
    return {
      jsonrpc: '2.0',
      method: 'runtime/ready',
      params: {
        protocolVersion: DESKTOP_PROTOCOL_VERSION,
        bridgeVersion: DESKTOP_BRIDGE_VERSION,
        pid: process.pid,
      },
    };
  }

  async handleRpc(request: DesktopRpcRequest): Promise<JsonValue> {
    if (request.method === 'initialize') return this.initializeProtocol(request.params!);
    if (!this.rpcInitialized) {
      throw new DesktopProtocolError(
        'NOT_INITIALIZED',
        'Call initialize with a supported protocolVersion before other JSON-RPC methods.',
        JSON_RPC_ERROR_CODES.notInitialized,
      );
    }
    if (this.negotiatedProtocolVersion === '1.10' && request.method === 'auth/updateAccessToken') {
      throw new DesktopProtocolError('METHOD_NOT_FOUND', 'auth/updateAccessToken requires desktop protocol 1.11.', JSON_RPC_ERROR_CODES.methodNotFound);
    }

    switch (request.method) {
      case 'runtime/initialize':
        return this.initializeRuntime(request.params ?? {});
      case 'runtime/info':
        return this.runtimeInfo();
      case 'runtime/shutdown':
        await this.close();
        return { shutdown: true };
      case 'auth/updateAccessToken':
        this.accessToken = request.params!.accessToken;
        await this.gatewayClient?.reconnect();
        return { updated: true };
      case 'agent/run': {
        const params = request.params!;
        this.validateExecutionSelection(params);
        const sdk = this.requireSdk();
        const run = this.configurationDriven ? sdk.run.bind(sdk) : sdk.runRaw.bind(sdk);
        return asJsonValue(await run(params.goal, {
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
          ...(params.input === undefined ? {} : { input: params.input }),
          ...(params.inferenceTier ? { inferenceTier: params.inferenceTier } : {}),
        }));
      }
      case 'agent/chat': {
        const params = request.params!;
        this.validateExecutionSelection(params);
        return asJsonValue(await this.requireSdk().chatRaw(params.message, {
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
          ...(params.inferenceTier ? { inferenceTier: params.inferenceTier } : {}),
        }));
      }
      case 'run/resume':
        return asJsonValue(await this.requireSdk().resumeRaw(asRunId(request.params!.runId)));
      case 'run/retry':
        return asJsonValue(await this.requireSdk().retryRaw(asRunId(request.params!.runId)));
      case 'run/recover': {
        const params = request.params!;
        const sdk = this.requireSdk();
        if (params.dryRun) return asJsonValue(await sdk.getRecoveryPlan(asRunId(params.runId)));
        return asJsonValue(await sdk.recoverRaw({ runId: asRunId(params.runId), strategy: params.strategy ?? 'auto' }));
      }
      case 'run/continue':
        return asJsonValue(await this.requireSdk().continueRunRaw({ fromRunId: asRunId(request.params!.runId) }));
      case 'run/interrupt':
        await this.requireSdk().interrupt(asRunId(request.params!.runId));
        return { runId: request.params!.runId, interrupted: true };
      case 'run/inspect':
        return asJsonValue(await this.requireSdk().inspect(asRunId(request.params!.runId)));
      case 'run/replay': {
        const runId = asRunId(request.params!.runId);
        const inspection = await this.requireSdk().inspect(runId);
        return asJsonValue({ runId, run: inspection.run, eventCount: inspection.events.length, events: inspection.events });
      }
      case 'run/steer': {
        const params = request.params!;
        await this.requireSdk().steer(asRunId(params.runId), {
          message: params.message,
          ...(params.role ? { role: params.role } : {}),
          ...(params.metadata ? { metadata: params.metadata } : {}),
        });
        return { runId: params.runId, accepted: true };
      }
      case 'interaction/resolveApproval':
        return this.resolveApproval(request.params!.runId, request.params!.approved);
      case 'interaction/resolveClarification':
        return asJsonValue(await this.requireSdk().agent.resolveClarification(
          asRunId(request.params!.runId),
          request.params!.answer,
        ));
      case 'cli/commands':
        return this.cliCommands();
      case 'cli/execute':
        return this.executeCli(request.id, request.params!);
      default:
        throw new DesktopProtocolError(
          'METHOD_NOT_FOUND',
          `Unknown JSON-RPC method: ${(request as { method: string }).method}`,
          JSON_RPC_ERROR_CODES.methodNotFound,
        );
    }
  }

  async close(): Promise<void> {
    const initialization = this.sdkInitialization;
    if (initialization) await initialization.catch(() => undefined);
    const sdk = this.sdk;
    this.sdk = undefined;
    await sdk?.close();
    this.gatewayClient?.close();
    this.gatewayClient = undefined;
  }

  private initializeProtocol(params: { protocolVersion: string; clientInfo: DesktopClientInfo }): JsonValue {
    if (this.rpcInitialized) {
      throw new DesktopProtocolError(
        'ALREADY_INITIALIZED',
        'The JSON-RPC protocol is already initialized.',
        JSON_RPC_ERROR_CODES.alreadyInitialized,
      );
    }
    if (!SUPPORTED_DESKTOP_PROTOCOL_VERSIONS.includes(params.protocolVersion as typeof SUPPORTED_DESKTOP_PROTOCOL_VERSIONS[number])) {
      throw new DesktopProtocolError(
        'UNSUPPORTED_PROTOCOL_VERSION',
        `Protocol version ${params.protocolVersion} is not supported by the JSON-RPC endpoint.`,
        JSON_RPC_ERROR_CODES.invalidParams,
        { supportedProtocolVersions: [...SUPPORTED_DESKTOP_PROTOCOL_VERSIONS] },
      );
    }
    this.rpcInitialized = true;
    this.negotiatedProtocolVersion = params.protocolVersion as typeof SUPPORTED_DESKTOP_PROTOCOL_VERSIONS[number];
    this.clientInfo = params.clientInfo;
    return {
      protocolVersion: this.negotiatedProtocolVersion,
      bridgeVersion: DESKTOP_BRIDGE_VERSION,
      serverInfo: { name: '@adaptive-agent/desktop-bridge', version: DESKTOP_BRIDGE_VERSION },
      capabilities: {
        methods: DESKTOP_RPC_METHODS.filter((method) => this.negotiatedProtocolVersion === '1.11' || method !== 'auth/updateAccessToken'),
        notifications: ['runtime/ready', 'agent/event', 'cli/output'],
        cli: {
          commands: [...ADAPTIVE_AGENT_CLI_COMMANDS],
          execute: this.cliExecutor !== undefined,
          transport: 'child-process',
          output: 'streamed-notifications',
        },
      },
    };
  }

  private runtimeInfo(): JsonValue {
    return {
      protocolVersion: this.negotiatedProtocolVersion,
      bridgeVersion: DESKTOP_BRIDGE_VERSION,
      initialized: this.sdk !== undefined,
      ...(this.clientInfo ? { clientInfo: asJsonValue(this.clientInfo) } : {}),
      ...(this.sdk ? {
        runtimeMode: this.sdk.config.runtime.mode,
        agentId: this.sdk.config.agent.id,
        workspaceRoot: this.sdk.config.workspaceRoot,
        inferenceMode: this.sdk.config.inference.mode,
        inferenceTier: this.sdk.config.inference.tier,
        resolvedConfiguration: asJsonValue(safeResolvedConfiguration(this.sdk.config)),
        ...(this.executionSelection?.profileRef ? { profileRef: asJsonValue(this.executionSelection.profileRef) } : {}),
        connections: {
          sqlite: {
            configured: this.sdk.config.runtime.mode === 'sqlite',
            state: this.sdk.config.runtime.mode === 'sqlite' ? 'connected' : 'not_configured',
            ...(this.sdk.config.runtime.sqlitePath ? { path: this.sdk.config.runtime.sqlitePath } : {}),
          },
          gateway: {
            configured: this.gatewayClient !== undefined,
            state: this.gatewayClient?.connectionState ?? 'not_configured',
          },
        },
      } : {}),
    };
  }

  private async initializeRuntime(params: RuntimeInitializeParams): Promise<JsonValue> {
    if (this.sdk || this.sdkInitialization) {
      throw new DesktopProtocolError(
        'ALREADY_INITIALIZED',
        'The agent runtime is already initialized or initializing.',
        JSON_RPC_ERROR_CODES.alreadyInitialized,
      );
    }

    const inferenceMode = params.inferenceMode ?? (params.profileRef?.source === 'server' ? 'gateway' : undefined);
    if (params.profileRef?.source === 'local') {
      throw new DesktopProtocolError('INVALID_PARAMS', 'runtime/initialize profileRef currently supports exact server profile refs; use agentConfigPath for local profiles.', JSON_RPC_ERROR_CODES.invalidParams);
    }
    if (params.profileRef && inferenceMode !== 'gateway') {
      throw new DesktopProtocolError('INVALID_PARAMS', 'Server profile refs require gateway inference mode.', JSON_RPC_ERROR_CODES.invalidParams);
    }
    if ((inferenceMode === 'gateway' || params.requireRunPermit) && !params.gatewayUrl) {
      throw new DesktopProtocolError('INVALID_PARAMS', 'gatewayUrl is required for gateway inference or required run permits.', JSON_RPC_ERROR_CODES.invalidParams);
    }
    if (params.configurationDriven && hasConfigurationOverrides(params)) {
      throw new DesktopProtocolError(
        'INVALID_PARAMS',
        'configurationDriven initialization cannot override runtime, model, inference, gateway, or interaction settings.',
        JSON_RPC_ERROR_CODES.invalidParams,
      );
    }

    const gatewayClient = inferenceMode === 'gateway' || params.requireRunPermit
      ? new GatewayClient({
          url: params.gatewayUrl!,
          accessToken: () => this.accessToken ?? '',
          clientName: '@adaptive-agent/desktop-bridge',
          clientVersion: DESKTOP_BRIDGE_VERSION,
        })
      : undefined;
    this.gatewayClient = gatewayClient;

    const settingsOverrides: NonNullable<AgentSdkOptions['settingsOverrides']> = {
      logging: { enabled: false },
      events: { subscribe: false, printLifecycle: false, verbose: false },
      ...(params.configurationDriven ? {} : {
        interaction: {
          approvalMode: params.approvalMode ?? 'manual',
          clarificationMode: params.clarificationMode ?? 'interactive',
        },
      }),
    };
    const options: AgentSdkOptions = {
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.agentConfigPath ? { agentConfigPath: params.agentConfigPath } : {}),
      ...(params.settingsConfigPath ? { settingsConfigPath: params.settingsConfigPath } : {}),
      ...(params.configurationDriven ? {} : { runtimeMode: params.runtimeMode ?? 'sqlite' }),
      ...(params.sqlitePath ? { sqlitePath: params.sqlitePath } : {}),
      ...(params.provider || params.model ? {
        model: {
          ...(params.provider ? { provider: params.provider } : {}),
          ...(params.model ? { model: params.model } : {}),
        },
      } : {}),
      settingsOverrides,
      ...(inferenceMode ? { inferenceMode } : {}),
      ...(params.inferenceTier ? { inferenceTier: params.inferenceTier } : {}),
      ...(params.profileRef ? { serverProfile: params.profileRef, profileRefs: [params.profileRef] } : {}),
      ...(gatewayClient ? {
        gatewayClient,
        gateway: {
          url: params.gatewayUrl,
          requireRunPermit: params.requireRunPermit ?? false,
          clientName: '@adaptive-agent/desktop-bridge',
          clientVersion: DESKTOP_BRIDGE_VERSION,
        },
      } : {}),
      eventListener: (event: AgentEvent) => this.writeAgentEvent(event),
    };

    const initialization = AgentSdk.create(options);
    this.sdkInitialization = initialization;
    try {
      const sdk = await initialization;
      if (params.configurationDriven) {
        try {
          validateRestrictedDesktopConfiguration(sdk.config);
        } catch (error) {
          await sdk.close();
          throw error;
        }
      }
      this.sdk = sdk;
      this.configurationDriven = params.configurationDriven ?? false;
      this.executionSelection = {
        inferenceMode: sdk.config.inference.mode,
        inferenceTier: sdk.config.inference.tier,
        ...(params.profileRef ? { profileRef: structuredClone(params.profileRef) } : {}),
      };
      return {
        agent: {
          id: sdk.config.agent.id,
          name: sdk.config.agent.name,
          ...(sdk.config.agent.description ? { description: sdk.config.agent.description } : {}),
        },
        runtimeMode: sdk.config.runtime.mode,
        workspaceRoot: sdk.config.workspaceRoot,
        shellCwd: sdk.config.shellCwd,
        registeredToolNames: sdk.registeredToolNames,
        inferenceMode: sdk.config.inference.mode,
        inferenceTier: sdk.config.inference.tier,
        resolvedConfiguration: asJsonValue(safeResolvedConfiguration(sdk.config)),
        ...(params.profileRef ? { profileRef: asJsonValue(params.profileRef) } : {}),
        connections: {
          sqlite: sdk.config.runtime.mode === 'sqlite' ? 'connected' : 'not_configured',
          gateway: gatewayClient?.connectionState ?? 'not_configured',
        },
      };
    } catch (error) {
      await this.sdk?.close().catch(() => undefined);
      this.sdk = undefined;
      gatewayClient?.close();
      if (this.gatewayClient === gatewayClient) this.gatewayClient = undefined;
      throw error;
    } finally {
      this.sdkInitialization = undefined;
    }
  }

  private validateExecutionSelection(params: { inferenceMode?: InferenceMode; inferenceTier?: InferenceTier; profileRef?: ProfileRef }): void {
    const selection = this.executionSelection;
    if (!selection) return;
    if (params.inferenceMode && params.inferenceMode !== selection.inferenceMode) {
      throw new DesktopProtocolError('INVALID_PARAMS', `This runtime uses ${selection.inferenceMode} inference; initialize a separate runtime to use ${params.inferenceMode}.`, JSON_RPC_ERROR_CODES.invalidParams);
    }
    if (params.inferenceTier && selection.inferenceMode !== 'gateway') {
      throw new DesktopProtocolError('INVALID_PARAMS', 'inferenceTier may be selected per run only in gateway inference mode.', JSON_RPC_ERROR_CODES.invalidParams);
    }
    if (params.profileRef && !sameProfileRef(params.profileRef, selection.profileRef)) {
      throw new DesktopProtocolError('INVALID_PARAMS', 'The requested profileRef does not match the profile pinned when this runtime was initialized.', JSON_RPC_ERROR_CODES.invalidParams);
    }
  }

  private writeAgentEvent(event: AgentEvent): void {
    this.write({ jsonrpc: '2.0', method: 'agent/event', params: asJsonValue(event) });
  }

  private async resolveApproval(runId: string, approved: boolean): Promise<JsonValue> {
    const sdk = this.requireSdk();
    await sdk.agent.resolveApproval(asRunId(runId), approved);
    if (!approved) return asJsonValue(await sdk.inspect(asRunId(runId)));
    return asJsonValue(await sdk.resumeRaw(asRunId(runId)));
  }

  private cliCommands(): JsonValue {
    return ADAPTIVE_AGENT_CLI_COMMANDS.map((command) => {
      const unavailableReason = CLI_EXECUTE_DENYLIST.get(command);
      const subcommands = command in ADAPTIVE_AGENT_CLI_SUBCOMMANDS
        ? ADAPTIVE_AGENT_CLI_SUBCOMMANDS[command as keyof typeof ADAPTIVE_AGENT_CLI_SUBCOMMANDS]
        : undefined;
      return {
        command,
        cliExecute: !unavailableReason,
        ...(unavailableReason ? { unavailableReason } : {}),
        ...(subcommands ? { subcommands: [...subcommands] } : {}),
      };
    });
  }

  private async executeCli(requestId: JsonRpcId, params: CliExecuteParams): Promise<JsonValue> {
    if (!this.cliExecutor) {
      throw new DesktopProtocolError(
        'COMMAND_REJECTED',
        'CLI execution is unavailable in this bridge build.',
        JSON_RPC_ERROR_CODES.commandRejected,
      );
    }

    let parsed: ManualTestCliOptions;
    try {
      parsed = parseCliArgs(params.argv);
    } catch (error) {
      throw new DesktopProtocolError(
        'INVALID_PARAMS',
        safeErrorMessage(error),
        JSON_RPC_ERROR_CODES.invalidParams,
      );
    }

    const denied = CLI_EXECUTE_DENYLIST.get(parsed.command as AdaptiveAgentCliCommand);
    if (denied && !parsed.help) {
      throw new DesktopProtocolError(
        'COMMAND_REJECTED',
        `cli/execute does not allow ${parsed.command}: ${denied}.`,
        JSON_RPC_ERROR_CODES.commandRejected,
        { command: parsed.command },
      );
    }
    if (parsed.command === 'chat' && !parsed.help && !parsed.promptFilePath && parsed.goalArgs.length === 0 && params.stdin === undefined) {
      throw new DesktopProtocolError(
        'COMMAND_REJECTED',
        'Non-interactive chat requires a message, --file, or cli/execute stdin.',
        JSON_RPC_ERROR_CODES.commandRejected,
      );
    }
    if ((parsed.command === 'init' || parsed.command === 'agent-create') && !parsed.help && !parsed.yes) {
      throw new DesktopProtocolError(
        'COMMAND_REJECTED',
        `${parsed.command} requires --yes when invoked through cli/execute.`,
        JSON_RPC_ERROR_CODES.commandRejected,
      );
    }
    if (
      this.sdk?.config.runtime.mode === 'memory'
      && parsed.runtimeMode !== 'postgres'
      && (RUN_REFERENCING_CLI_COMMANDS.has(parsed.command) || (parsed.command === 'retry' && parsed.runId !== undefined))
    ) {
      throw new DesktopProtocolError(
        'COMMAND_REJECTED',
        `${parsed.command} cannot observe the persistent in-memory runtime from a CLI child; use the typed JSON-RPC method or --runtime postgres.`,
        JSON_RPC_ERROR_CODES.commandRejected,
      );
    }

    const runtime = this.sdk?.config.runtime;
    const argv = parsed.output === 'pretty' && !params.argv.includes('--output')
      ? [...params.argv, '--output', 'json']
      : [...params.argv];
    if (runtime?.mode === 'sqlite' && parsed.runtimeMode === undefined) {
      argv.push('--runtime', 'sqlite');
    }
    let result: CliExecutionResult;
    try {
      result = await this.cliExecutor.execute({
        argv,
        ...(params.stdin !== undefined ? { stdin: params.stdin } : {}),
        ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
        ...(runtime?.mode === 'sqlite' && runtime.sqlitePath
          ? { environment: { ADAPTIVE_AGENT_SQLITE_PATH: runtime.sqlitePath } }
          : {}),
        onOutput: ({ stream, line }) => {
          this.write({
            jsonrpc: '2.0',
            method: 'cli/output',
            params: { requestId, stream, line },
          });
        },
      });
    } catch (error) {
      throw new DesktopProtocolError(
        'COMMAND_FAILED',
        `Failed to execute adaptive-agent CLI: ${safeErrorMessage(error)}`,
        JSON_RPC_ERROR_CODES.commandFailed,
      );
    }
    return { command: parsed.command, argv, ...result };
  }

  private requireSdk(): AgentSdk {
    if (!this.sdk) {
      throw new DesktopProtocolError(
        'NOT_INITIALIZED',
        'Initialize the agent runtime before issuing agent commands.',
        JSON_RPC_ERROR_CODES.notInitialized,
      );
    }
    return this.sdk;
  }
}

export function safeResolvedConfiguration(config: ResolvedAgentSdkConfig): SafeResolvedConfiguration {
  return {
    agent: {
      id: config.agent.id,
      name: config.agent.name,
      ...(config.agent.description ? { description: config.agent.description } : {}),
      defaultInvocationMode: config.agent.defaultInvocationMode,
    },
    model: {
      provider: config.model.provider,
      model: config.model.model,
      credentialAvailable: Boolean(config.model.apiKey) || config.model.provider === 'ollama',
    },
    inference: { mode: config.inference.mode, tier: config.inference.tier },
    runtime: {
      mode: config.runtime.mode,
      ...(config.runtime.sqlitePath ? { sqlitePath: config.runtime.sqlitePath } : {}),
    },
    workspace: { root: config.workspaceRoot, shellCwd: config.shellCwd },
    interaction: { ...config.interaction },
  };
}

function hasConfigurationOverrides(params: RuntimeInitializeParams): boolean {
  return [
    params.agentConfigPath,
    params.runtimeMode,
    params.sqlitePath,
    params.provider,
    params.model,
    params.approvalMode,
    params.clarificationMode,
    params.inferenceMode,
    params.inferenceTier,
    params.profileRef,
    params.gatewayUrl,
    params.requireRunPermit,
  ].some((value) => value !== undefined);
}

export function validateRestrictedDesktopConfiguration(config: ResolvedAgentSdkConfig): void {
  const errors: string[] = [];
  if (config.inference.mode !== 'byok') errors.push(`inference.mode must be "byok" (resolved: "${config.inference.mode}")`);
  if (!config.agent.invocationModes.includes('run') || config.agent.defaultInvocationMode !== 'run') {
    errors.push('the selected agent must support run and set defaultInvocationMode to "run"');
  }
  if (config.interaction.approvalMode === 'manual') {
    errors.push('interaction.approvalMode must be "auto" or "reject"; manual approval is not available in the desktop MVP');
  }
  if (config.interaction.approvalMode === 'reject' && config.settings.defaults?.autoApproveAll === true) {
    errors.push('interaction.approvalMode "reject" conflicts with defaults.autoApproveAll true; remove autoApproveAll or set it to false');
  }
  if (config.interaction.clarificationMode === 'interactive') {
    errors.push('interaction.clarificationMode must be "fail"; interactive clarification is not available in the desktop MVP');
  }
  if (!safeResolvedConfiguration(config).model.credentialAvailable) {
    errors.push(`the configured ${config.model.provider} credential is unavailable in the sidecar environment`);
  }
  if (errors.length > 0) {
    throw new DesktopProtocolError(
      'INVALID_DESKTOP_CONFIGURATION',
      `Desktop settings are not runnable: ${errors.join('; ')}. Update agent.settings.json and reload settings.`,
      JSON_RPC_ERROR_CODES.invalidParams,
    );
  }
}

function asRunId(runId: string): UUID {
  if (!runId.trim()) throw new DesktopProtocolError('INVALID_PARAMS', 'runId must be a non-empty string.');
  return runId as UUID;
}

function sameProfileRef(left: ProfileRef, right: ProfileRef | undefined): boolean {
  return right !== undefined
    && left.source === right.source
    && left.id === right.id
    && left.version === right.version
    && left.contentHash === right.contentHash;
}

function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
