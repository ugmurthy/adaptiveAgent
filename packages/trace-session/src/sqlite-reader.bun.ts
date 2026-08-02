import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';

import { SqliteTraceReader, TraceService } from './trace-session/reader.js';
import type { CliOptions } from './trace-session/types.js';

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
  insertEvent(database, { id: 'event-3', runId: 'child-1', seq: 1, type: 'run.completed', payload: {}, createdAt: '2026-07-01T10:00:03.000Z' });

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
      expect(report.warnings.join(' ')).toMatch(/External tool provider accounting is unavailable/);

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
        { provider: 'unknown', model: 'unknown', runCount: 1 },
      ]);
      expect(usage.toolOutputByProviderModel).toMatchObject([
        { provider: 'mesh', model: 'tool-model', toolCallCount: 1, usage: { totalTokens: 8, estimatedCostUSD: 0.01 } },
      ]);

      expect(await service.listSessions()).toMatchObject([{ sessionId: 'session-1', status: 'succeeded' }]);
      const performance = await service.listPerformance();
      expect(performance).toHaveLength(1);
      expect(performance[0]).toMatchObject({ rootRunId: 'root-1', totalDurationMs: 5_000 });
      expect(performance[0]!.performance.tools.started).toBe(1);

      const aggregate = await service.aggregate({ groupBy: 'model' });
      expect(aggregate.population).toMatchObject({ runCount: 1, terminalRuns: 1, missingUsage: 0, missingCost: 1 });
      expect(aggregate.groups[0]?.key).toBe('openrouter/test-model');
      expect(aggregate.notes.join(' ')).toMatch(/no external tool provider accounting/i);
      expect(await service.listSessionless()).toEqual([]);
    } finally {
      await service.close();
    }
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
