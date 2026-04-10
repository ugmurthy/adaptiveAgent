import type { AgentEventFrame } from './protocol.js';
import type { CreatedAdaptiveAgent, JsonObject, RuntimeAgentEvent, RuntimeRunRecord } from './core.js';

export interface RealtimeEventForwardingContext {
  requestId?: string;
  rootRunId?: string;
  fallbackSessionId?: string;
  fallbackAgentId: string;
  emitFrame: (frame: AgentEventFrame) => void;
}

interface GatewayMetadata {
  requestId?: string;
  sessionId?: string;
  agentId?: string;
}

export async function withForwardedRealtimeEvents<T>(
  agent: CreatedAdaptiveAgent,
  context: RealtimeEventForwardingContext | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const unsubscribe = subscribeToRealtimeEvents(agent, context);

  try {
    return await operation();
  } finally {
    if (unsubscribe) {
      await unsubscribe();
    }
  }
}

function subscribeToRealtimeEvents(
  agent: CreatedAdaptiveAgent,
  context: RealtimeEventForwardingContext | undefined,
): (() => Promise<void>) | undefined {
  if (!context) {
    return undefined;
  }

  const eventStore = agent.runtime.eventStore;
  if (!eventStore || typeof eventStore !== 'object' || !('subscribe' in eventStore) || typeof eventStore.subscribe !== 'function') {
    return undefined;
  }

  const subscribableEventStore = eventStore as { subscribe: (listener: (event: RuntimeAgentEvent) => void) => () => void };

  let queue = Promise.resolve();
  const unsubscribe = subscribableEventStore.subscribe((event: RuntimeAgentEvent) => {
    queue = queue
      .then(() => forwardRealtimeEvent(agent, context, event))
      .catch(() => undefined);
  });

  return async () => {
    unsubscribe();
    await queue;
  };
}

async function forwardRealtimeEvent(
  agent: CreatedAdaptiveAgent,
  context: RealtimeEventForwardingContext,
  event: RuntimeAgentEvent,
): Promise<void> {
  const run = await agent.runtime.runStore.getRun(event.runId);
  if (!run) {
    return;
  }

  const rootRunId = run.rootRunId || event.runId;
  const rootRun = rootRunId === run.id ? run : await agent.runtime.runStore.getRun(rootRunId);
  const runGatewayMetadata = getGatewayMetadata(run);
  const rootGatewayMetadata = rootRun ? getGatewayMetadata(rootRun) : undefined;

  if (!matchesRealtimeContext(context, run.id, rootRunId, runGatewayMetadata, rootGatewayMetadata)) {
    return;
  }

  context.emitFrame({
    type: 'agent.event',
    eventType: event.type,
    data: event.payload,
    seq: event.seq,
    stepId: event.stepId,
    createdAt: event.createdAt,
    sessionId: runGatewayMetadata?.sessionId ?? rootGatewayMetadata?.sessionId ?? context.fallbackSessionId,
    agentId: runGatewayMetadata?.agentId ?? rootGatewayMetadata?.agentId ?? context.fallbackAgentId,
    runId: event.runId,
    rootRunId,
    parentRunId: run.parentRunId,
  });
}

function matchesRealtimeContext(
  context: RealtimeEventForwardingContext,
  runId: string,
  rootRunId: string,
  runGatewayMetadata: GatewayMetadata | undefined,
  rootGatewayMetadata: GatewayMetadata | undefined,
): boolean {
  if (context.rootRunId && (rootRunId === context.rootRunId || runId === context.rootRunId)) {
    return true;
  }

  if (!context.requestId) {
    return false;
  }

  return runGatewayMetadata?.requestId === context.requestId || rootGatewayMetadata?.requestId === context.requestId;
}

function getGatewayMetadata(run: RuntimeRunRecord): GatewayMetadata | undefined {
  const metadata = run.metadata;
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }

  const gateway = metadata.gateway;
  if (!gateway || typeof gateway !== 'object' || Array.isArray(gateway)) {
    return undefined;
  }

  const gatewayObject = gateway as JsonObject;

  return {
    requestId: typeof gatewayObject.requestId === 'string' ? gatewayObject.requestId : undefined,
    sessionId: typeof gatewayObject.sessionId === 'string' ? gatewayObject.sessionId : undefined,
    agentId: typeof gatewayObject.agentId === 'string' ? gatewayObject.agentId : undefined,
  };
}
