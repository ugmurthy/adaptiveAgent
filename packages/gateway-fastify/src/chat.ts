import { randomUUID } from 'node:crypto';

import type { AgentRegistry } from './agent-registry.js';
import type { GatewayAuthContext } from './auth.js';
import type { GatewayConfig } from './config.js';
import type { JsonObject, JsonValue } from './core.js';
import { executeHookSlot } from './hooks.js';
import type { ApprovalRequestedFrame, MessageOutputFrame, MessageSendFrame } from './protocol.js';
import { ProtocolValidationError } from './protocol.js';
import type { RealtimeEventForwardingContext } from './realtime-events.js';
import type { ResolvedGatewayHooks } from './registries.js';
import { withForwardedRealtimeEvents } from './realtime-events.js';
import { resolveGatewayRoute } from './routing.js';
import { assertGatewaySessionWriteAllowed, getAuthorizedGatewaySession } from './session.js';
import type { GatewaySessionRecord, GatewayStores, TranscriptMessageRecord, TranscriptMessageRole } from './stores.js';
import { buildTranscriptReplayEnvelope, buildTranscriptSummary, resolveGatewayTranscriptPolicy } from './transcript.js';

export interface ExecuteGatewayChatTurnOptions {
  gatewayConfig: GatewayConfig;
  agentRegistry: AgentRegistry;
  stores: GatewayStores;
  authContext?: GatewayAuthContext;
  hooks?: ResolvedGatewayHooks;
  now?: () => Date;
  transcriptMessageIdFactory?: () => string;
  realtimeEvents?: Omit<RealtimeEventForwardingContext, 'fallbackAgentId' | 'fallbackSessionId'>;
}

export async function executeGatewayChatTurn(
  frame: MessageSendFrame,
  options: ExecuteGatewayChatTurnOptions,
): Promise<MessageOutputFrame | ApprovalRequestedFrame> {
  const nowIso = (options.now ?? (() => new Date()))().toISOString();
  const session = await getAuthorizedGatewaySession(frame.sessionId, {
    authContext: options.authContext,
    stores: options.stores,
    requestType: frame.type,
  });
  let effectiveMetadata = frame.metadata;
  effectiveMetadata = await runBeforeHook(options.hooks, 'onSessionResolve', frame.type, {
    authContext: options.authContext,
    session,
    metadata: effectiveMetadata,
  });
  assertGatewaySessionWriteAllowed(session, frame.type);
  effectiveMetadata = await runBeforeHook(options.hooks, 'beforeRoute', frame.type, {
    authContext: options.authContext,
    session,
    invocationMode: 'chat',
    metadata: effectiveMetadata,
  });
  const route = resolveGatewayRoute({
    gatewayConfig: options.gatewayConfig,
    agentRegistry: options.agentRegistry,
    session,
    authContext: options.authContext,
    invocationMode: 'chat',
    requestType: frame.type,
  });
  effectiveMetadata = await runBeforeHook(options.hooks, 'beforeInboundMessage', frame.type, {
    authContext: options.authContext,
    session,
    agentId: route.agentId,
    invocationMode: 'chat',
    metadata: effectiveMetadata,
  });
  const effectiveFrame = effectiveMetadata === frame.metadata ? frame : { ...frame, metadata: effectiveMetadata };
  const transcriptPolicy = resolveGatewayTranscriptPolicy(options.gatewayConfig);
  const transcriptMessages = await options.stores.transcriptMessages.listBySession(session.id);
  const agent = await options.agentRegistry.getAgent(route.agentId);
  const runningSession = await options.stores.sessions.update({
    ...session,
    agentId: route.agentId,
    invocationMode: 'chat',
    status: 'running',
    currentRunId: undefined,
    currentRootRunId: undefined,
    updatedAt: nowIso,
  });

  try {
    const replayEnvelope = buildTranscriptReplayEnvelope(runningSession, transcriptMessages, transcriptPolicy);
    const chatResult = await withForwardedRealtimeEvents(
      agent,
      options.realtimeEvents
        ? {
            ...options.realtimeEvents,
            fallbackAgentId: route.agentId,
            fallbackSessionId: runningSession.id,
          }
        : undefined,
      () =>
        agent.agent.chat({
          messages: [...replayEnvelope, { role: 'user', content: effectiveFrame.content }],
          context: buildGatewayChatContext(runningSession, options.authContext),
          metadata: buildGatewayChatMetadata(effectiveFrame, route.agentId, options.realtimeEvents?.requestId),
        }),
    );
    const rootRunId = (await agent.runtime.runStore.getRun(chatResult.runId))?.rootRunId ?? chatResult.runId;

    await options.stores.sessionRunLinks.append({
      sessionId: runningSession.id,
      runId: chatResult.runId,
      rootRunId,
      invocationKind: 'chat',
      turnIndex: transcriptMessages.filter((message) => message.role === 'user').length + 1,
      metadata: effectiveFrame.metadata,
      createdAt: nowIso,
    });

    switch (chatResult.status) {
      case 'success': {
        const assistantContent = serializeAssistantOutput(chatResult.output);
        const persistedMessages = await appendTranscriptMessages(
          options.stores,
          runningSession,
          transcriptMessages,
          [
            { role: 'user', content: effectiveFrame.content, metadata: effectiveFrame.metadata },
            { role: 'assistant', content: assistantContent },
          ],
          nowIso,
          options.transcriptMessageIdFactory,
        );

        await settleSession(options.stores, runningSession, {
          status: 'idle',
          currentRunId: undefined,
          currentRootRunId: undefined,
          lastCompletedRootRunId: rootRunId,
          transcriptVersion: persistedMessages.at(-1)?.sequence ?? runningSession.transcriptVersion,
          transcriptSummary: buildTranscriptSummary(persistedMessages, transcriptPolicy),
          updatedAt: nowIso,
        });

        const response: MessageOutputFrame = {
          type: 'message.output',
          sessionId: runningSession.id,
          runId: chatResult.runId,
          rootRunId,
          message: {
            role: 'assistant',
            content: assistantContent,
          },
        };

        await runAfterHook(options.hooks, frame.type, {
          authContext: options.authContext,
          session: runningSession,
          agentId: route.agentId,
          result: response,
          metadata: effectiveFrame.metadata,
        });

        return response;
      }
      case 'clarification_requested': {
        const persistedMessages = await appendTranscriptMessages(
          options.stores,
          runningSession,
          transcriptMessages,
          [
            { role: 'user', content: effectiveFrame.content, metadata: effectiveFrame.metadata },
            { role: 'assistant', content: chatResult.message },
          ],
          nowIso,
          options.transcriptMessageIdFactory,
        );

        await settleSession(options.stores, runningSession, {
          status: 'idle',
          currentRunId: undefined,
          currentRootRunId: undefined,
          lastCompletedRootRunId: rootRunId,
          transcriptVersion: persistedMessages.at(-1)?.sequence ?? runningSession.transcriptVersion,
          transcriptSummary: buildTranscriptSummary(persistedMessages, transcriptPolicy),
          updatedAt: nowIso,
        });

        const response: MessageOutputFrame = {
          type: 'message.output',
          sessionId: runningSession.id,
          runId: chatResult.runId,
          rootRunId,
          message: {
            role: 'assistant',
            content: chatResult.message,
          },
        };

        await runAfterHook(options.hooks, frame.type, {
          authContext: options.authContext,
          session: runningSession,
          agentId: route.agentId,
          result: response,
          metadata: effectiveFrame.metadata,
        });

        return response;
      }
      case 'approval_requested': {
        const persistedMessages = await appendTranscriptMessages(
          options.stores,
          runningSession,
          transcriptMessages,
          [{ role: 'user', content: effectiveFrame.content, metadata: effectiveFrame.metadata }],
          nowIso,
          options.transcriptMessageIdFactory,
        );

        await settleSession(options.stores, runningSession, {
          status: 'awaiting_approval',
          currentRunId: chatResult.runId,
          currentRootRunId: rootRunId,
          transcriptVersion: persistedMessages.at(-1)?.sequence ?? runningSession.transcriptVersion,
          transcriptSummary: buildTranscriptSummary(persistedMessages, transcriptPolicy),
          updatedAt: nowIso,
        });

        const response: ApprovalRequestedFrame = {
          type: 'approval.requested',
          runId: chatResult.runId,
          rootRunId,
          sessionId: runningSession.id,
          toolName: chatResult.toolName,
          reason: chatResult.message,
        };

        await runAfterHook(options.hooks, frame.type, {
          authContext: options.authContext,
          session: runningSession,
          agentId: route.agentId,
          result: response,
          metadata: effectiveFrame.metadata,
        });

        return response;
      }
      case 'failure': {
        await settleSession(options.stores, runningSession, {
          status: 'failed',
          currentRunId: undefined,
          currentRootRunId: undefined,
          lastCompletedRootRunId: rootRunId,
          updatedAt: nowIso,
        });

        throw new ProtocolValidationError('run_failed', chatResult.error, {
          requestType: frame.type,
          details: {
            sessionId: runningSession.id,
            runId: chatResult.runId,
            rootRunId,
            code: chatResult.code,
          },
        });
      }
    }
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      throw error;
    }

    await settleSession(options.stores, runningSession, {
      status: 'failed',
      currentRunId: undefined,
      currentRootRunId: undefined,
      updatedAt: nowIso,
    });

    throw new ProtocolValidationError(
      'run_failed',
      error instanceof Error ? error.message : 'Chat turn failed unexpectedly.',
      {
        requestType: frame.type,
        details: { sessionId: runningSession.id },
      },
    );
  }
}

function buildGatewayChatContext(session: GatewaySessionRecord, authContext?: GatewayAuthContext): JsonObject {
  const context: JsonObject = {
    sessionId: session.id,
    channelId: session.channelId,
    authSubject: session.authSubject,
    invocationMode: 'chat',
  };

  if (session.tenantId) {
    context.tenantId = session.tenantId;
  }

  if (authContext?.roles.length) {
    context.roles = authContext.roles;
  }

  return context;
}

function buildGatewayChatMetadata(frame: MessageSendFrame, agentId: string, requestId?: string): JsonObject {
  return {
    ...(frame.metadata ?? {}),
    gateway: {
      sessionId: frame.sessionId,
      agentId,
      invocationMode: 'chat',
      ...(requestId ? { requestId } : {}),
    },
  };
}

function serializeAssistantOutput(output: JsonValue): string {
  if (typeof output === 'string') {
    return output;
  }

  return JSON.stringify(output);
}

async function appendTranscriptMessages(
  stores: GatewayStores,
  session: GatewaySessionRecord,
  existingMessages: TranscriptMessageRecord[],
  messages: Array<{ role: TranscriptMessageRole; content: string; metadata?: JsonObject }>,
  createdAt: string,
  messageIdFactory?: () => string,
): Promise<TranscriptMessageRecord[]> {
  let nextSequence = existingMessages.at(-1)?.sequence ?? 0;
  const appendedMessages: TranscriptMessageRecord[] = [];

  for (const message of messages) {
    nextSequence += 1;
    const storedMessage = await stores.transcriptMessages.append({
      id: (messageIdFactory ?? randomUUID)(),
      sessionId: session.id,
      sequence: nextSequence,
      role: message.role,
      content: message.content,
      metadata: message.metadata,
      createdAt,
    });
    appendedMessages.push(storedMessage);
  }

  return [...existingMessages, ...appendedMessages];
}

async function settleSession(
  stores: GatewayStores,
  session: GatewaySessionRecord,
  patch: Partial<GatewaySessionRecord>,
): Promise<GatewaySessionRecord> {
  return stores.sessions.update({
    ...session,
    ...patch,
  });
}

async function runBeforeHook(
  hooks: ResolvedGatewayHooks | undefined,
  slot: 'onSessionResolve' | 'beforeRoute' | 'beforeInboundMessage',
  requestType: string,
  context: {
    authContext?: GatewayAuthContext;
    session: GatewaySessionRecord;
    invocationMode?: 'chat';
    agentId?: string;
    metadata?: JsonObject;
  },
): Promise<JsonObject | undefined> {
  if (!hooks) {
    return context.metadata;
  }

  const hookResult = await executeHookSlot(hooks, slot, {
    slot,
    requestType,
    authContext: context.authContext,
    session: context.session,
    invocationMode: context.invocationMode,
    agentId: context.agentId,
    metadata: context.metadata,
  });

  if (hookResult.rejected) {
    throw new ProtocolValidationError(
      'invalid_frame',
      hookResult.rejectionReason ?? `Gateway ${slot} hook rejected the request.`,
      {
        requestType,
        details: {
          sessionId: context.session.id,
          channelId: context.session.channelId,
          slot,
        },
      },
    );
  }

  return hookResult.enrichedMetadata ?? context.metadata;
}

async function runAfterHook(
  hooks: ResolvedGatewayHooks | undefined,
  requestType: string,
  context: {
    authContext?: GatewayAuthContext;
    session: GatewaySessionRecord;
    agentId: string;
    result: MessageOutputFrame | ApprovalRequestedFrame;
    metadata?: JsonObject;
  },
): Promise<void> {
  if (!hooks) {
    return;
  }

  await executeHookSlot(hooks, 'afterRunResult', {
    slot: 'afterRunResult',
    requestType,
    authContext: context.authContext,
    session: context.session,
    agentId: context.agentId,
    result: context.result,
    metadata: context.metadata,
  });
}
