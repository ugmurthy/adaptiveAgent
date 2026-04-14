import { describe, expect, it, vi } from 'vitest';

import type { GatewayAuthContext } from './auth.js';
import type { CreatedAdaptiveAgent, RuntimeRunRecord } from './core.js';
import { createAgentRegistry } from './agent-registry.js';
import { ProtocolValidationError } from './protocol.js';
import { createModuleRegistry } from './registries.js';
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
    invocationMode: 'run',
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
    expect(result.sessionOpened.invocationMode).toBe('run');

    expect(result.sessionUpdated.type).toBe('session.updated');
    expect(result.sessionUpdated.sessionId).toBe('sess-idle');
    expect(result.sessionUpdated.status).toBe('idle');
    expect(result.sessionUpdated.invocationMode).toBe('run');
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

  it('relinks a running session from its latest run link before restoring runtime state', async () => {
    const stores = createInMemoryGatewayStores();
    await stores.sessions.create({
      ...runningSession(),
      currentRunId: undefined,
      currentRootRunId: undefined,
    });
    await stores.sessionRunLinks.append({
      sessionId: 'sess-running',
      runId: 'run-42',
      rootRunId: 'root-42',
      invocationKind: 'run',
      createdAt: '2026-01-01T00:45:00.000Z',
    });

    const result = await restoreActiveSession('sess-running', {
      stores,
      authContext: authUser1,
      agentRegistry: createReconnectAgentRegistry({
        'run-42': {
          id: 'run-42',
          rootRunId: 'root-42',
          status: 'running',
          leaseOwner: 'worker-live',
          leaseExpiresAt: '2026-01-01T01:01:00.000Z',
        },
      }),
      now: fixedNow,
    });

    expect(result.policy).toBe('observer');
    expect(result.sessionUpdated.status).toBe('running');
    expect(result.sessionUpdated.activeRunId).toBe('run-42');
    expect(result.sessionUpdated.activeRootRunId).toBe('root-42');
    expect(result.channels).toEqual([
      'session:sess-running',
      'root-run:root-42',
      'run:run-42',
      'agent:agent-a',
    ]);
  });

  it('relinks a failed session from its latest run link before restoring runtime state', async () => {
    const stores = createInMemoryGatewayStores();
    await stores.sessions.create({
      ...runningSession(),
      id: 'sess-failed',
      status: 'failed',
      currentRunId: undefined,
      currentRootRunId: undefined,
    });
    await stores.sessionRunLinks.append({
      sessionId: 'sess-failed',
      runId: 'run-recoverable',
      rootRunId: 'root-recoverable',
      invocationKind: 'run',
      createdAt: '2026-01-01T00:45:00.000Z',
    });

    const resume = vi.fn(async () => ({
      status: 'success' as const,
      runId: 'run-recoverable',
      output: { recovered: true },
      stepsUsed: 3,
      usage: { promptTokens: 1, completionTokens: 1, estimatedCostUSD: 0 },
    }));

    const result = await restoreActiveSession('sess-failed', {
      stores,
      authContext: authUser1,
      agentRegistry: createReconnectAgentRegistry(
        {
          'run-recoverable': {
            id: 'run-recoverable',
            rootRunId: 'root-recoverable',
            status: 'running',
            leaseOwner: 'worker-old',
            leaseExpiresAt: '2026-01-01T00:59:00.000Z',
          },
        },
        { resume },
      ),
      now: fixedNow,
    });

    expect(result.policy).toBe('resumed');
    expect(resume).toHaveBeenCalledWith('run-recoverable');
    expect(result.sessionUpdated).toMatchObject({
      status: 'idle',
      activeRunId: undefined,
      activeRootRunId: undefined,
    });
    expect(result.recoveryFrame).toEqual({
      type: 'run.output',
      runId: 'run-recoverable',
      rootRunId: 'root-recoverable',
      sessionId: 'sess-failed',
      status: 'succeeded',
      output: { recovered: true },
    });
  });

  it('emits the terminal runtime result for a failed session with only durable run linkage', async () => {
    const stores = createInMemoryGatewayStores();
    await stores.sessions.create({
      ...runningSession(),
      id: 'sess-terminal-failed',
      status: 'failed',
      currentRunId: undefined,
      currentRootRunId: undefined,
    });
    await stores.sessionRunLinks.append({
      sessionId: 'sess-terminal-failed',
      runId: 'run-terminal-failed',
      rootRunId: 'root-terminal-failed',
      invocationKind: 'run',
      createdAt: '2026-01-01T00:45:00.000Z',
    });

    const result = await restoreActiveSession('sess-terminal-failed', {
      stores,
      authContext: authUser1,
      agentRegistry: createReconnectAgentRegistry({
        'run-terminal-failed': {
          id: 'run-terminal-failed',
          rootRunId: 'root-terminal-failed',
          status: 'failed',
          errorMessage: 'model failed before reconnect',
        },
      }),
      now: fixedNow,
    });

    expect(result.policy).toBe('terminal_result');
    expect(result.sessionUpdated).toMatchObject({
      status: 'failed',
      activeRunId: undefined,
      activeRootRunId: undefined,
    });
    expect(result.recoveryFrame).toEqual({
      type: 'run.output',
      runId: 'run-terminal-failed',
      rootRunId: 'root-terminal-failed',
      sessionId: 'sess-terminal-failed',
      status: 'failed',
      error: 'model failed before reconnect',
    });
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

  it('settles terminal runtime state on reconnect', async () => {
    const stores = createInMemoryGatewayStores();
    await stores.sessions.create(runningSession());

    const result = await restoreActiveSession('sess-running', {
      stores,
      authContext: authUser1,
      agentRegistry: createReconnectAgentRegistry({
        'run-42': {
          id: 'run-42',
          rootRunId: 'root-42',
          status: 'succeeded',
          result: { ok: true },
        },
      }),
      now: fixedNow,
    });

    expect(result.policy).toBe('terminal_result');
    expect(result.sessionUpdated).toMatchObject({
      status: 'idle',
      activeRunId: undefined,
      activeRootRunId: undefined,
    });
    expect(result.recoveryFrame).toEqual({
      type: 'run.output',
      runId: 'run-42',
      rootRunId: 'root-42',
      sessionId: 'sess-running',
      status: 'succeeded',
      output: { ok: true },
    });
    expect(await stores.sessions.get('sess-running')).toMatchObject({
      status: 'idle',
      currentRunId: undefined,
      currentRootRunId: undefined,
      lastCompletedRootRunId: 'root-42',
    });
  });

  it('replays the latest completed run output for an idle session', async () => {
    const stores = createInMemoryGatewayStores();
    await stores.sessions.create({
      ...idleSession(),
      lastCompletedRootRunId: 'root-completed',
    });
    await stores.sessionRunLinks.append({
      sessionId: 'sess-idle',
      runId: 'run-completed',
      rootRunId: 'root-completed',
      invocationKind: 'run',
      createdAt: '2026-01-01T00:45:00.000Z',
    });

    const result = await restoreActiveSession('sess-idle', {
      stores,
      authContext: authUser1,
      agentRegistry: createReconnectAgentRegistry({
        'run-completed': {
          id: 'run-completed',
          rootRunId: 'root-completed',
          status: 'succeeded',
          result: { report: 'already done' },
        },
      }),
      now: fixedNow,
    });

    expect(result.policy).toBe('terminal_replay');
    expect(result.sessionUpdated).toMatchObject({
      status: 'idle',
      activeRunId: undefined,
      activeRootRunId: undefined,
    });
    expect(result.recoveryFrame).toEqual({
      type: 'run.output',
      runId: 'run-completed',
      rootRunId: 'root-completed',
      sessionId: 'sess-idle',
      status: 'succeeded',
      output: { report: 'already done' },
    });
  });

  it('resumes expired active runtime state on reconnect', async () => {
    const stores = createInMemoryGatewayStores();
    await stores.sessions.create(runningSession());
    const resume = vi.fn(async () => ({
      status: 'success' as const,
      runId: 'run-42',
      output: { recovered: true },
      stepsUsed: 3,
      usage: { promptTokens: 1, completionTokens: 1, estimatedCostUSD: 0 },
    }));

    const result = await restoreActiveSession('sess-running', {
      stores,
      authContext: authUser1,
      agentRegistry: createReconnectAgentRegistry(
        {
          'run-42': {
            id: 'run-42',
            rootRunId: 'root-42',
            status: 'running',
            leaseOwner: 'worker-old',
            leaseExpiresAt: '2026-01-01T00:59:00.000Z',
          },
        },
        { resume },
      ),
      now: fixedNow,
    });

    expect(result.policy).toBe('resumed');
    expect(resume).toHaveBeenCalledWith('run-42');
    expect(result.recoveryFrame).toEqual({
      type: 'run.output',
      runId: 'run-42',
      rootRunId: 'root-42',
      sessionId: 'sess-running',
      status: 'succeeded',
      output: { recovered: true },
    });
    expect(result.sessionUpdated.status).toBe('idle');
  });

  it('reattaches as an observer when the active runtime lease is still valid', async () => {
    const stores = createInMemoryGatewayStores();
    await stores.sessions.create(runningSession());
    const resume = vi.fn();

    const result = await restoreActiveSession('sess-running', {
      stores,
      authContext: authUser1,
      agentRegistry: createReconnectAgentRegistry(
        {
          'run-42': {
            id: 'run-42',
            rootRunId: 'root-42',
            status: 'awaiting_subagent',
            leaseOwner: 'worker-live',
            leaseExpiresAt: '2026-01-01T01:01:00.000Z',
          },
        },
        { resume },
      ),
      now: fixedNow,
    });

    expect(result.policy).toBe('observer');
    expect(resume).not.toHaveBeenCalled();
    expect(result.sessionUpdated.status).toBe('running');
    expect(result.recoveryFrame).toBeUndefined();
    expect(result.channels).toEqual([
      'session:sess-running',
      'root-run:root-42',
      'run:run-42',
      'agent:agent-a',
    ]);
  });
});

function createReconnectAgentRegistry(
  runtimeRuns: Record<string, RuntimeRunRecord>,
  agentOverrides: Partial<CreatedAdaptiveAgent['agent']> = {},
) {
  return createAgentRegistry({
    agents: [
      {
        path: '/tmp/agent-a.json',
        config: {
          id: 'agent-a',
          name: 'Agent A',
          invocationModes: ['run'],
          defaultInvocationMode: 'run',
          model: {
            provider: 'ollama',
            model: 'qwen3.5',
          },
          tools: [],
          delegates: [],
        },
      },
    ],
    moduleRegistry: createModuleRegistry({
      tools: [],
      delegates: [],
    }),
    agentFactory: async () => ({
      agent: {
        chat: async () => ({
          status: 'success',
          runId: 'unused-chat-run',
          output: 'ok',
          stepsUsed: 0,
          usage: { promptTokens: 0, completionTokens: 0, estimatedCostUSD: 0 },
        }),
        ...agentOverrides,
      },
      runtime: {
        runStore: {
          getRun: async (runId: string) => runtimeRuns[runId] ?? null,
        },
        eventStore: {},
        snapshotStore: {},
        planStore: undefined,
      },
    }),
  });
}
