import {
  AgentSdk,
  agentConfigurationFingerprint,
  discoverAgentSdkAgents,
  inspectAgentSdkResolution,
  prepareTask,
  restoreTaskPreparation,
  resolveRuntimeTarget,
  selectAgentProfile,
  type AgentSelectionResult,
  type AgentSdkCatalogAgent,
  type AgentSdkOptions,
  type AgentSdkRunOptions,
  type AgentSettingsFile,
  type ResolvedAgentSdkConfig,
  type TaskPreparationResult,
} from '@adaptive-agent/agent-sdk';
import {
  archiveAgentProfile,
  prepareAgentConfigSave,
  prepareAgentCreate,
  readAgentProfile,
  restoreAgentProfile,
  saveAgentConfig,
} from '@adaptive-agent/agent-sdk/agent-create';
import {
  ADAPTIVE_AGENT_CLI_COMMANDS,
  ADAPTIVE_AGENT_CLI_SUBCOMMANDS,
  parseCliArgs,
  type AdaptiveAgentCliCommand,
  type ManualTestCliOptions,
} from '@adaptive-agent/agent-sdk/cli';
import { RuntimeDeletionError, type AgentEvent, type ChatMessage, type FileAccessExecutionContext, type JsonObject, type JsonValue, type ModelContentPart, type UUID } from '@adaptive-agent/core';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
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
  type CatalogInspectParams,
  type DesktopClientInfo,
  type DesktopAttachmentInput,
  type DesktopChatMessage,
  type DesktopMessage,
  type DesktopProtocolVersion,
  type DesktopRpcRequest,
  type EditableDesktopSettings,
  type JsonRpcId,
  type RunParams,
  type RuntimeInitializeParams,
} from './protocol.js';

interface PendingDesktopTaskPreparation {
  schemaVersion: 1;
  executionId: string;
  sessionId: string;
  originalObjective: string;
  targetAgent: { id: string; configPath: string; configurationFingerprint: string };
  attachments: { images: string[]; files: string[]; audio: string[] };
  contentParts: ModelContentPart[];
  input?: JsonValue;
  fileAccess?: FileAccessExecutionContext;
  inferenceTier?: InferenceTier;
  agentSelection?: JsonObject;
  preparations: TaskPreparationResult[];
}

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
  agent: { id: string; configPath?: string; name: string; configurationFingerprint: string; description?: string; defaultInvocationMode: string; selectionMode: 'fixed' | 'auto' };
  model: { provider: string; model: string; credentialAvailable: boolean };
  inference: { mode: string; tier: string };
  runtime: { mode: string; sqlitePath?: string };
  workspace: { root: string; shellCwd: string };
  interaction: { approvalMode: string; clarificationMode: string };
  taskPreparation: { mode: 'never' | 'auto' | 'always' };
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
  private readonly selectedAgentSdks = new Map<string, AgentSdk>();
  private readonly runSdks = new Map<string, AgentSdk>();
  private sdkInitialization: Promise<AgentSdk> | undefined;
  private sdkOptions: AgentSdkOptions | undefined;
  private managedAttachmentRoot: string | undefined;
  private rpcInitialized = false;
  private clientInfo: DesktopClientInfo | undefined;
  private negotiatedProtocolVersion: DesktopProtocolVersion = DESKTOP_PROTOCOL_VERSION;
  private accessToken: string | undefined;
  private gatewayClient: GatewayClient | undefined;
  private executionSelection: { inferenceMode: InferenceMode; inferenceTier: InferenceTier; profileRef?: ProfileRef } | undefined;
  private configurationDriven = false;
  private settingsPath: string | undefined;
  private settingsCwd = process.cwd();
  private settingsUpdateInProgress = false;
  private agentBuilderInProgress = false;

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
    if ((this.negotiatedProtocolVersion === '1.10' || this.negotiatedProtocolVersion === '1.11')
      && (request.method.startsWith('history/') || request.method === 'settings/update')) {
      throw new DesktopProtocolError('METHOD_NOT_FOUND', `${request.method} requires desktop protocol 1.12.`, JSON_RPC_ERROR_CODES.methodNotFound);
    }
    if (!['1.13', '1.14', '1.15', '1.16', '1.17', '1.18', '1.19'].includes(this.negotiatedProtocolVersion)
      && request.method.startsWith('execution/')) {
      throw new DesktopProtocolError('METHOD_NOT_FOUND', `${request.method} requires desktop protocol 1.13.`, JSON_RPC_ERROR_CODES.methodNotFound);
    }
    if (!['1.14', '1.15', '1.16', '1.17', '1.18', '1.19'].includes(this.negotiatedProtocolVersion) && request.method === 'catalog/inspect') {
      throw new DesktopProtocolError('METHOD_NOT_FOUND', 'catalog/inspect requires desktop protocol 1.14.', JSON_RPC_ERROR_CODES.methodNotFound);
    }
    if (!['1.15', '1.16', '1.17', '1.18', '1.19'].includes(this.negotiatedProtocolVersion) && ['agent/createDraft', 'agent/validateConfig', 'agent/saveConfig'].includes(request.method)) {
      throw new DesktopProtocolError('METHOD_NOT_FOUND', `${request.method} requires desktop protocol 1.15.`, JSON_RPC_ERROR_CODES.methodNotFound);
    }
    if (!['1.16', '1.17', '1.18', '1.19'].includes(this.negotiatedProtocolVersion) && ['agent/readConfig', 'agent/archiveConfig', 'agent/restoreConfig'].includes(request.method)) {
      throw new DesktopProtocolError('METHOD_NOT_FOUND', `${request.method} requires desktop protocol 1.16.`, JSON_RPC_ERROR_CODES.methodNotFound);
    }
    if (!['1.17', '1.18', '1.19'].includes(this.negotiatedProtocolVersion) && request.method === 'run/delete') {
      throw new DesktopProtocolError('METHOD_NOT_FOUND', 'run/delete requires desktop protocol 1.17.', JSON_RPC_ERROR_CODES.methodNotFound);
    }
    if (!['1.18', '1.19'].includes(this.negotiatedProtocolVersion) && request.method === 'agents/list') {
      throw new DesktopProtocolError('METHOD_NOT_FOUND', 'agents/list requires desktop protocol 1.18.', JSON_RPC_ERROR_CODES.methodNotFound);
    }
    if (this.negotiatedProtocolVersion !== '1.19' && request.method === 'agent/createDraft'
      && (request.params?.id !== undefined || request.params?.provider !== undefined || request.params?.model !== undefined)) {
      throw new DesktopProtocolError('INVALID_PARAMS', 'Agent draft id, provider, and model overrides require desktop protocol 1.19.', JSON_RPC_ERROR_CODES.invalidParams);
    }
    if (!['1.14', '1.15', '1.16', '1.17', '1.18', '1.19'].includes(this.negotiatedProtocolVersion) && request.method === 'runtime/initialize' && request.params?.agentSelection) {
      throw new DesktopProtocolError('INVALID_PARAMS', 'Exact agent selection requires desktop protocol 1.14.', JSON_RPC_ERROR_CODES.invalidParams);
    }
    if (!['1.13', '1.14', '1.15', '1.16', '1.17', '1.18', '1.19'].includes(this.negotiatedProtocolVersion) && hasV113Fields(request)) {
      throw new DesktopProtocolError('INVALID_PARAMS', 'Attachment and execution-envelope fields require desktop protocol 1.13.', JSON_RPC_ERROR_CODES.invalidParams);
    }

    switch (request.method) {
      case 'agents/list':
        return this.listAgents(request.params ?? {});
      case 'catalog/inspect':
        return this.listAgents(request.params ?? {});
      case 'runtime/initialize':
        return this.initializeRuntime(request.params ?? {});
      case 'runtime/info':
        return this.runtimeInfo();
      case 'runtime/shutdown':
        await this.close();
        return { shutdown: true };
      case 'settings/update':
        return this.updateSettings(request.params!.settings);
      case 'auth/updateAccessToken':
        this.accessToken = request.params!.accessToken;
        await this.gatewayClient?.reconnect();
        return { updated: true };
      case 'agent/run': {
        const params = request.params!;
        this.validateExecutionSelection(params);
        const fallbackSdk = this.requireSdk();
        const executionId = params.executionId ?? params.runId!;
        const sessionId = params.sessionId ?? randomUUID();
        rejectUnsupportedMedia(params.attachments ?? [], this.negotiatedProtocolVersion);
        const parts = await this.validateAndTranslateAttachments(params.attachments ?? []);
        const selected = await this.selectDesktopRunSdk(fallbackSdk, params.goal, params.attachments ?? [], sessionId);
        const sdk = selected.sdk;
        this.writeRunAgentSelected(executionId, sdk);
        const fileAccess = await this.fileAccessContext(params.attachments ?? [], sdk);
        const preparation = await this.prepareRunTask(sdk, params.goal, params.attachments ?? [], sessionId);
        if (preparation && preparation.decision !== 'complete' && preparation.decision !== 'enhance') {
          if (preparation.decision === 'clarify' && sdk.config.interaction.clarificationMode === 'interactive') {
            const pending = this.pendingTaskPreparation(
              executionId,
              sessionId,
              params,
              sdk,
              parts,
              fileAccess,
              selected.selection,
              [preparation],
            );
            await this.persistPendingTaskPreparation(preparation.preparationRunId, pending);
            const result = taskPreparationClarification(preparation);
            return params.executionId ? executionResult(executionId, 'direct', result) : asJsonValue(result);
          }
          const result = {
            status: 'task_preparation_stopped',
            runId: preparation.preparationRunId,
            decision: preparation.decision,
            message: preparation.reason,
            taskPreparation: preparation,
          };
          return params.executionId ? executionResult(executionId, 'direct', result) : asJsonValue(result);
        }
        const result = await sdk.runRaw(preparation?.preparedObjective ?? params.goal, {
          runId: asRunId(executionId),
          sessionId,
          ...(params.input === undefined ? {} : { input: params.input }),
          ...(parts.length ? { contentParts: parts } : {}),
          ...(fileAccess ? { executionContext: { fileAccess } } : {}),
          ...(params.inferenceTier ? { inferenceTier: params.inferenceTier } : {}),
          ...((preparation || selected.selection) ? {
            metadata: {
              ...(preparation ? taskPreparationMetadata(preparation) : {}),
              ...(selected.selection ? { agentSelection: agentSelectionMetadata(selected.selection) } : {}),
            },
          } : {}),
        });
        this.runSdks.set(executionId, sdk);
        this.runSdks.set(result.runId, sdk);
        return params.executionId ? executionResult(executionId, 'direct', result) : asJsonValue(result);
      }
      case 'agent/chat': {
        const params = request.params!;
        this.validateExecutionSelection(params);
        const executionId = params.executionId ?? params.runId!;
        const attachments = params.executionId ? desktopTranscriptAttachments(params.transcript as DesktopChatMessage[]) : [];
        rejectUnsupportedMedia(attachments, this.negotiatedProtocolVersion);
        const transcript = params.executionId ? await this.translateDesktopTranscript(params.transcript as DesktopChatMessage[]) : params.transcript as ChatMessage[];
        const fileAccess = await this.fileAccessContext(attachments);
        const result = await this.requireSdk().chatRaw(transcript, {
          runId: asRunId(executionId),
          ...(params.chatSessionId ? { sessionId: params.chatSessionId } : {}),
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
          ...(params.inferenceTier ? { inferenceTier: params.inferenceTier } : {}),
          ...(fileAccess ? { executionContext: { fileAccess } } : {}),
        });
        return params.executionId ? executionResult(executionId, 'direct', result) : asJsonValue(result);
      }
      case 'execution/inspect': {
        const id = request.params!.executionId;
        const run = await this.requireSdk().inspect(asRunId(id));
        return asJsonValue({ executionId: id, mode: 'direct', status: run.run?.status ?? 'not_found', finalRunId: run.run?.id, traceTarget: { kind: 'root-run', rootRunId: id } });
      }
      case 'execution/interrupt': {
        const id = request.params!.executionId;
        await (await this.sdkForRun(id)).interrupt(asRunId(id));
        return { executionId: id, interrupted: true };
      }
      case 'execution/resume': {
        const id = request.params!.executionId;
        return asJsonValue(executionResult(id, 'direct', await (await this.sdkForRun(id)).resumeRaw(asRunId(id))));
      }
      case 'run/resume':
        return asJsonValue(await (await this.sdkForRun(request.params!.runId)).resumeRaw(asRunId(request.params!.runId)));
      case 'run/retry':
        return asJsonValue(await (await this.sdkForRun(request.params!.runId)).retryRaw(asRunId(request.params!.runId)));
      case 'run/recover': {
        const params = request.params!;
        const sdk = await this.sdkForRun(params.runId);
        if (params.dryRun) return asJsonValue(await sdk.getRecoveryPlan(asRunId(params.runId)));
        return asJsonValue(await sdk.recoverRaw({ runId: asRunId(params.runId), strategy: params.strategy ?? 'auto' }));
      }
      case 'run/continue': {
        const params = request.params!;
        return asJsonValue(await (await this.sdkForRun(params.runId)).continueRunRaw({
          fromRunId: asRunId(params.runId),
          ...(params.continuationRunId ? { continuationRunId: asRunId(params.continuationRunId) } : {}),
        }));
      }
      case 'run/interrupt':
        await (await this.sdkForRun(request.params!.runId)).interrupt(asRunId(request.params!.runId));
        return { runId: request.params!.runId, interrupted: true };
      case 'run/delete':
        return this.deleteRun(request.params!.runId);
      case 'run/inspect':
        return sanitizeInspection(await this.requireSdk().inspect(asRunId(request.params!.runId)));
      case 'run/replay': {
        const runId = asRunId(request.params!.runId);
        const inspection = await this.requireSdk().inspect(runId);
        return sanitizeInspection({ runId, run: inspection.run, eventCount: inspection.events.length, events: inspection.events });
      }
      case 'run/steer': {
        const params = request.params!;
        await (await this.sdkForRun(params.runId)).steer(asRunId(params.runId), {
          message: params.message,
          ...(params.role ? { role: params.role } : {}),
          ...(params.metadata ? { metadata: params.metadata } : {}),
        });
        return { runId: params.runId, accepted: true };
      }
      case 'interaction/resolveApproval':
        return this.resolveApproval(request.params!.runId, request.params!.approvalId, request.params!.approved);
      case 'interaction/resolveClarification':
        return this.resolveClarification(request.params!.runId, request.params!.answer);
      case 'history/previewDeletion':
        return asJsonValue(await this.requireMaintenanceStore().previewDeletion(request.params!.target));
      case 'history/delete':
        return asJsonValue(await this.requireMaintenanceStore().deleteHistory(request.params!.target));
      case 'agent/createDraft':
        return this.withAgentBuilder(async () => {
          const generatorAgent = request.params!.generatorAgent ?? this.requireSdk().config.agent.id;
          const prepared = await prepareAgentCreate({
            brief: request.params!.brief,
            cwd: this.settingsCwd,
            settingsConfigPath: this.settingsPath,
            generatorAgent,
            id: request.params!.id,
            provider: request.params!.provider,
            model: request.params!.model,
          });
          const preview = await prepareAgentConfigSave({
            agent: prepared.agent,
            cwd: this.settingsCwd,
            settingsConfigPath: this.settingsPath,
            generatorAgent,
          });
          return asJsonValue({ ...prepared, ...preview });
        });
      case 'agent/validateConfig':
        return this.withAgentBuilder(async () => asJsonValue(await prepareAgentConfigSave({
          agent: request.params!.agent,
          cwd: this.settingsCwd,
          settingsConfigPath: this.settingsPath,
          generatorAgent: request.params!.generatorAgent ?? this.requireSdk().config.agent.id,
          targetPath: request.params!.targetPath,
        })));
      case 'agent/saveConfig':
        return this.withAgentBuilder(async () => asJsonValue(await saveAgentConfig({
          agent: request.params!.agent,
          cwd: this.settingsCwd,
          settingsConfigPath: this.settingsPath,
          generatorAgent: request.params!.generatorAgent ?? this.requireSdk().config.agent.id,
          overwrite: request.params!.overwrite ?? false,
          targetPath: request.params!.targetPath,
          expectedPath: request.params!.expectedPath,
          expectedTargetFingerprint: request.params!.expectedTargetFingerprint,
        })));
      case 'agent/readConfig':
        return this.withAgentBuilder(async () => asJsonValue(await readAgentProfile({
          ...request.params!,
          cwd: this.settingsCwd,
          settingsConfigPath: this.settingsPath,
          generatorAgent: request.params!.generatorAgent ?? this.requireSdk().config.agent.id,
        })));
      case 'agent/archiveConfig':
        return this.withAgentBuilder(async () => asJsonValue(await archiveAgentProfile({
          ...request.params!,
          cwd: this.settingsCwd,
          settingsConfigPath: this.settingsPath,
          generatorAgent: request.params!.generatorAgent ?? this.requireSdk().config.agent.id,
        })));
      case 'agent/restoreConfig':
        return this.withAgentBuilder(async () => asJsonValue(await restoreAgentProfile({
          ...request.params!,
          cwd: this.settingsCwd,
          settingsConfigPath: this.settingsPath,
          generatorAgent: request.params!.generatorAgent ?? this.requireSdk().config.agent.id,
        })));
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
    this.sdkOptions = undefined;
    const selectedSdks = [...this.selectedAgentSdks.values()];
    this.selectedAgentSdks.clear();
    this.runSdks.clear();
    await Promise.all(selectedSdks.map((selected) => selected.close()));
    await sdk?.close();
    this.gatewayClient?.close();
    this.gatewayClient = undefined;
  }

  private async withAgentBuilder<T>(operation: () => Promise<T>): Promise<T> {
    this.requireSdk();
    if (this.agentBuilderInProgress) {
      throw new DesktopProtocolError(
        'COMMAND_REJECTED',
        'Another agent builder operation is already in progress.',
        JSON_RPC_ERROR_CODES.commandRejected,
      );
    }
    this.agentBuilderInProgress = true;
    try {
      return await operation();
    } finally {
      this.agentBuilderInProgress = false;
    }
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
        methods: DESKTOP_RPC_METHODS.filter((method) => {
          if (this.negotiatedProtocolVersion === '1.10' && method === 'auth/updateAccessToken') return false;
          if (this.negotiatedProtocolVersion === '1.10' || this.negotiatedProtocolVersion === '1.11') if (method.startsWith('history/') || method === 'settings/update') return false;
          if (!['1.13', '1.14', '1.15', '1.16', '1.17', '1.18', '1.19'].includes(this.negotiatedProtocolVersion) && method.startsWith('execution/')) return false;
          if (!['1.14', '1.15', '1.16', '1.17', '1.18', '1.19'].includes(this.negotiatedProtocolVersion) && method === 'catalog/inspect') return false;
          if (!['1.15', '1.16', '1.17', '1.18', '1.19'].includes(this.negotiatedProtocolVersion) && ['agent/createDraft', 'agent/validateConfig', 'agent/saveConfig'].includes(method)) return false;
          if (!['1.16', '1.17', '1.18', '1.19'].includes(this.negotiatedProtocolVersion) && ['agent/readConfig', 'agent/archiveConfig', 'agent/restoreConfig'].includes(method)) return false;
          if (!['1.17', '1.18', '1.19'].includes(this.negotiatedProtocolVersion) && method === 'run/delete') return false;
          if (!['1.18', '1.19'].includes(this.negotiatedProtocolVersion) && method === 'agents/list') return false;
          return true;
        }),
        notifications: ['runtime/ready', 'agent/event', 'cli/output'],
        cli: {
          commands: [...ADAPTIVE_AGENT_CLI_COMMANDS],
          execute: this.cliExecutor !== undefined,
          transport: 'child-process',
          output: 'streamed-notifications',
        },
        ...(['1.13', '1.14', '1.15', '1.16', '1.17', '1.18', '1.19'].includes(this.negotiatedProtocolVersion) ? { attachments: attachmentCapabilities(false, this.negotiatedProtocolVersion, 'Initialize the runtime with managedAttachmentRoot.') } : {}),
      },
    };
  }

  private async listAgents(params: CatalogInspectParams): Promise<JsonValue> {
    if (this.sdk || this.sdkInitialization) {
      throw new DesktopProtocolError('ALREADY_INITIALIZED', 'Agent discovery is only available before runtime initialization.', JSON_RPC_ERROR_CODES.alreadyInitialized);
    }
    return asJsonValue(await discoverAgentSdkAgents({
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.settingsConfigPath ? { settingsConfigPath: params.settingsConfigPath } : {}),
    }));
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
        resolvedConfiguration: asJsonValue(safeResolvedConfiguration(this.sdk.config, this.sdk.agentPath)),
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

    if (params.agentSelection) {
      const discovery = await discoverAgentSdkAgents({
        ...(params.cwd ? { cwd: params.cwd } : {}),
        ...(params.settingsConfigPath ? { settingsConfigPath: params.settingsConfigPath } : {}),
      });
      const selected = discovery.agents.find((agent) => agent.configPath === params.agentSelection!.configPath);
      if (!selected
        || selected.validationState !== 'valid'
        || selected.id !== params.agentSelection.id
        || selected.configurationFingerprint !== params.agentSelection.configurationFingerprint) {
        throw agentSelectionMismatch(params.agentSelection, selected);
      }
    }

    const inferenceMode = params.inferenceMode ?? (params.profileRef?.source === 'server' ? 'gateway' : undefined);
    if (params.managedAttachmentRoot) {
      const requestedRoot = params.managedAttachmentRoot;
      const canonicalRoot = await realpath(requestedRoot).catch(() => { throw new DesktopProtocolError('ATTACHMENTS_UNAVAILABLE', 'managedAttachmentRoot must be an existing canonical directory.', JSON_RPC_ERROR_CODES.invalidParams); });
      if (!isAbsolute(requestedRoot) || resolve(requestedRoot) !== requestedRoot || canonicalRoot !== requestedRoot || !(await stat(canonicalRoot)).isDirectory()) {
        throw new DesktopProtocolError('ATTACHMENTS_UNAVAILABLE', 'managedAttachmentRoot must be an existing canonical directory.', JSON_RPC_ERROR_CODES.invalidParams);
      }
      this.managedAttachmentRoot = canonicalRoot;
    }
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
      ...(params.agentSelection || params.agentConfigPath ? {
        agent: {
          mode: 'fixed',
          ...(params.agentSelection ? {
            id: params.agentSelection.id,
            configPath: params.agentSelection.configPath,
          } : {}),
        },
      } : {}),
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
      ...(params.agentSelection ? { agentConfigPath: params.agentSelection.configPath } : params.agentConfigPath ? { agentConfigPath: params.agentConfigPath } : {}),
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
      this.settingsCwd = params.cwd ?? process.cwd();
      const runtimeTarget = await resolveRuntimeTarget({
        cwd: this.settingsCwd,
        ...(params.settingsConfigPath ? { settingsPath: params.settingsConfigPath } : {}),
      });
      this.settingsPath = runtimeTarget.settingsPath ?? resolve(this.settingsCwd, 'agent.settings.json');
      const sdk = await initialization;
      if (params.agentSelection) {
        const actual = { id: sdk.config.agent.id, configPath: sdk.agentPath, configurationFingerprint: agentConfigurationFingerprint(sdk.config) };
        if (actual.id !== params.agentSelection.id
          || actual.configPath !== params.agentSelection.configPath
          || actual.configurationFingerprint !== params.agentSelection.configurationFingerprint) {
          await sdk.close();
          throw agentSelectionMismatch(params.agentSelection, actual);
        }
      }
      if (params.configurationDriven) {
        try {
          validateRestrictedDesktopConfiguration(sdk.config);
        } catch (error) {
          await sdk.close();
          throw error;
        }
      }
      this.sdk = sdk;
      this.sdkOptions = options;
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
        resolvedConfiguration: asJsonValue(safeResolvedConfiguration(sdk.config, sdk.agentPath)),
        ...(params.profileRef ? { profileRef: asJsonValue(params.profileRef) } : {}),
        connections: {
          sqlite: sdk.config.runtime.mode === 'sqlite' ? 'connected' : 'not_configured',
          gateway: gatewayClient?.connectionState ?? 'not_configured',
        },
        attachments: attachmentCapabilities(Boolean(this.managedAttachmentRoot), this.negotiatedProtocolVersion, this.managedAttachmentRoot ? undefined : 'managedAttachmentRoot was not configured.'),
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

  private async updateSettings(settings: EditableDesktopSettings): Promise<JsonValue> {
    if (!this.configurationDriven || !this.sdk || !this.settingsPath) {
      throw new DesktopProtocolError(
        'COMMAND_REJECTED',
        'Settings can only be updated after configuration-driven runtime initialization.',
        JSON_RPC_ERROR_CODES.commandRejected,
      );
    }
    if (this.settingsUpdateInProgress) {
      throw new DesktopProtocolError(
        'COMMAND_REJECTED',
        'A settings update is already in progress.',
        JSON_RPC_ERROR_CODES.commandRejected,
      );
    }
    this.settingsUpdateInProgress = true;
    try {
      const current = await readSettingsFile(this.settingsPath);
      const updated = updateDesktopSettings(current, settings);
      const inspection = await inspectAgentSdkResolution({ cwd: this.settingsCwd, settingsConfig: updated });
      validateRestrictedDesktopConfiguration(inspection.config);
      await atomicWriteJson(this.settingsPath, updated);
      return { saved: true };
    } finally {
      this.settingsUpdateInProgress = false;
    }
  }

  private async selectDesktopRunSdk(
    fallbackSdk: AgentSdk,
    originalObjective: string,
    attachments: DesktopAttachmentInput[],
    sessionId: string,
  ): Promise<{ sdk: AgentSdk; selection?: AgentSelectionResult }> {
    if (fallbackSdk.config.settings?.agent?.mode !== 'auto') return { sdk: fallbackSdk };
    const configuredAgent = fallbackSdk.config.settings.taskPreparation?.agent;
    if (!configuredAgent) {
      throw new DesktopProtocolError(
        'INVALID_CONFIGURATION',
        'Auto agent selection requires settings.taskPreparation.agent.',
        JSON_RPC_ERROR_CODES.commandFailed,
      );
    }
    const options = this.sdkOptions;
    if (!options) throw new DesktopProtocolError('NOT_INITIALIZED', 'The runtime configuration is unavailable.', JSON_RPC_ERROR_CODES.notInitialized);
    const discovery = await discoverAgentSdkAgents(options);
    const preparationSdk = await AgentSdk.create({
      ...options,
      cwd: this.settingsCwd,
      agentConfigPath: configuredAgent,
      settingsConfigPath: undefined,
      settingsConfig: { ...fallbackSdk.config.settings, agent: undefined },
      settingsOverrides: undefined,
      model: undefined,
      runtime: fallbackSdk.created.runtime,
      eventListener: undefined,
    });
    try {
      const paths = (kind: DesktopAttachmentInput['kind']) => attachments
        .filter((attachment) => attachment.kind === kind)
        .map((attachment) => attachment.stagedRelativePath);
      const selection = await selectAgentProfile(preparationSdk, {
        originalObjective,
        candidates: discovery.agents,
        workspaceRoot: fallbackSdk.config.workspaceRoot,
        attachments: { images: paths('image'), files: paths('file'), audio: paths('audio') },
        sessionId,
      });
      const selected = discovery.agents.find((candidate) =>
        candidate.id === selection.selectedAgentId
        && candidate.validationState === 'valid'
        && !candidate.archived,
      );
      if (!selected) throw new Error(`Selected agent profile "${selection.selectedAgentId}" is no longer available.`);
      if (selected.configPath === fallbackSdk.agentPath) return { sdk: fallbackSdk, selection };
      return { sdk: await this.sdkForSelectedAgent(fallbackSdk, selected), selection };
    } finally {
      await preparationSdk.close();
    }
  }

  private async prepareRunTask(
    targetSdk: AgentSdk,
    originalObjective: string,
    attachments: DesktopAttachmentInput[],
    sessionId: string,
    clarificationAnswers?: Record<string, string>,
    attachmentSummary?: PendingDesktopTaskPreparation['attachments'],
  ): Promise<TaskPreparationResult | undefined> {
    const mode = targetSdk.config.settings?.taskPreparation?.mode ?? 'never';
    if (mode === 'never') return undefined;
    const configuredAgent = targetSdk.config.settings?.taskPreparation?.agent;
    if (!configuredAgent) {
      throw new DesktopProtocolError(
        'INVALID_CONFIGURATION',
        `Task preparation mode "${mode}" requires settings.taskPreparation.agent.`,
        JSON_RPC_ERROR_CODES.commandFailed,
      );
    }
    const options = this.sdkOptions;
    if (!options) {
      throw new DesktopProtocolError('NOT_INITIALIZED', 'The runtime configuration is unavailable.', JSON_RPC_ERROR_CODES.notInitialized);
    }
    const preparationSdk = await AgentSdk.create({
      ...options,
      cwd: this.settingsCwd,
      agentConfigPath: configuredAgent,
      settingsConfigPath: undefined,
      settingsConfig: { ...targetSdk.config.settings, agent: undefined },
      settingsOverrides: undefined,
      model: undefined,
      runtime: targetSdk.created.runtime,
      eventListener: undefined,
    });
    try {
      const paths = (kind: DesktopAttachmentInput['kind']) => attachments
        .filter((attachment) => attachment.kind === kind)
        .map((attachment) => attachment.stagedRelativePath);
      return await prepareTask(preparationSdk, {
        mode,
        originalObjective,
        targetAgent: targetSdk.config.agent,
        workspaceRoot: targetSdk.config.workspaceRoot,
        attachments: attachmentSummary ?? { images: paths('image'), files: paths('file'), audio: paths('audio') },
        sessionId,
        ...(clarificationAnswers ? { clarificationAnswers } : {}),
      });
    } finally {
      await preparationSdk.close();
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

  private writeRunAgentSelected(runId: string, sdk: AgentSdk): void {
    if (this.negotiatedProtocolVersion !== '1.19') return;
    this.write({
      jsonrpc: '2.0',
      method: 'agent/event',
      params: {
        schemaVersion: 1,
        type: 'run.agent_selected',
        runId,
        payload: {
          agentId: sdk.config.agent.id,
          agentName: sdk.config.agent.name,
        },
      },
    });
  }

  private async resolveApproval(runId: string, approvalId: string, approved: boolean): Promise<JsonValue> {
    const sdk = await this.sdkForRun(runId);
    await sdk.agent.resolveApproval(asRunId(runId), approvalId, approved);
    return { runId, approvalId, approved, resolved: true };
  }

  private pendingTaskPreparation(
    executionId: string,
    sessionId: string,
    params: RunParams,
    sdk: AgentSdk,
    contentParts: ModelContentPart[],
    fileAccess: FileAccessExecutionContext | undefined,
    selection: AgentSelectionResult | undefined,
    preparations: TaskPreparationResult[],
  ): PendingDesktopTaskPreparation {
    const paths = (kind: DesktopAttachmentInput['kind']) => (params.attachments ?? [])
      .filter((attachment) => attachment.kind === kind)
      .map((attachment) => attachment.stagedRelativePath);
    return {
      schemaVersion: 1,
      executionId,
      sessionId,
      originalObjective: params.goal,
      targetAgent: {
        id: sdk.config.agent.id,
        configPath: sdk.agentPath,
        configurationFingerprint: agentConfigurationFingerprint(sdk.config),
      },
      attachments: { images: paths('image'), files: paths('file'), audio: paths('audio') },
      contentParts: structuredClone(contentParts),
      ...(params.input === undefined ? {} : { input: structuredClone(params.input) }),
      ...(fileAccess ? { fileAccess: structuredClone(fileAccess) } : {}),
      ...(params.inferenceTier ? { inferenceTier: params.inferenceTier } : {}),
      ...(selection ? { agentSelection: agentSelectionMetadata(selection) } : {}),
      preparations: structuredClone(preparations),
    };
  }

  private async persistPendingTaskPreparation(runId: string, pending: PendingDesktopTaskPreparation): Promise<void> {
    const store = this.requireSdk().created.runtime.runStore;
    const run = await store.getRun(asRunId(runId));
    if (!run) throw new Error(`Task preparation run ${runId} does not exist.`);
    await store.updateRun(run.id, {
      metadata: { ...run.metadata, desktopTaskPreparation: pending as unknown as JsonValue },
    }, run.version);
  }

  private async clearPendingTaskPreparation(runId: string): Promise<void> {
    const store = this.requireSdk().created.runtime.runStore;
    const run = await store.getRun(asRunId(runId));
    if (!run?.metadata?.desktopTaskPreparation) return;
    const { desktopTaskPreparation: _pending, ...metadata } = run.metadata;
    await store.updateRun(run.id, { metadata }, run.version);
  }

  private async resolveClarification(runId: string, answer: string): Promise<JsonValue> {
    const fallback = this.requireSdk();
    const run = await fallback.created.runtime.runStore.getRun(asRunId(runId));
    const pending = readPendingTaskPreparation(run?.metadata?.desktopTaskPreparation);
    if (!run || !pending) {
      return asJsonValue(await (await this.sdkForRun(runId)).agent.resolveClarification(asRunId(runId), answer));
    }
    const trimmedAnswer = answer.trim();
    if (!trimmedAnswer) throw new Error('Clarification message must not be empty');
    const targetSdk = await this.sdkForPendingTaskPreparation(pending);
    const current = restoreTaskPreparation(run, {
      targetAgentId: pending.targetAgent.id,
      workspaceRoot: targetSdk.config.workspaceRoot,
      attachments: pending.attachments,
    });
    const clarificationAnswers = Object.fromEntries(
      current.clarificationQuestions.map((question) => [question, trimmedAnswer]),
    );
    const preparation = await this.prepareRunTask(
      targetSdk,
      pending.originalObjective,
      [],
      pending.sessionId,
      clarificationAnswers,
      pending.attachments,
    );
    if (!preparation) throw new Error('Task preparation is no longer enabled for the selected agent.');
    const preparations = [...pending.preparations, preparation];
    if (preparation.decision === 'clarify') {
      const next = { ...pending, preparations };
      await this.persistPendingTaskPreparation(preparation.preparationRunId, next);
      await this.clearPendingTaskPreparation(runId).catch(() => undefined);
      return asJsonValue(taskPreparationClarification(preparation));
    }
    if (preparation.decision === 'invalid') {
      await this.clearPendingTaskPreparation(runId).catch(() => undefined);
      return asJsonValue({
        status: 'task_preparation_stopped',
        runId: preparation.preparationRunId,
        decision: preparation.decision,
        message: preparation.reason,
        taskPreparation: preparation,
      });
    }
    const result = await targetSdk.runRaw(preparation.preparedObjective, {
      runId: asRunId(pending.executionId),
      sessionId: pending.sessionId,
      ...(pending.input === undefined ? {} : { input: pending.input }),
      ...(pending.contentParts.length ? { contentParts: pending.contentParts } : {}),
      ...(pending.fileAccess ? {
        executionContext: { fileAccess: pending.fileAccess } as unknown as NonNullable<AgentSdkRunOptions['executionContext']>,
      } : {}),
      ...(pending.inferenceTier ? { inferenceTier: pending.inferenceTier } : {}),
      metadata: {
        ...taskPreparationMetadata(preparations),
        ...(pending.agentSelection ? { agentSelection: pending.agentSelection } : {}),
      },
    });
    this.runSdks.set(pending.executionId, targetSdk);
    this.runSdks.set(result.runId, targetSdk);
    await this.clearPendingTaskPreparation(runId).catch(() => undefined);
    return asJsonValue(result);
  }

  private async sdkForPendingTaskPreparation(pending: PendingDesktopTaskPreparation): Promise<AgentSdk> {
    const fallback = this.requireSdk();
    const expected = pending.targetAgent;
    if (fallback.config.agent.id === expected.id
      && fallback.agentPath === expected.configPath
      && agentConfigurationFingerprint(fallback.config) === expected.configurationFingerprint) {
      return fallback;
    }
    const options = this.sdkOptions;
    if (!options) throw new DesktopProtocolError('NOT_INITIALIZED', 'The runtime configuration is unavailable.', JSON_RPC_ERROR_CODES.notInitialized);
    const discovery = await discoverAgentSdkAgents(options);
    const selected = discovery.agents.find((candidate) =>
      candidate.id === expected.id
      && candidate.configPath === expected.configPath
      && candidate.configurationFingerprint === expected.configurationFingerprint
      && candidate.validationState === 'valid',
    );
    if (!selected) {
      throw new DesktopProtocolError(
        'AGENT_SELECTION_MISMATCH',
        'The exact agent profile selected before task clarification is no longer available.',
        JSON_RPC_ERROR_CODES.commandRejected,
      );
    }
    return this.sdkForSelectedAgent(fallback, selected);
  }

  private requireMaintenanceStore() {
    const store = this.requireSdk().created.runtime.maintenanceStore;
    if (!store) {
      throw new DesktopProtocolError(
        'COMMAND_REJECTED',
        'History deletion requires a persistent runtime maintenance store.',
        JSON_RPC_ERROR_CODES.commandRejected,
      );
    }
    return store;
  }

  private async deleteRun(runId: string): Promise<JsonValue> {
    const sdk = this.requireSdk();
    const store = sdk.created.runtime.maintenanceStore;
    if (!store) {
      throw new DesktopProtocolError(
        'UNSUPPORTED_OPERATION',
        `Permanent run deletion is unsupported in ${sdk.config.runtime.mode} runtime mode.`,
        JSON_RPC_ERROR_CODES.commandRejected,
      );
    }
    try {
      return asJsonValue(await store.deleteRun(asRunId(runId)));
    } catch (error) {
      if (error instanceof RuntimeDeletionError) {
        throw new DesktopProtocolError(error.code, error.message, JSON_RPC_ERROR_CODES.commandRejected);
      }
      throw error;
    }
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
    if (!parsed.help && (parsed.imagePaths.length > 0 || parsed.audioPaths.length > 0)) {
      throw new DesktopProtocolError(
        'COMMAND_REJECTED',
        'cli/execute image and audio inputs are unavailable; use managed desktop attachments.',
        JSON_RPC_ERROR_CODES.commandRejected,
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
    if (parsed.command === 'context' && parsed.cwd === undefined && this.sdk) {
      argv.push('--cwd', this.sdk.config.workspaceRoot);
    }
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

  private async sdkForRun(runId: string): Promise<AgentSdk> {
    const direct = this.runSdks.get(runId);
    if (direct) return direct;
    const fallback = this.requireSdk();
    const runStore = fallback.created?.runtime?.runStore;
    if (!runStore) return fallback;
    const run = await runStore.getRun(asRunId(runId));
    if (!run) return fallback;
    const rootSdk = this.runSdks.get(run.rootRunId);
    if (rootSdk) return rootSdk;
    const agentConfigPath = run.metadata?.agentConfigPath;
    const fingerprint = run.metadata?.agentConfigurationFingerprint;
    if (typeof agentConfigPath !== 'string' || typeof fingerprint !== 'string' || agentConfigPath === fallback.agentPath) {
      return fallback;
    }
    const options = this.sdkOptions;
    if (!options) return fallback;
    const discovery = await discoverAgentSdkAgents(options);
    const selected = discovery.agents.find((candidate) =>
      candidate.configPath === agentConfigPath
      && candidate.configurationFingerprint === fingerprint
      && candidate.validationState === 'valid',
    );
    if (!selected) {
      throw new DesktopProtocolError(
        'AGENT_SELECTION_MISMATCH',
        'The exact agent profile used by this run is no longer available.',
        JSON_RPC_ERROR_CODES.commandRejected,
      );
    }
    const sdk = await this.sdkForSelectedAgent(fallback, selected);
    this.runSdks.set(run.rootRunId, sdk);
    return sdk;
  }

  private async sdkForSelectedAgent(fallbackSdk: AgentSdk, selected: AgentSdkCatalogAgent): Promise<AgentSdk> {
    const cacheKey = `${selected.configPath}:${selected.configurationFingerprint}`;
    const cached = this.selectedAgentSdks.get(cacheKey);
    if (cached) return cached;
    const options = this.sdkOptions;
    if (!options) throw new DesktopProtocolError('NOT_INITIALIZED', 'The runtime configuration is unavailable.', JSON_RPC_ERROR_CODES.notInitialized);
    const sdk = await AgentSdk.create({
      ...options,
      cwd: this.settingsCwd,
      agentConfigPath: selected.configPath,
      settingsConfigPath: undefined,
      settingsConfig: {
        ...fallbackSdk.config.settings,
        agent: { mode: 'fixed', id: selected.id, configPath: selected.configPath },
      },
      settingsOverrides: undefined,
      runtime: fallbackSdk.created.runtime,
      eventListener: (event: AgentEvent) => this.writeAgentEvent(event),
    });
    this.selectedAgentSdks.set(cacheKey, sdk);
    return sdk;
  }

  private async validateAndTranslateAttachments(inputs: DesktopAttachmentInput[]): Promise<ModelContentPart[]> {
    if (!inputs.length) return [];
    if (!this.managedAttachmentRoot) throw new DesktopProtocolError('ATTACHMENTS_UNAVAILABLE', 'managedAttachmentRoot is not configured.', JSON_RPC_ERROR_CODES.commandRejected);
    const managedRoot = await realpath(this.managedAttachmentRoot).catch(() => { throw new DesktopProtocolError('ATTACHMENTS_UNAVAILABLE', 'managedAttachmentRoot is unavailable.', JSON_RPC_ERROR_CODES.commandRejected); });
    return Promise.all(inputs.map(async (input) => {
      if (isAbsolute(input.stagedRelativePath) || input.stagedRelativePath.split(/[\\/]/).includes('..')) throw attachmentError('ATTACHMENT_PATH_INVALID', input.attachmentId);
      const components = input.stagedRelativePath.split(/[\\/]/);
      if (components.length !== 2 || components[0] !== input.attachmentId || components[1] !== input.name) throw attachmentError('ATTACHMENT_PATH_INVALID', input.attachmentId);
      const lexical = resolve(managedRoot, input.stagedRelativePath);
      const canonical = await realpath(lexical).catch(() => { throw attachmentError('ATTACHMENT_NOT_FOUND', input.attachmentId); });
      const rel = relative(managedRoot, canonical);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw attachmentError('ATTACHMENT_PATH_INVALID', input.attachmentId);
      const info = await stat(canonical);
      if (!info.isFile() || info.size !== input.sizeBytes) throw attachmentError('ATTACHMENT_CHANGED', input.attachmentId);
      const hash = createHash('sha256').update(await readFile(canonical)).digest('hex');
      if (hash !== input.sha256) throw attachmentError('ATTACHMENT_CHANGED', input.attachmentId);
      if (input.kind === 'image') return { type: 'image', image: { path: canonical, name: input.name, ...(input.mimeType ? { mimeType: input.mimeType } : {}) } };
      if (input.kind === 'audio') return { type: 'audio', audio: { source: { kind: 'path', path: canonical }, name: input.name, ...(input.mimeType ? { mimeType: input.mimeType } : {}), ...(input.audioFormat ? { format: input.audioFormat } : {}) } };
      return { type: 'file', file: { source: { kind: 'path', path: canonical }, name: input.name, ...(input.mimeType ? { mimeType: input.mimeType } : {}) } };
    }));
  }

  private async translateDesktopTranscript(messages: DesktopChatMessage[]): Promise<ChatMessage[]> {
    return Promise.all(messages.map(async (message) => ({ role: message.role, content: message.attachments?.length ? [{ type: 'text', text: message.text }, ...await this.validateAndTranslateAttachments(message.attachments)] : message.text })));
  }

  private async fileAccessContext(inputs: DesktopAttachmentInput[], sdk = this.requireSdk()) {
    if (!inputs.length || !this.managedAttachmentRoot) return undefined;
    const managedRoot = await realpath(this.managedAttachmentRoot);
    const files = await Promise.all(inputs.map(async (input) => ({
      path: await realpath(resolve(managedRoot, input.stagedRelativePath)),
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
    })));
    return {
      version: 1 as const,
      workspaceRoot: sdk.config.workspaceRoot,
      attachmentRoots: [...new Set(inputs.map((input) => resolve(managedRoot, input.attachmentId)))],
      files,
    };
  }
}

function desktopTranscriptAttachments(messages: DesktopChatMessage[]): DesktopAttachmentInput[] { return messages.flatMap((message) => message.attachments ?? []); }
function attachmentError(code: string, id: string): DesktopProtocolError { return new DesktopProtocolError(code, `Attachment ${id} failed managed-file validation.`, JSON_RPC_ERROR_CODES.invalidParams); }
function attachmentCapabilities(enabled: boolean, protocolVersion: DesktopProtocolVersion, reason?: string): JsonValue {
  const supportsMedia = ['1.17', '1.18', '1.19'].includes(protocolVersion);
  return {
    enabled,
    maxFileBytes: 10 * 1024 * 1024,
    maxAttachmentCount: 8,
    maxSubmissionBytes: 40 * 1024 * 1024,
    acceptedKinds: supportsMedia ? ['file', 'image', 'audio'] : ['file'],
    supportedImageMimeTypes: supportsMedia ? ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] : [],
    supportedAudioMimeTypes: supportsMedia ? ['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/flac', 'audio/mp4', 'audio/ogg', 'audio/aac', 'audio/aiff'] : [],
    supportedAudioFormats: supportsMedia ? ['wav', 'mp3', 'flac', 'm4a', 'ogg', 'aac', 'aiff', 'pcm16', 'pcm24'] : [],
    supportedGenericMimeTypes: ['application/octet-stream', 'application/pdf', 'text/plain', 'application/json'],
    routing: { taskGeneric: 'direct', chatGeneric: 'direct', ...(supportsMedia ? { taskImage: 'direct', taskAudio: 'direct', chatImage: 'direct', chatAudio: 'direct' } : {}) },
    ...(reason ? { reason } : {}),
  };
}
function rejectUnsupportedMedia(inputs: DesktopAttachmentInput[], protocolVersion: DesktopProtocolVersion): void {
  if (!['1.17', '1.18', '1.19'].includes(protocolVersion) && inputs.some((input) => input.kind !== 'file')) throw new DesktopProtocolError('UNSUPPORTED_ATTACHMENT_KIND', 'Managed image and audio attachments require desktop protocol 1.17.', JSON_RPC_ERROR_CODES.commandRejected);
}
function executionResult(executionId: string, mode: 'direct' | 'catalog', result: any, stages?: any[]): JsonValue { return asJsonValue({ executionId, mode, status: result.status, finalRunId: result.runId, traceTarget: mode === 'direct' ? { kind: 'root-run', rootRunId: executionId } : { kind: 'session', sessionId: executionId }, ...(stages ? { stages } : {}), result }); }

function agentSelectionMismatch(expected: RuntimeInitializeParams['agentSelection'], actual: unknown): DesktopProtocolError {
  return new DesktopProtocolError(
    'AGENT_SELECTION_MISMATCH',
    'The selected agent no longer matches its catalog descriptor (id, configPath, or configurationFingerprint). Inspect the catalog again.',
    JSON_RPC_ERROR_CODES.invalidParams,
    { expected: asJsonValue(expected), ...(actual ? { actual: asJsonValue(actual) } : {}) },
  );
}
function hasV113Fields(request: DesktopRpcRequest): boolean {
  const visit = (value: unknown): boolean => Array.isArray(value)
    ? value.some(visit)
    : Boolean(value && typeof value === 'object' && Object.entries(value).some(([key, nested]) => ['executionId', 'attachments', 'chatSessionId', 'managedAttachmentRoot'].includes(key) || visit(nested)));
  return visit(request.params);
}

function sanitizeInspection(inspection: unknown): JsonValue {
  const value = asJsonValue(inspection);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const run = value.run;
  if (!run || typeof run !== 'object' || Array.isArray(run)) return value;
  const executionContext = run.executionContext;
  const fileAccess = executionContext && typeof executionContext === 'object' && !Array.isArray(executionContext)
    ? executionContext.fileAccess
    : undefined;
  const roots = fileAccess && typeof fileAccess === 'object' && !Array.isArray(fileAccess) && Array.isArray(fileAccess.attachmentRoots)
    ? fileAccess.attachmentRoots.filter((root): root is string => typeof root === 'string')
    : [];
  redactStrings(value, roots);
  const sanitizedExecutionContext = run.executionContext;
  if (sanitizedExecutionContext && typeof sanitizedExecutionContext === 'object' && !Array.isArray(sanitizedExecutionContext)) {
    delete sanitizedExecutionContext.fileAccess;
  }
  return value;
}

function redactStrings(value: JsonValue, roots: readonly string[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      if (typeof item === 'string') value[index] = redactRootStrings(item, roots);
      else redactStrings(item, roots);
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') value[key] = redactRootStrings(item, roots);
    else redactStrings(item, roots);
  }
}

function redactRootStrings(value: string, roots: readonly string[]): string {
  return roots.reduce((text, root) => text.replaceAll(root, '[MANAGED_ATTACHMENT]'), value);
}

export function updateDesktopSettings(
  current: AgentSettingsFile,
  settings: EditableDesktopSettings,
): AgentSettingsFile {
  return {
    ...current,
    agent: {
      ...current.agent,
      ...(settings.agent.mode ? { mode: settings.agent.mode } : {}),
      ...(settings.agent.configPath?.trim() ? { configPath: settings.agent.configPath.trim() } : { configPath: undefined }),
      id: settings.agent.id.trim(),
    },
    inference: { ...current.inference, ...settings.inference },
    workspace: {
      ...current.workspace,
      overrideRoot: settings.workspace.root.trim(),
      overrideShellCwd: settings.workspace.shellCwd.trim(),
    },
    interaction: { ...current.interaction, ...settings.interaction },
    ...(settings.taskPreparation ? {
      taskPreparation: { ...current.taskPreparation, mode: settings.taskPreparation.mode },
    } : {}),
  };
}

export function safeResolvedConfiguration(config: ResolvedAgentSdkConfig, agentPath?: string): SafeResolvedConfiguration {
  return {
    agent: {
      id: config.agent.id,
      ...(agentPath ? { configPath: agentPath } : {}),
      name: config.agent.name,
      configurationFingerprint: agentConfigurationFingerprint(config),
      ...(config.agent.description ? { description: config.agent.description } : {}),
      defaultInvocationMode: config.agent.defaultInvocationMode,
      selectionMode: config.settings?.agent?.mode ?? 'fixed',
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
    taskPreparation: { mode: config.settings?.taskPreparation?.mode ?? 'never' },
  };
}

function taskPreparationMetadata(value: TaskPreparationResult | TaskPreparationResult[]): JsonObject {
  const results = Array.isArray(value) ? value : [value];
  const result = results.at(-1)!;
  return {
    taskPreparation: {
      schemaVersion: 1,
      application: 'inline',
      originalObjective: result.originalObjective,
      title: result.title,
      name: result.name,
      preparedObjective: result.preparedObjective,
      decision: result.decision,
      assumptions: result.assumptions,
      clarificationQuestions: result.clarificationQuestions,
      reason: result.reason,
      preparationAgentId: result.preparationAgentId,
      preparationRunId: result.preparationRunId,
      preparationRunIds: results.map((entry) => entry.preparationRunId),
      runs: results.map((entry) => ({
        originalObjective: entry.originalObjective,
        title: entry.title,
        name: entry.name,
        decision: entry.decision,
        preparedObjective: entry.preparedObjective,
        assumptions: entry.assumptions,
        clarificationQuestions: entry.clarificationQuestions,
        reason: entry.reason,
        preparationAgentId: entry.preparationAgentId,
        preparationRunId: entry.preparationRunId,
      })),
    },
  };
}

function taskPreparationClarification(result: TaskPreparationResult) {
  const multiple = result.clarificationQuestions.length > 1;
  return {
    status: 'clarification_requested' as const,
    runId: result.preparationRunId,
    message: multiple
      ? `Task preparation needs clarification:\n${result.clarificationQuestions.map((question, index) => `${index + 1}. ${question}`).join('\n')}\n\nProvide one free-form answer covering all questions.`
      : result.clarificationQuestions[0]!,
    suggestedQuestions: result.clarificationQuestions,
  };
}

function readPendingTaskPreparation(value: JsonValue | undefined): PendingDesktopTaskPreparation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const pending = value as unknown as PendingDesktopTaskPreparation;
  if (pending.schemaVersion !== 1
    || typeof pending.executionId !== 'string'
    || typeof pending.sessionId !== 'string'
    || typeof pending.originalObjective !== 'string'
    || !pending.targetAgent
    || typeof pending.targetAgent.id !== 'string'
    || typeof pending.targetAgent.configPath !== 'string'
    || typeof pending.targetAgent.configurationFingerprint !== 'string'
    || !pending.attachments
    || !Array.isArray(pending.attachments.images)
    || !Array.isArray(pending.attachments.files)
    || !Array.isArray(pending.attachments.audio)
    || !Array.isArray(pending.contentParts)
    || !Array.isArray(pending.preparations)) {
    throw new Error('Pending desktop task preparation metadata is invalid.');
  }
  return pending;
}

function agentSelectionMetadata(result: AgentSelectionResult): JsonObject {
  return {
    mode: 'auto',
    selectedAgentId: result.selectedAgentId,
    reason: result.reason,
    selectionAgentId: result.selectionAgentId,
    selectionRunId: result.selectionRunId,
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
  if (config.runtime.mode !== 'sqlite') {
    errors.push(`runtime.mode must be "sqlite" (resolved: "${config.runtime.mode}")`);
  }
  if (config.runtime.mode === 'sqlite' && !config.runtime.sqlitePath?.trim()) {
    errors.push('runtime.sqlitePath must be a non-empty exact path');
  }
  if (config.inference.mode !== 'byok') errors.push(`inference.mode must be "byok" (resolved: "${config.inference.mode}")`);
  if (!config.agent.invocationModes.includes('run') || config.agent.defaultInvocationMode !== 'run') {
    errors.push('the selected agent must support run and set defaultInvocationMode to "run"');
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
      `Desktop configuration is not runnable: ${errors.join('; ')}. Update the selected agent profile or agent.settings.json, then reload settings.`,
      JSON_RPC_ERROR_CODES.invalidParams,
    );
  }
}

async function readSettingsFile(path: string): Promise<AgentSettingsFile> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      throw new Error('settings root must be an object');
    }
    return value as AgentSettingsFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new DesktopProtocolError(
      'COMMAND_FAILED',
      `Unable to read agent settings: ${safeErrorMessage(error)}`,
      JSON_RPC_ERROR_CODES.commandFailed,
    );
  }
}

async function atomicWriteJson(path: string, value: AgentSettingsFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw new DesktopProtocolError(
      'COMMAND_FAILED',
      `Unable to save agent settings: ${safeErrorMessage(error)}`,
      JSON_RPC_ERROR_CODES.commandFailed,
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
