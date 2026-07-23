import { AgentSdk, type AgentSdkOptions } from '@adaptive-agent/agent-sdk';
import { parseCliArgs, type ManualTestCliOptions } from '@adaptive-agent/agent-sdk/src/adaptive-agent.js';
import type { AgentEvent, JsonValue, UUID } from '@adaptive-agent/core';

import {
  ADAPTIVE_AGENT_CLI_COMMANDS,
  DESKTOP_BRIDGE_VERSION,
  DESKTOP_PROTOCOL_VERSION,
  DESKTOP_RPC_METHODS,
  JSON_RPC_ERROR_CODES,
  SUPPORTED_DESKTOP_PROTOCOL_VERSIONS,
  DesktopProtocolError,
  type AdaptiveAgentCliCommand,
  type CliExecuteParams,
  type DesktopClientInfo,
  type DesktopMessage,
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
        'Call initialize with protocolVersion "1.10" before other JSON-RPC methods.',
        JSON_RPC_ERROR_CODES.notInitialized,
      );
    }

    switch (request.method) {
      case 'runtime/initialize':
        return this.initializeRuntime(request.params ?? {});
      case 'runtime/info':
        return this.runtimeInfo();
      case 'runtime/shutdown':
        await this.close();
        return { shutdown: true };
      case 'agent/run': {
        const params = request.params!;
        return asJsonValue(await this.requireSdk().runRaw(params.goal, {
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
          ...(params.input === undefined ? {} : { input: params.input }),
        }));
      }
      case 'agent/chat': {
        const params = request.params!;
        return asJsonValue(await this.requireSdk().chatRaw(params.message, {
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
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
  }

  private initializeProtocol(params: { protocolVersion: string; clientInfo: DesktopClientInfo }): JsonValue {
    if (this.rpcInitialized) {
      throw new DesktopProtocolError(
        'ALREADY_INITIALIZED',
        'The JSON-RPC protocol is already initialized.',
        JSON_RPC_ERROR_CODES.alreadyInitialized,
      );
    }
    if (params.protocolVersion !== DESKTOP_PROTOCOL_VERSION) {
      throw new DesktopProtocolError(
        'UNSUPPORTED_PROTOCOL_VERSION',
        `Protocol version ${params.protocolVersion} is not supported by the JSON-RPC endpoint.`,
        JSON_RPC_ERROR_CODES.invalidParams,
        { supportedProtocolVersions: [...SUPPORTED_DESKTOP_PROTOCOL_VERSIONS] },
      );
    }
    this.rpcInitialized = true;
    this.clientInfo = params.clientInfo;
    return {
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
      bridgeVersion: DESKTOP_BRIDGE_VERSION,
      serverInfo: { name: '@adaptive-agent/desktop-bridge', version: DESKTOP_BRIDGE_VERSION },
      capabilities: {
        methods: [...DESKTOP_RPC_METHODS],
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
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
      bridgeVersion: DESKTOP_BRIDGE_VERSION,
      initialized: this.sdk !== undefined,
      ...(this.clientInfo ? { clientInfo: asJsonValue(this.clientInfo) } : {}),
      ...(this.sdk ? {
        runtimeMode: this.sdk.config.runtime.mode,
        agentId: this.sdk.config.agent.id,
        workspaceRoot: this.sdk.config.workspaceRoot,
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

    const settingsOverrides: NonNullable<AgentSdkOptions['settingsOverrides']> = {
      logging: { enabled: false },
      events: { subscribe: false, printLifecycle: false, verbose: false },
      interaction: {
        approvalMode: params.approvalMode ?? 'manual',
        clarificationMode: params.clarificationMode ?? 'interactive',
      },
    };
    const options: AgentSdkOptions = {
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.agentConfigPath ? { agentConfigPath: params.agentConfigPath } : {}),
      ...(params.settingsConfigPath ? { settingsConfigPath: params.settingsConfigPath } : {}),
      ...(params.runtimeMode ? { runtimeMode: params.runtimeMode } : {}),
      ...(params.provider || params.model ? {
        model: {
          ...(params.provider ? { provider: params.provider } : {}),
          ...(params.model ? { model: params.model } : {}),
        },
      } : {}),
      settingsOverrides,
      eventListener: (event: AgentEvent) => this.writeAgentEvent(event),
    };

    const initialization = AgentSdk.create(options);
    this.sdkInitialization = initialization;
    try {
      const sdk = await initialization;
      this.sdk = sdk;
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
      };
    } finally {
      this.sdkInitialization = undefined;
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
      return {
        command,
        cliExecute: !unavailableReason,
        ...(unavailableReason ? { unavailableReason } : {}),
        ...(command === 'ambient' ? { subcommands: ['start'] } : {}),
        ...(command === 'eval' ? { subcommands: ['cases', 'gaia'] } : {}),
        ...(command === 'context' ? { subcommands: ['create', 'list', 'show', 'delete'] } : {}),
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

    const argv = parsed.output === 'pretty' && !params.argv.includes('--output')
      ? [...params.argv, '--output', 'json']
      : [...params.argv];
    let result: CliExecutionResult;
    try {
      result = await this.cliExecutor.execute({
        argv,
        ...(params.stdin !== undefined ? { stdin: params.stdin } : {}),
        ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
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

function asRunId(runId: string): UUID {
  if (!runId.trim()) throw new DesktopProtocolError('INVALID_PARAMS', 'runId must be a non-empty string.');
  return runId as UUID;
}

function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
