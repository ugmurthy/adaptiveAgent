import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';

import { SqliteTraceReader, TraceService } from './trace-session/reader.js';
import type { CliOptions, SessionListItem, SessionUsageSummary, ToolAccountingSummary, TraceReport } from './trace-session/types.js';
import { TraceSidecarRuntime } from './sidecar/runtime.js';
import { parseTraceSidecarRpcRequest } from './sidecar/protocol.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function options(target: Partial<CliOptions>): CliOptions {
  return {
    json: false,
    listSessions: false,
    listPerformance: false,
    listSessionless: false,
    deleteEmptyGoalSessions: false,
    usageOnly: false,
    includePlans: false,
    onlyDelegates: false,
    messages: false,
    reasoning: false,
    systemOnly: false,
    help: false,
    ...target,
  };
}

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'trace-session-sqlite-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'runtime.sqlite');
  const database = new Database(path, { create: true, strict: true });
  createCoreRuntimeSchema(database);

  const root = run({
    id: 'root-1', context: { sessionId: 'session-1' }, rootRunId: 'root-1', goal: 'Modernize tracing',
    metadata: { taskPreparation: { title: 'Modernize Trace Session', name: 'modernize-trace-session' } },
    status: 'succeeded', modelProvider: 'openrouter', modelName: 'test-model',
    usage: { promptTokens: 100, completionTokens: 40, reasoningTokens: 10, totalTokens: 150, estimatedCostUSD: 0.15 },
    result: { answer: 'done' }, createdAt: '2026-07-01T10:00:00.000Z', updatedAt: '2026-07-01T10:00:05.000Z', completedAt: '2026-07-01T10:00:05.000Z',
  });
  const child = run({
    id: 'child-1', context: { sessionId: 'session-1' }, rootRunId: 'root-1', parentRunId: 'root-1', parentStepId: 'delegate-step',
    delegateName: 'researcher', delegationDepth: 1, goal: 'Inspect SQLite', status: 'succeeded',
    usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30, estimatedCostUSD: 0.03 },
    result: { finding: 'record_json' }, createdAt: '2026-07-01T10:00:01.000Z', updatedAt: '2026-07-01T10:00:03.000Z', completedAt: '2026-07-01T10:00:03.000Z',
  });
  insertRun(database, root);
  insertRun(database, child);

  insertEvent(database, { id: 'event-1', runId: 'root-1', seq: 1, type: 'tool.started', stepId: 'delegate-step', toolCallId: 'call-1', payload: { toolName: 'delegate', input: { goal: 'Inspect SQLite' } }, createdAt: '2026-07-01T10:00:01.000Z' });
  insertEvent(database, { id: 'event-2', runId: 'root-1', seq: 2, type: 'tool.completed', stepId: 'delegate-step', toolCallId: 'call-1', payload: { toolName: 'delegate' }, createdAt: '2026-07-01T10:00:03.000Z' });
  insertEvent(database, { id: 'event-3', runId: 'child-1', seq: 1, type: 'model.completed', payload: { provider: 'mesh' }, createdAt: '2026-07-01T10:00:02.000Z' });
  insertEvent(database, { id: 'event-4', runId: 'child-1', seq: 2, type: 'usage.updated', payload: { usage: { model: 'child-model' } }, createdAt: '2026-07-01T10:00:02.500Z' });
  insertEvent(database, { id: 'event-5', runId: 'child-1', seq: 3, type: 'run.completed', payload: {}, createdAt: '2026-07-01T10:00:03.000Z' });

  const tool = { runId: 'root-1', stepId: 'delegate-step', toolCallId: 'call-1', toolName: 'delegate', idempotencyKey: 'root-1:delegate-step:call-1', status: 'completed', inputHash: 'hash', input: { goal: 'Inspect SQLite' }, childRunId: 'child-1', output: { childRunId: 'child-1' }, startedAt: '2026-07-01T10:00:01.000Z', completedAt: '2026-07-01T10:00:03.000Z' };
  database.run('insert into tool_executions (idempotency_key,run_id,step_id,tool_call_id,status,child_run_id,started_at,completed_at,record_json) values (?,?,?,?,?,?,?,?,?)', [tool.idempotencyKey, tool.runId, tool.stepId, tool.toolCallId, tool.status, tool.childRunId, tool.startedAt, tool.completedAt, JSON.stringify(tool)]);
  const modelTool = { runId: 'root-1', stepId: 'model-step', toolCallId: 'call-model', toolName: 'remote_model', idempotencyKey: 'root-1:model-step:call-model', status: 'completed', inputHash: 'model-hash', input: { provider: 'mesh', model: 'tool-model' }, output: { provider: 'mesh', model: 'tool-model', usage: { prompt_tokens: 5, completion_tokens: 2, reasoning_tokens: 1, cost_usd: 0.01 } }, startedAt: '2026-07-01T10:00:03.000Z', completedAt: '2026-07-01T10:00:04.000Z' };
  database.run('insert into tool_executions (idempotency_key,run_id,step_id,tool_call_id,status,child_run_id,started_at,completed_at,record_json) values (?,?,?,?,?,?,?,?,?)', [modelTool.idempotencyKey, modelTool.runId, modelTool.stepId, modelTool.toolCallId, modelTool.status, null, modelTool.startedAt, modelTool.completedAt, JSON.stringify(modelTool)]);

  const snapshot = { id: 'snapshot-1', runId: 'root-1', snapshotSeq: 1, status: 'succeeded', summary: { stepsUsed: 2 }, state: { messages: [{ role: 'system', content: 'You are an agent.' }, { role: 'user', content: 'Modernize tracing' }, { role: 'assistant', content: 'Done.' }], pendingRuntimeMessages: [{ role: 'user', content: 'Also include parity.' }] }, createdAt: '2026-07-01T10:00:05.000Z' };
  database.run('insert into run_snapshots (id,run_id,snapshot_seq,status,created_at,record_json) values (?,?,?,?,?,?)', [snapshot.id, snapshot.runId, snapshot.snapshotSeq, snapshot.status, snapshot.createdAt, JSON.stringify(snapshot)]);

  const plan = { id: 'plan-1', version: 1, status: 'approved', goal: 'Modernize tracing', summary: 'Inspect then report', toolsetHash: 'tools', createdFromRunId: 'root-1', steps: [{ id: 'step-1', title: 'Inspect', toolName: 'inspect', inputTemplate: {}, onFailure: 'stop', requiresApproval: false }], createdAt: '2026-07-01T10:00:00.500Z' };
  database.run('insert into plans (id,created_from_run_id,parent_plan_id,created_at,record_json) values (?,?,?,?,?)', [plan.id, plan.createdFromRunId, null, plan.createdAt, JSON.stringify(plan)]);
  const execution = { id: 'execution-1', planId: 'plan-1', runId: 'root-1', attempt: 1, status: 'succeeded', currentStepId: 'step-1', currentStepIndex: 0, createdAt: '2026-07-01T10:00:00.500Z', updatedAt: '2026-07-01T10:00:05.000Z', completedAt: '2026-07-01T10:00:05.000Z' };
  database.run('insert into plan_executions (id,plan_id,run_id,attempt,status,created_at,updated_at,record_json) values (?,?,?,?,?,?,?,?)', [execution.id, execution.planId, execution.runId, execution.attempt, execution.status, execution.createdAt, execution.updatedAt, JSON.stringify(execution)]);
  database.close();
  return path;
}

describe('SqliteTraceReader', () => {
  it('does not create a missing database and rejects an unsupported schema', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'trace-session-sqlite-invalid-'));
    temporaryDirectories.push(directory);
    expect(() => new SqliteTraceReader(join(directory, 'missing.sqlite'))).toThrow(/does not exist/);

    const invalid = join(directory, 'invalid.sqlite');
    new Database(invalid, { create: true }).close();
    expect(() => new SqliteTraceReader(invalid)).toThrow(/adaptive_agent_migrations is missing/);
  });

  it('reconstructs core trace views for session, root, and arbitrary run targets', async () => {
    const service = new TraceService(new SqliteTraceReader(await fixture()));
    try {
      const report = await service.trace(options({ sessionId: 'session-1', messages: true, includePlans: true }));
      expect(report.rootRuns).toHaveLength(1);
      expect(report.runTree?.map((entry) => entry.runId)).toEqual(['root-1', 'child-1']);
      expect(report.timeline.map((entry) => entry.eventType)).toContain('tool.completed');
      expect(report.delegates).toMatchObject([{ child_run_id: 'child-1', child_delegate_name: 'researcher' }]);
      expect(report.plans).toMatchObject([{ plan_id: 'plan-1', step_key: 'step-1', failure_policy: 'stop' }]);
      expect(report.totalSteps).toBe(2);
      expect(report.llmMessages?.[0]?.effectiveMessages.map((message) => [message.role, message.persistence])).toEqual([
        ['system', 'persisted'], ['user', 'persisted'], ['assistant', 'persisted'], ['user', 'pending'],
      ]);
      expect(report.llmMessages?.[0]?.initialMessages?.[0]?.category).toBe('initial-runtime-system');
      expect(report.warnings.join(' ')).toMatch(/accounting covers only persisted accounting events/);

      const byRoot = await service.trace(options({ rootRunId: 'root-1' }));
      expect(byRoot.target).toMatchObject({ kind: 'root-run', resolvedRootRunId: 'root-1' });
      const byChild = await service.trace(options({ runId: 'child-1' }));
      expect(byChild.target).toMatchObject({ kind: 'run', requestedId: 'child-1', resolvedRootRunId: 'root-1' });
    } finally {
      await service.close();
    }
  });

  it('provides usage, list, performance, aggregate, and sessionless parity inputs', async () => {
    const service = new TraceService(new SqliteTraceReader(await fixture()));
    try {
      const usage = await service.usage(options({ sessionId: 'session-1' }));
      expect(usage.total).toMatchObject({ promptTokens: 125, completionTokens: 52, reasoningTokens: 11, totalTokens: 188, estimatedCostUSD: 0.19 });
      expect(usage.byRootRun).toHaveLength(1);
      expect(usage.byProviderModel).toMatchObject([
        { provider: 'openrouter', model: 'test-model', runCount: 1 },
        { provider: 'mesh', model: 'child-model', runCount: 1 },
      ]);
      expect(usage.toolOutputByProviderModel).toMatchObject([
        { provider: 'mesh', model: 'tool-model', toolCallCount: 1, usage: { totalTokens: 8, estimatedCostUSD: 0.01 } },
      ]);

      expect(await service.listSessions()).toMatchObject([{
        sessionId: 'session-1', title: 'Modernize Trace Session', name: 'modernize-trace-session', status: 'succeeded',
      }]);
      const performance = await service.listPerformance();
      expect(performance).toHaveLength(1);
      expect(performance[0]).toMatchObject({ rootRunId: 'root-1', totalDurationMs: 5_000 });
      expect(performance[0]!.performance.tools.started).toBe(1);

      const aggregate = await service.aggregate({ groupBy: 'model' });
      expect(aggregate.population).toMatchObject({ runCount: 1, terminalRuns: 1, missingUsage: 0, missingCost: 0 });
      expect(aggregate.groups[0]?.key).toBe('openrouter/test-model');
      expect(aggregate.notes.join(' ')).toMatch(/accounting covers only persisted accounting events/);
      expect(await service.listSessionless()).toEqual([]);
    } finally {
      await service.close();
    }
  });

  it('recovers terminal accounting after reopen and exposes only the safe summary through RPC', async () => {
    const path = await fixture();
    const database = new Database(path);
    const priced = { provider: 'serper', operation: 'web_search', billable: true, units: { requests: 2 }, estimatedCostUSD: 0.006 };
    const cached = { ...priced, cached: true, units: { requests: 0 }, estimatedCostUSD: 0 };
    const unpriced = { provider: 'parallel', operation: 'read_web_page', billable: true, units: { requests: 3 } };
    const free = { provider: 'direct', operation: 'read_web_page', billable: false, units: { requests: 1 }, estimatedCostUSD: 0 };
    const append = (id: string, runId: string, seq: number, toolCallId: string | null, type: string, accounting?: unknown) => insertEvent(database, {
      id, runId, seq, toolCallId, type, createdAt: `2026-07-01T10:00:${String(seq).padStart(2, '0')}.000Z`,
      payload: { toolName: 'web_search', input: { secret: 'sensitive-input' }, output: { secret: 'sensitive-output' }, ...(accounting ? { accounting: { ...accounting as object, secret: 'sensitive-accounting' } } : {}) },
    });
    append('started', 'root-1', 3, 'priced', 'tool.started');
    append('priced', 'root-1', 4, 'priced', 'tool.completed', { ...priced, units: { requests: 9 }, estimatedCostUSD: 9 });
    append('priced-latest', 'root-1', 5, 'priced', 'tool.completed', priced);
    append('cached', 'root-1', 6, 'cached', 'tool.completed', cached);
    // Same call ID in another run must not collide with the root's priced call.
    append('unpriced', 'child-1', 4, 'priced', 'tool.failed', unpriced);
    append('free', 'child-1', 5, null, 'tool.completed', free);
    append('free-anonymous', 'child-1', 6, null, 'tool.completed', free);
    append('no-accounting', 'root-1', 7, 'priced', 'tool.completed');
    append('nonterminal', 'root-1', 8, 'pending', 'tool.started', { ...priced, units: { requests: 99 } });
    database.close();

    const expected: ToolAccountingSummary = {
      totalRequests: 7, billableRequests: 5, cachedToolCalls: 1, unpricedRequests: 3, estimatedCostUSD: 0.006,
      byProviderOperation: [
        { provider: 'serper', operation: 'web_search', toolCalls: 2, requests: 2, billableRequests: 2, cachedToolCalls: 1, unpricedRequests: 0, estimatedCostUSD: 0.006 },
        { provider: 'parallel', operation: 'read_web_page', toolCalls: 1, requests: 3, billableRequests: 3, cachedToolCalls: 0, unpricedRequests: 3, estimatedCostUSD: 0 },
        { provider: 'direct', operation: 'read_web_page', toolCalls: 2, requests: 2, billableRequests: 0, cachedToolCalls: 0, unpricedRequests: 0, estimatedCostUSD: 0 },
      ],
    };
    const service = new TraceService(new SqliteTraceReader(path));
    try {
      for (const target of [{ sessionId: 'session-1' }, { rootRunId: 'root-1' }, { runId: 'child-1' }]) {
        const usage = await service.usage(options(target));
        expect(usage.toolAccounting).toEqual(expected);
        expect(usage.total.estimatedCostUSD).toBe(0.19);
      }
      expect((await service.usage(options({ rootRunId: 'absent' }))).toolAccounting).toMatchObject({ totalRequests: 0, byProviderOperation: [] });
      const runtime = new TraceSidecarRuntime(service, 'sqlite', { allowMessages: false, allowReasoning: false, allowRawToolPayloads: true });
      const rpc = (method: string, params: unknown) => runtime.handle(parseTraceSidecarRpcRequest(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })));
      await rpc('initialize', { protocolVersion: '1.1', clientInfo: { name: 'test' } });
      const usage = await rpc('trace/usage', { target: { kind: 'root-run', rootRunId: 'root-1' } }) as SessionUsageSummary;
      expect(usage.toolAccounting).toEqual(expected);
      expect(JSON.stringify(usage)).not.toContain('sensitive');
      for (const rawToolPayloads of [false, true]) {
        const report = JSON.parse(JSON.stringify(await rpc('trace/get', { target: { kind: 'root-run', rootRunId: 'root-1' }, include: { rawToolPayloads } }))) as TraceReport;
        expect(report.usage.toolAccounting).toEqual(expected);
        expect(report.diagnostics).toBeUndefined();
        expect(report.warnings).toEqual([]);
        expect(report.timeline.every(entry => entry.accounting === undefined)).toBe(true);
        expect(JSON.stringify(report)).not.toContain('sensitive-accounting');
        if (!rawToolPayloads) expect(JSON.stringify(report)).not.toContain('sensitive');
      }
      expect((await service.aggregate({ groupBy: 'model' })).overall.successfulRuns.averageExternalToolProviderCostUSD).toBeNull();
    } finally { await service.close(); }

    // Once all recorded requests are priced, aggregate cost must no longer be gated off for SQLite.
    const writer = new Database(path);
    writer.run("delete from agent_events where id in ('unpriced','nonterminal')");
    writer.close();
    const pricedService = new TraceService(new SqliteTraceReader(path));
    try {
      const aggregate = await pricedService.aggregate({ groupBy: 'model' });
      expect(aggregate.overall.successfulRuns.averageExternalToolProviderCostUSD).toBe(0.006);
      expect(aggregate.overall.successfulRuns.averageEstimatedGrandTotalUSD).toBeCloseTo(0.196);
    } finally { await pricedService.close(); }
  });

  it('pages reopened SQLite sessions by newest matching root through the sidecar', async () => {
    const path = await fixture();
    const writer = new Database(path);
    for (const [id, sessionId, day] of [['newest', 'session-1', '05'], ['tie-b', 'session-b', '04'], ['tie-a', 'session-a', '04']]) {
      const createdAt = `2026-07-${day}T00:00:00.000Z`;
      insertRun(writer, run({ id, rootRunId: id, sessionId, goal: id, status: 'succeeded', createdAt, updatedAt: createdAt }));
    }
    writer.close();
    const service = new TraceService(new SqliteTraceReader(path));
    try {
      const runtime = new TraceSidecarRuntime(service, 'sqlite', { allowMessages: false, allowReasoning: false, allowRawToolPayloads: false });
      const rpc = (method: string, params: unknown) => runtime.handle(parseTraceSidecarRpcRequest(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })));
      await rpc('initialize', { protocolVersion: '1.1', clientInfo: { name: 'test' } });
      let after: SessionListItem['cursor'];
      const ids: Array<string | null> = [];
      for (let i = 0; i < 4; i++) {
        const page = await rpc('trace/listSessions', { limit: 1, until: '2026-07-06T00:00:00Z', ...(after ? { after } : {}) }) as SessionListItem[];
        if (!page.length) break;
        if (i === 0) {
          expect(page[0]).toMatchObject({ title: 'Modernize Trace Session', name: 'modernize-trace-session' });
          expect(page[0]!.goals.map(goal => goal.runId)).toEqual(['newest', 'root-1']);
          expect(JSON.stringify(page[0])).not.toContain('metadata');
        }
        ids.push(page[0]!.sessionId);
        after = page[0]!.cursor;
      }
      expect(ids).toEqual(['session-1', 'session-a', 'session-b']);
    } finally { await service.close(); }
  });

  it('runs the CLI against a settings-inferred SQLite runtime', async () => {
    const path = await fixture();
    const settingsPath = join(path, '..', 'agent.settings.json');
    await writeFile(settingsPath, JSON.stringify({ runtime: { mode: 'sqlite', sqlitePath: path } }));
    const process = Bun.spawn([
      processExecPath(),
      'run',
      join(import.meta.dir, 'trace-session.ts'),
      'view',
      'session',
      'session-1',
      '--settings',
      settingsPath,
      '--json',
      '--no-cache',
    ], {
      cwd: join(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({
      target: { kind: 'session', requestedId: 'session-1' },
      rootRuns: [{ rootRunId: 'root-1' }],
    });
  });
});

function run(overrides: Record<string, unknown>): Record<string, unknown> {
  return { delegationDepth: 0, version: 0, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUSD: 0 }, ...overrides };
}

function insertRun(database: Database, record: Record<string, unknown>): void {
  const value = record as Record<string, string | number | null | undefined>;
  database.run('insert into agent_runs (id,session_id,root_run_id,parent_run_id,current_child_run_id,status,version,created_at,updated_at,record_json) values (?,?,?,?,?,?,?,?,?,?)', [value.id!, value.sessionId ?? null, value.rootRunId!, value.parentRunId ?? null, value.currentChildRunId ?? null, value.status!, value.version!, value.createdAt!, value.updatedAt!, JSON.stringify(record)]);
}

function insertEvent(database: Database, event: Record<string, unknown>): void {
  const value = event as Record<string, string | number | null | undefined>;
  database.run('insert into agent_events (id,run_id,plan_execution_id,seq,step_id,tool_call_id,event_type,schema_version,payload_json,created_at) values (?,?,?,?,?,?,?,?,?,?)', [value.id!, value.runId!, null, value.seq!, value.stepId ?? null, value.toolCallId ?? null, value.type!, 1, JSON.stringify(event.payload), value.createdAt!]);
}

function createCoreRuntimeSchema(database: Database): void {
  database.exec(`
    create table adaptive_agent_migrations (version integer primary key, name text not null unique, applied_at text not null);
    insert into adaptive_agent_migrations values (1, 'core:001_runtime_sqlite', '2026-07-01T00:00:00.000Z');
    create table agent_runs (id text primary key, session_id text, root_run_id text not null references agent_runs(id), parent_run_id text references agent_runs(id), current_child_run_id text references agent_runs(id), status text not null, lease_owner text, lease_expires_at text, heartbeat_at text, version integer not null, created_at text not null, updated_at text not null, record_json text not null check(json_valid(record_json)));
    create table plans (id text primary key, created_from_run_id text references agent_runs(id), parent_plan_id text references plans(id), created_at text not null, record_json text not null check(json_valid(record_json)));
    create table plan_executions (id text primary key, plan_id text not null references plans(id), run_id text not null references agent_runs(id), attempt integer not null, status text not null, created_at text not null, updated_at text not null, record_json text not null check(json_valid(record_json)));
    create table agent_events (id text primary key, run_id text not null references agent_runs(id), plan_execution_id text references plan_executions(id), seq integer not null, step_id text, tool_call_id text, event_type text not null, schema_version integer not null, payload_json text not null check(json_valid(payload_json)), created_at text not null);
    create table run_snapshots (id text primary key, run_id text not null references agent_runs(id), snapshot_seq integer not null, status text not null, created_at text not null, record_json text not null check(json_valid(record_json)));
    create table tool_executions (idempotency_key text primary key, run_id text not null references agent_runs(id), step_id text not null, tool_call_id text not null, status text not null, child_run_id text references agent_runs(id), started_at text not null, completed_at text, record_json text not null check(json_valid(record_json)));
  `);
}

function processExecPath(): string {
  return process.execPath;
}
