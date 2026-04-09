import { describe, expect, it } from 'vitest';

import type { GatewayConfig } from './config.js';
import { buildTranscriptReplayEnvelope, buildTranscriptSummary, resolveGatewayTranscriptPolicy } from './transcript.js';
import type { GatewaySessionRecord, TranscriptMessageRecord } from './stores.js';

function createGatewayConfig(): GatewayConfig {
  return {
    server: {
      host: '127.0.0.1',
      port: 3000,
      websocketPath: '/ws',
    },
    transcript: {
      recentMessageWindow: 2,
      summaryTriggerWindow: 2,
      summaryMaxMessages: 3,
      summaryLineMaxLength: 18,
    },
    bindings: [],
    hooks: {
      failurePolicy: 'fail',
      modules: [],
      onAuthenticate: [],
      onSessionResolve: [],
      beforeRoute: [],
      beforeInboundMessage: [],
      beforeRunStart: [],
      afterRunResult: [],
      onAgentEvent: [],
      beforeOutboundFrame: [],
      onDisconnect: [],
      onError: [],
    },
  };
}

function createSession(overrides: Partial<GatewaySessionRecord> = {}): GatewaySessionRecord {
  return {
    id: 'session-1',
    channelId: 'webchat',
    authSubject: 'user-123',
    status: 'idle',
    transcriptVersion: 4,
    createdAt: '2026-04-08T10:00:00.000Z',
    updatedAt: '2026-04-08T10:00:00.000Z',
    ...overrides,
  };
}

function createTranscriptMessages(): TranscriptMessageRecord[] {
  return [
    {
      id: 'message-1',
      sessionId: 'session-1',
      sequence: 1,
      role: 'user',
      content: 'Hello from the first turn',
      createdAt: '2026-04-08T10:00:01.000Z',
    },
    {
      id: 'message-2',
      sessionId: 'session-1',
      sequence: 2,
      role: 'assistant',
      content: 'Hi there, how can I help?',
      createdAt: '2026-04-08T10:00:02.000Z',
    },
    {
      id: 'message-3',
      sessionId: 'session-1',
      sequence: 3,
      role: 'user',
      content: 'Please summarize my incident queue',
      createdAt: '2026-04-08T10:00:03.000Z',
    },
    {
      id: 'message-4',
      sessionId: 'session-1',
      sequence: 4,
      role: 'assistant',
      content: 'You currently have four incidents open.',
      createdAt: '2026-04-08T10:00:04.000Z',
    },
  ];
}

describe('gateway transcript replay', () => {
  it('resolves transcript policy from gateway config with defaults', () => {
    expect(resolveGatewayTranscriptPolicy(createGatewayConfig())).toEqual({
      recentMessageWindow: 2,
      summaryTriggerWindow: 2,
      summaryMaxMessages: 3,
      summaryLineMaxLength: 18,
    });

    expect(resolveGatewayTranscriptPolicy({})).toEqual({
      recentMessageWindow: 6,
      summaryTriggerWindow: 6,
      summaryMaxMessages: 12,
      summaryLineMaxLength: 160,
    });
  });

  it('builds a rolling transcript summary from older messages once the threshold is exceeded', () => {
    const summary = buildTranscriptSummary(createTranscriptMessages(), resolveGatewayTranscriptPolicy(createGatewayConfig()));

    expect(summary).toEqual('User: Hello from the...\nAssistant: Hi there, how c...');
  });

  it('builds the replay envelope from the stored summary plus the recent message window', () => {
    const policy = resolveGatewayTranscriptPolicy(createGatewayConfig());
    const replayEnvelope = buildTranscriptReplayEnvelope(
      createSession({ transcriptSummary: 'User asked for queue state.' }),
      createTranscriptMessages(),
      policy,
    );

    expect(replayEnvelope).toEqual([
      {
        role: 'system',
        content: 'Conversation summary:\nUser asked for queue state.',
      },
      {
        role: 'user',
        content: 'Please summarize my incident queue',
      },
      {
        role: 'assistant',
        content: 'You currently have four incidents open.',
      },
    ]);
  });
});
