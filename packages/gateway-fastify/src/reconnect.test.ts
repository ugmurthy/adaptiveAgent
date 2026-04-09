import { describe, expect, it } from 'vitest';

import type { GatewayAuthContext } from './auth.js';
import { ProtocolValidationError } from './protocol.js';
import { createInMemoryGatewayStores, type GatewaySessionRecord } from './stores.js';
import { restoreActiveSession } from './reconnect.js';

const fixedNow = () => new Date('2026-01-01T01:00:00.000Z');

const authUser1: GatewayAuthContext = {
  subject: 'user-1',
  roles: ['member'],
  claims: {},
};

const authUser2: GatewayAuthContext = {
  subject: 'user-2',
  roles: [],
  claims: {},
};

function idleSession(): GatewaySessionRecord {
  return {
    id: 'sess-idle',
    channelId: 'main',
    authSubject: 'user-1',
    agentId: 'agent-a',
    status: 'idle',
    transcriptVersion: 5,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:30:00.000Z',
  };
}

function runningSession(): GatewaySessionRecord {
  return {
    id: 'sess-running',
    channelId: 'main',
    authSubject: 'user-1',
    agentId: 'agent-a',
    status: 'running',
    currentRunId: 'run-42',
    currentRootRunId: 'root-42',
    transcriptVersion: 8,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:45:00.000Z',
  };
}

function awaitingApprovalSession(): GatewaySessionRecord {
  return {
    id: 'sess-approval',
    channelId: 'main',
    authSubject: 'user-1',
    agentId: 'agent-b',
    status: 'awaiting_approval',
    currentRunId: 'run-99',
    currentRootRunId: 'root-99',
    transcriptVersion: 12,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:50:00.000Z',
  };
}

describe('restoreActiveSession', () => {
  it('restores an idle session with session.opened and session.updated frames', async () => {
    const stores = createInMemoryGatewayStores();
    await stores.sessions.create(idleSession());

    const result = await restoreActiveSession('sess-idle', {
      stores,
      authContext: authUser1,
      now: fixedNow,
    });

    expect(result.sessionOpened.type).toBe('session.opened');
    expect(result.sessionOpened.sessionId).toBe('sess-idle');
    expect(result.sessionOpened.status).toBe('idle');
    expect(result.sessionOpened.agentId).toBe('agent-a');

    expect(result.sessionUpdated.type).toBe('session.updated');
    expect(result.sessionUpdated.sessionId).toBe('sess-idle');
    expect(result.sessionUpdated.status).toBe('idle');
    expect(result.sessionUpdated.transcriptVersion).toBe(5);
    expect(result.sessionUpdated.activeRunId).toBeUndefined();

    expect(result.pendingApproval).toBeUndefined();
    expect(result.channels).toContain('session:sess-idle');
    expect(result.channels).toContain('agent:agent-a');
  });

  it('restores a running session with active run linkage', async () => {
    const stores = createInMemoryGatewayStores();
    await stores.sessions.create(runningSession());

    const result = await restoreActiveSession('sess-running', {
      stores,
      authContext: authUser1,
      now: fixedNow,
    });

    expect(result.sessionUpdated.status).toBe('running');
    expect(result.sessionUpdated.activeRunId).toBe('run-42');
    expect(result.sessionUpdated.activeRootRunId).toBe('root-42');

    expect(result.pendingApproval).toBeUndefined();
    expect(result.channels).toContain('session:sess-running');
    expect(result.channels).toContain('root-run:root-42');
    expect(result.channels).toContain('run:run-42');
  });

  it('restores an awaiting_approval session with pending approval state', async () => {
    const stores = createInMemoryGatewayStores();
    await stores.sessions.create(awaitingApprovalSession());

    const result = await restoreActiveSession('sess-approval', {
      stores,
      authContext: authUser1,
      now: fixedNow,
    });

    expect(result.sessionUpdated.status).toBe('awaiting_approval');
    expect(result.pendingApproval).toEqual({
      runId: 'run-99',
      rootRunId: 'root-99',
      sessionId: 'sess-approval',
    });
    expect(result.channels).toContain('session:sess-approval');
    expect(result.channels).toContain('root-run:root-99');
    expect(result.channels).toContain('run:run-99');
  });

  it('rejects reconnect without authentication', async () => {
    const stores = createInMemoryGatewayStores();
    await stores.sessions.create(idleSession());

    await expect(
      restoreActiveSession('sess-idle', { stores, now: fixedNow }),
    ).rejects.toThrow(ProtocolValidationError);
  });

  it('rejects reconnect from a different principal', async () => {
    const stores = createInMemoryGatewayStores();
    await stores.sessions.create(idleSession());

    await expect(
      restoreActiveSession('sess-idle', {
        stores,
        authContext: authUser2,
        now: fixedNow,
      }),
    ).rejects.toThrow(ProtocolValidationError);
  });

  it('rejects reconnect to a nonexistent session', async () => {
    const stores = createInMemoryGatewayStores();

    await expect(
      restoreActiveSession('no-such-session', {
        stores,
        authContext: authUser1,
        now: fixedNow,
      }),
    ).rejects.toThrow(ProtocolValidationError);
  });

  it('observers rejoin the correct channels for a running session', async () => {
    const stores = createInMemoryGatewayStores();
    await stores.sessions.create(runningSession());

    const result = await restoreActiveSession('sess-running', {
      stores,
      authContext: authUser1,
      now: fixedNow,
    });

    expect(result.channels).toEqual([
      'session:sess-running',
      'root-run:root-42',
      'run:run-42',
      'agent:agent-a',
    ]);
  });

  it('does not include duplicate channels when runId equals rootRunId', async () => {
    const stores = createInMemoryGatewayStores();
    await stores.sessions.create({
      ...runningSession(),
      id: 'sess-same',
      currentRunId: 'run-same',
      currentRootRunId: 'run-same',
    });

    const result = await restoreActiveSession('sess-same', {
      stores,
      authContext: authUser1,
      now: fixedNow,
    });

    expect(result.channels).toEqual([
      'session:sess-same',
      'root-run:run-same',
      'agent:agent-a',
    ]);
  });

  it('updates session updatedAt on reconnect', async () => {
    const stores = createInMemoryGatewayStores();
    await stores.sessions.create(idleSession());

    await restoreActiveSession('sess-idle', {
      stores,
      authContext: authUser1,
      now: fixedNow,
    });

    const session = await stores.sessions.get('sess-idle');
    expect(session!.updatedAt).toBe('2026-01-01T01:00:00.000Z');
  });
});
