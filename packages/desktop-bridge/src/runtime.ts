import { AgentSdk, type AgentSdkOptions } from '@adaptive-agent/agent-sdk';
import type { AgentEvent, JsonValue, UUID } from '@adaptive-agent/core';

import {
  DESKTOP_BRIDGE_VERSION,
  DESKTOP_PROTOCOL_VERSION,
  DesktopProtocolError,
  type DesktopCommand,
  type DesktopMessage,
} from './protocol.js';

export type DesktopMessageWriter = (message: DesktopMessage) => void;

export class DesktopRuntime {
  private sdk: AgentSdk | undefined;

  constructor(private readonly write: DesktopMessageWriter) {}

  readyMessage(): DesktopMessage {
    return {
      version: DESKTOP_PROTOCOL_VERSION,
      type: 'runtime.ready',
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
      bridgeVersion: DESKTOP_BRIDGE_VERSION,
      pid: process.pid,
    };
  }

  async handle(command: DesktopCommand): Promise<JsonValue> {
    switch (command.type) {
      case 'hello':
        return {
          protocolVersion: DESKTOP_PROTOCOL_VERSION,
          bridgeVersion: DESKTOP_BRIDGE_VERSION,
          initialized: this.sdk !== undefined,
        };
      case 'runtime.initialize':
        return this.initialize(command);
      case 'run.start': {
        const sdk = this.requireSdk();
        return asJsonValue(await sdk.runRaw(command.goal, {
          ...(command.sessionId ? { sessionId: command.sessionId } : {}),
          ...(command.input === undefined ? {} : { input: command.input }),
        }));
      }
      case 'chat.send':
        return asJsonValue(await this.requireSdk().chatRaw(command.message, {
          ...(command.sessionId ? { sessionId: command.sessionId } : {}),
        }));
      case 'run.resume':
        return asJsonValue(await this.requireSdk().resumeRaw(asRunId(command.runId)));
      case 'run.retry':
        return asJsonValue(await this.requireSdk().retryRaw(asRunId(command.runId)));
      case 'run.interrupt':
        await this.requireSdk().interrupt(asRunId(command.runId));
        return { runId: command.runId, interrupted: true };
      case 'run.inspect':
        return asJsonValue(await this.requireSdk().inspect(asRunId(command.runId)));
      case 'run.steer':
        await this.requireSdk().steer(asRunId(command.runId), command.message);
        return { runId: command.runId, accepted: true };
      case 'approval.resolve': {
        const sdk = this.requireSdk();
        await sdk.agent.resolveApproval(asRunId(command.runId), command.approved);
        if (!command.approved) return asJsonValue(await sdk.inspect(asRunId(command.runId)));
        return asJsonValue(await sdk.resumeRaw(asRunId(command.runId)));
      }
      case 'clarification.resolve':
        return asJsonValue(await this.requireSdk().agent.resolveClarification(asRunId(command.runId), command.answer));
      case 'runtime.shutdown':
        await this.close();
        return { shutdown: true };
      default:
        throw new DesktopProtocolError('UNKNOWN_COMMAND', `Unknown command type: ${(command as { type: string }).type}`);
    }
  }

  async close(): Promise<void> {
    const sdk = this.sdk;
    this.sdk = undefined;
    await sdk?.close();
  }

  private async initialize(command: Extract<DesktopCommand, { type: 'runtime.initialize' }>): Promise<JsonValue> {
    if (this.sdk) throw new DesktopProtocolError('ALREADY_INITIALIZED', 'The runtime is already initialized.');
    const options: AgentSdkOptions = {
      ...(command.cwd ? { cwd: command.cwd } : {}),
      ...(command.agentConfigPath ? { agentConfigPath: command.agentConfigPath } : {}),
      ...(command.settingsConfigPath ? { settingsConfigPath: command.settingsConfigPath } : {}),
      ...(command.runtimeMode ? { runtimeMode: command.runtimeMode } : {}),
      settingsOverrides: {
        logging: { enabled: false },
        events: { subscribe: false, printLifecycle: false, verbose: false },
        interaction: { approvalMode: 'manual', clarificationMode: 'interactive' },
      },
      eventListener: (event: AgentEvent) => {
        this.write({
          version: DESKTOP_PROTOCOL_VERSION,
          type: 'agent.event',
          event: asJsonValue(event),
        });
      },
    };
    const sdk = await AgentSdk.create(options);
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
  }

  private requireSdk(): AgentSdk {
    if (!this.sdk) throw new DesktopProtocolError('NOT_INITIALIZED', 'Initialize the runtime before issuing agent commands.');
    return this.sdk;
  }
}

function asRunId(runId: string): UUID {
  if (!runId.trim()) throw new DesktopProtocolError('INVALID_COMMAND', 'runId must be a non-empty string.');
  return runId as UUID;
}

function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}
