import type { JsonValue } from './core.js';
import type { AgentEventFrame, ChannelSubscribeFrame } from './protocol.js';

export const CHANNEL_SCOPES = ['session', 'run', 'root-run', 'agent'] as const;

export type ChannelScope = (typeof CHANNEL_SCOPES)[number];

export const BRIDGED_RUNTIME_EVENTS = [
  'run.created',
  'run.status_changed',
  'run.retry_started',
  'model.started',
  'model.retry',
  'model.completed',
  'model.failed',
  'tool.started',
  'tool.completed',
  'delegate.spawned',
  'approval.requested',
  'approval.resolved',
  'run.completed',
  'run.failed',
  'snapshot.created',
] as const;

export type BridgedRuntimeEvent = (typeof BRIDGED_RUNTIME_EVENTS)[number];

export interface RuntimeEventPayload {
  eventType: string;
  data: JsonValue;
  sessionId?: string;
  agentId?: string;
  runId?: string;
  rootRunId?: string;
  parentRunId?: string;
}

export interface ChannelSubscription {
  scope: ChannelScope;
  id: string;
  channel: string;
}

export interface ChannelSubscriptionManager {
  subscribe(channels: string[]): ChannelSubscription[];
  getSubscriptions(): ChannelSubscription[];
  matches(event: RuntimeEventPayload): boolean;
}

export function parseChannelId(channel: string): ChannelSubscription | undefined {
  const separatorIndex = channel.indexOf(':');
  if (separatorIndex < 0) {
    return undefined;
  }

  const scope = channel.slice(0, separatorIndex);
  const id = channel.slice(separatorIndex + 1);

  if (!CHANNEL_SCOPES.includes(scope as ChannelScope) || !id || id.trim().length === 0) {
    return undefined;
  }

  return {
    scope: scope as ChannelScope,
    id: id.trim(),
    channel,
  };
}

export function createChannelSubscriptionManager(): ChannelSubscriptionManager {
  const subscriptions = new Map<string, ChannelSubscription>();

  return {
    subscribe(channels: string[]): ChannelSubscription[] {
      const added: ChannelSubscription[] = [];

      for (const channel of channels) {
        if (subscriptions.has(channel)) {
          continue;
        }

        const parsed = parseChannelId(channel);
        if (!parsed) {
          continue;
        }

        subscriptions.set(channel, parsed);
        added.push(parsed);
      }

      return added;
    },

    getSubscriptions(): ChannelSubscription[] {
      return [...subscriptions.values()];
    },

    matches(event: RuntimeEventPayload): boolean {
      for (const subscription of subscriptions.values()) {
        if (channelMatchesEvent(subscription, event)) {
          return true;
        }
      }

      return false;
    },
  };
}

function channelMatchesEvent(subscription: ChannelSubscription, event: RuntimeEventPayload): boolean {
  switch (subscription.scope) {
    case 'session':
      return event.sessionId === subscription.id;
    case 'run':
      return event.runId === subscription.id;
    case 'root-run':
      return event.rootRunId === subscription.id;
    case 'agent':
      return event.agentId === subscription.id;
  }
}

export function bridgeRuntimeEvent(event: RuntimeEventPayload): AgentEventFrame {
  return {
    type: 'agent.event',
    eventType: event.eventType,
    data: event.data,
    sessionId: event.sessionId,
    agentId: event.agentId,
    runId: event.runId,
    rootRunId: event.rootRunId,
    parentRunId: event.parentRunId,
  };
}

export function validateChannelSubscribeFrame(frame: ChannelSubscribeFrame): {
  valid: ChannelSubscription[];
  invalid: string[];
} {
  const valid: ChannelSubscription[] = [];
  const invalid: string[] = [];

  for (const channel of frame.channels) {
    const parsed = parseChannelId(channel);
    if (parsed) {
      valid.push(parsed);
    } else {
      invalid.push(channel);
    }
  }

  return { valid, invalid };
}

export function isBridgedRuntimeEvent(eventType: string): eventType is BridgedRuntimeEvent {
  return BRIDGED_RUNTIME_EVENTS.includes(eventType as BridgedRuntimeEvent);
}
