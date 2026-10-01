import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';

import type { TypeSafeAgentSelectionClient, TypeSafeAgentSelectionResponse } from '../packages/agent-sdk/src/index.js';
import { extractHistoricalCases, modalityMarker, runStudy } from './jev-routing-study.js';

let directory: string | undefined;

describe('JEV routing study', () => {
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('replays exact and approximate history with disagreement, low-confidence, cost, and latency metrics', async () => {
    const fixture = await createFixture();
    const databaseBefore = await readFile(fixture.databasePath);
    const times = [100, 127, 200, 241];
    const evaluator = fakeEvaluator((objective) => objective === 'Original exact objective'
      ? { selected: 'exact-beta', confidence: 0.4, relevance: 0.8 }
      : { selected: 'current-b', confidence: 0.9, relevance: 0.95 });

    const results = await runStudy({
      mode: 'history',
      settingsPath: fixture.settingsPath,
      databasePath: fixture.databasePath,
      allowCurrentCatalog: true,
      sessionIds: ['session-exact', 'session-approx'],
      repeat: 1,
      inputPricePerMillion: 0.042,
      cachePath: fixture.cachePath,
      refresh: true,
      showState: true,
      showResponse: false,
      evaluator,
      clockMs: () => times.shift()!,
    });

    expect(results[0]).toMatchObject({
      runId: 'execution-exact',
      sessionId: 'session-exact',
      objective: 'Original exact objective',
      modalities: 'IAF',
      existingSelection: 'exact-alpha',
      jevSelection: 'exact-beta',
      agreement: false,
      confidence: 0.4,
      relevance: 0.8,
      accepted: false,
      latencyMs: 27,
      inputTokens: 1000,
      outputTokens: 5,
      estimatedCostUSD: 0.000042,
      contextQuality: 'exact',
      existing: {
        modelLatencyMs: 70,
        elapsedMs: 100,
        inputTokens: 80,
        outputTokens: 9,
        estimatedCostUSD: 0.004,
      },
    });
    expect(results[0]!.margin).toBeCloseTo(0.2);
    expect(results[0]!.policy).toMatchObject({ source: 'inline', hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(results[1]).toMatchObject({
      runId: 'execution-approx',
      sessionId: 'session-approx',
      objective: 'Approximate goal',
      modalities: '-',
      existingSelection: 'current-a',
      jevSelection: 'current-b',
      agreement: false,
      accepted: true,
      latencyMs: 41,
      contextQuality: 'approximate-current-catalog',
    });
    expect(JSON.stringify(results[0]!.state)).not.toContain('/private/');
    const cache = await readFile(fixture.cachePath, 'utf8');
    expect(cache).not.toContain('Original exact objective');
    expect(cache).not.toContain('/private/');
    expect(await readFile(fixture.databasePath)).toEqual(databaseBefore);
  });

  it('marks prompt modality combinations in IAF order and text-only prompts with a dash', async () => {
    const fixture = await createFixture();
    const evaluator = fakeEvaluator(() => ({ selected: 'current-b', confidence: 0.9, relevance: 0.9 }));
    const common = {
      mode: 'prompt' as const,
      settingsPath: fixture.settingsPath,
      allowCurrentCatalog: true,
      repeat: 1,
      inputPricePerMillion: 0.042,
      refresh: true,
      showState: false,
      showResponse: false,
      evaluator,
      clockMs: (() => { let time = 0; return () => time += 5; })(),
    };

    const combined = await runStudy({
      ...common,
      prompt: 'Inspect all attachments',
      attachmentTypes: ['file', 'audio', 'image'],
      cachePath: join(directory!, 'combined.jsonl'),
    });
    const textOnly = await runStudy({
      ...common,
      prompt: 'Answer a text question',
      attachmentTypes: [],
      cachePath: join(directory!, 'text.jsonl'),
    });

    expect(combined[0]!.modalities).toBe('IAF');
    expect(textOnly[0]!.modalities).toBe('-');
    expect(modalityMarker({ images: [], audio: ['a', 'b'], files: ['f'] })).toBe('AF');
  });

  it('uses the Agent SDK staged adaptive path when configured without changing production routing', async () => {
    const fixture = await createFixture();
    const settings = JSON.parse(await readFile(fixture.settingsPath, 'utf8')) as Record<string, unknown>;
    settings.executionRouting = { mode: 'adaptive', maxSpecialists: 2 };
    await writeFile(fixture.settingsPath, JSON.stringify(settings));
    const requests: Array<Parameters<TypeSafeAgentSelectionClient['evaluate']>[0]> = [];
    const evaluator: TypeSafeAgentSelectionClient = { async evaluate(request) {
      requests.push(request);
      return requests.length === 1
        ? { model: request.model, answers: { execution_mode: { type: 'choice', choice: 'direct', confidence: 0.82, probabilities: { direct: 0.82, orchestration: 0.18 } } },
          usage: { input_tokens: 40, output_tokens: 4 } }
        : { model: request.model, answers: {
          candidate_0_relevant: { type: 'noul', noul: 0.91 },
          candidate_1_relevant: { type: 'noul', noul: 0.86 },
          selection: { type: 'choice', choice: 'current-a', confidence: 0.89, probabilities: { 'current-a': 0.89, 'current-b': 0.11 } },
        }, usage: { input_tokens: 80, output_tokens: 8 } };
    } };
    const results = await runStudy({ mode: 'prompt', prompt: 'Implement a code change',
      settingsPath: fixture.settingsPath, allowCurrentCatalog: true, repeat: 1,
      inputPricePerMillion: 0.042, cachePath: fixture.cachePath, refresh: true,
      showState: true, showResponse: true, evaluator });
    expect(requests.map((request) => Object.keys(request.questions))).toEqual([
      ['execution_mode'], ['candidate_0_relevant', 'candidate_1_relevant', 'selection'],
    ]);
    expect(results[0]).toMatchObject({ routingMode: 'direct', jevSelection: 'current-a', confidence: 0.82,
      relevance: 0.91, inputTokens: 120, outputTokens: 12, accepted: true,
      assignments: [{ agentId: 'current-a', modalities: ['text'] }],
      stages: [{ name: 'mode', confidence: 0.82 }, { name: 'selection', confidence: 0.89 }] });
    expect((results[0]!.state as unknown[])).toHaveLength(2);
    expect((results[0]!.response as unknown[])).toHaveLength(2);
    expect(await readFile(fixture.cachePath, 'utf8')).not.toContain('Implement a code change');
  });

  it('compares both primary profile and mode for historical adaptive runs', async () => {
    const fixture = await createFixture();
    const settings = JSON.parse(await readFile(fixture.settingsPath, 'utf8')) as Record<string, unknown>;
    settings.executionRouting = { mode: 'adaptive', maxSpecialists: 2 };
    await writeFile(fixture.settingsPath, JSON.stringify(settings));
    const database = new Database(fixture.databasePath, { strict: true });
    insertRun(database, 'routed', 'session-routed', {
      goal: 'Implement a change', metadata: { executionRouting: { mode: 'orchestration', primaryAgentId: 'current-a' } },
    });
    database.close();
    const evaluator: TypeSafeAgentSelectionClient = { async evaluate(request) {
      return Object.hasOwn(request.questions, 'execution_mode')
        ? { model: request.model, answers: { execution_mode: { type: 'choice', choice: 'direct', confidence: 0.9,
          probabilities: { direct: 0.9, orchestration: 0.1 } } } }
        : { model: request.model, answers: { candidate_0_relevant: { type: 'noul', noul: 0.9 },
          candidate_1_relevant: { type: 'noul', noul: 0.8 },
          selection: { type: 'choice', choice: 'current-a', confidence: 0.9,
            probabilities: { 'current-a': 0.9, 'current-b': 0.1 } } } };
    } };
    const results = await runStudy({ mode: 'history', settingsPath: fixture.settingsPath,
      databasePath: fixture.databasePath, sessionIds: ['session-routed'], allowCurrentCatalog: true,
      repeat: 1, inputPricePerMillion: 0.042, cachePath: fixture.cachePath, refresh: true,
      showState: false, showResponse: false, evaluator });
    expect(results[0]).toMatchObject({ existingSelection: 'current-a', existingRoutingMode: 'orchestration',
      jevSelection: 'current-a', routingMode: 'direct', agreement: false, contextQuality: 'approximate-current-catalog' });
  });

  it('limits history by the latest distinct non-null sessions, not the latest routed sessions', async () => {
    const fixture = await createFixture();
    const database = new Database(fixture.databasePath, { strict: true });
    insertRun(database, 'execution-approx-2', 'session-approx', {
      goal: 'Another routed run in the latest session',
      metadata: { agentSelection: { selectedAgentId: 'current-a' } },
    }, '2026-01-04T00:00:00.000Z', '2026-01-04T00:00:00.001Z');
    insertRun(database, 'execution-without-session', null, {
      goal: 'Newer routed run without a session',
      metadata: { agentSelection: { selectedAgentId: 'current-a' } },
    }, '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.001Z');
    insertRun(database, 'execution-unrouted', 'session-new', {
      goal: 'A newer session without agent selection',
    }, '2026-01-06T00:00:00.000Z', '2026-01-06T00:00:00.001Z');
    insertRun(database, 'execution-exact-followup', 'session-exact', {
      goal: 'Recent activity in an older routed session',
    }, '2026-01-07T00:00:00.000Z', '2026-01-07T00:00:00.001Z');
    insertRun(database, 'selector-new', 'session-new', {
      goal: 'Select agent', metadata: { command: 'agent-selection', agentSelection: { role: 'selector' } },
    }, '2026-01-06T00:00:01.000Z');
    database.close();

    const latest = extractHistoricalCases(fixture.databasePath, { limit: 1 });
    const latestTwo = extractHistoricalCases(fixture.databasePath, { limit: 2 });
    const latestThree = extractHistoricalCases(fixture.databasePath, { limit: 3 });
    const exact = extractHistoricalCases(fixture.databasePath, { sessionIds: ['session-exact'] });

    expect(latest.map((item) => [item.sessionId, item.runId])).toEqual([
      ['session-exact', 'execution-exact-followup'],
      ['session-exact', 'execution-exact'],
    ]);
    expect(latestTwo.map((item) => item.runId)).toEqual(['execution-exact-followup', 'execution-exact', 'execution-unrouted']);
    expect(latestThree.map((item) => [item.sessionId, item.runId])).toEqual([
      ['session-exact', 'execution-exact-followup'],
      ['session-exact', 'execution-exact'],
      ['session-new', 'execution-unrouted'],
      ['session-approx', 'execution-approx-2'],
      ['session-approx', 'execution-approx'],
    ]);
    expect(exact.map((item) => [item.sessionId, item.runId])).toEqual([
      ['session-exact', 'execution-exact-followup'],
      ['session-exact', 'execution-exact'],
    ]);
  });

  it('reports accepted and rejected persisted JEV decisions without evaluating, even with --refresh', async () => {
    const fixture = await createFixture();
    const database = new Database(fixture.databasePath, { strict: true });
    insertRun(database, 'accepted-jev', 'session-accepted', {
      goal: 'Accepted objective', metadata: { agentSelection: {
        selectedAgentId: 'current-a', selectionModel: 'jev-test', confidence: 0.9, relevance: 0.8,
        probabilities: { 'current-a': 0.9, 'current-b': 0.1 },
        typesafe: { usage: { inputTokens: 100, outputTokens: 7 } },
      } },
    });
    insertRun(database, 'rejected-jev', 'session-rejected', {
      goal: 'Rejected objective', metadata: { agentSelection: {
        selectedAgentId: 'current-b', selectionRunId: 'selector-1',
        rejectedTypeSafe: { threshold: 'confidence', minimum: 0.7, decision: {
          selectedAgentId: 'current-a', selectionModel: 'jev-test', confidence: 0.4, relevance: 0.85,
          probabilities: { 'current-a': 0.4, 'current-b': 0.6 },
        } },
      } },
    });
    database.close();
    const evaluator: TypeSafeAgentSelectionClient = { evaluate: () => { throw new Error('must not evaluate'); } };
    const common = { mode: 'history' as const, settingsPath: fixture.settingsPath, databasePath: fixture.databasePath,
      allowCurrentCatalog: false, sessionIds: ['session-accepted', 'session-rejected'], repeat: 1,
      inputPricePerMillion: 0.042, cachePath: fixture.cachePath, showState: false, showResponse: false, evaluator };
    const results = await runStudy({ ...common, refresh: true });
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ runId: 'accepted-jev', objective: 'Accepted objective', jevSelection: 'current-a',
      existingSelection: 'current-a', agreement: true, confidence: 0.9, relevance: 0.8, margin: 0.8,
      inputTokens: 100, outputTokens: 7, accepted: true, reportedOnly: true, cached: false });
    expect(results[1]).toMatchObject({ runId: 'rejected-jev', objective: 'Rejected objective', jevSelection: 'current-a',
      existingSelection: 'current-b', agreement: false, confidence: 0.4, relevance: 0.85,
      accepted: false, reportedOnly: true, cached: false });
    expect(results[0]!.estimatedCostUSD).toBeCloseTo(0.0000042);
    const process = Bun.spawn(['bun', 'scripts/jev-routing-study.ts', 'history', '--session-id', 'session-accepted',
      '--database', fixture.databasePath, '--settings', fixture.settingsPath, '--refresh'],
    { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' });
    expect(await process.exited).toBe(0);
    expect(await new Response(process.stdout).text()).toContain('│ approx  │ *      │');
    expect(await new Response(process.stderr).text()).toContain('reported only');
    const forced = Bun.spawn(['bun', 'scripts/jev-routing-study.ts', 'history', '--session-id', 'session-accepted',
      '--database', fixture.databasePath, '--settings', fixture.settingsPath,
      '--force-jev', '--no-allow-current-catalog'],
    { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' });
    expect(await forced.exited).toBe(1);
    expect(await new Response(forced.stderr).text()).toContain('no exact linked selector context');
  });

  it('forces a fresh evaluation instead of persisted JEV or study cache reuse', async () => {
    const fixture = await createFixture();
    const database = new Database(fixture.databasePath, { strict: true });
    insertRun(database, 'accepted-jev', 'session-accepted', { goal: 'Accepted objective', metadata: { agentSelection: {
      selectedAgentId: 'current-a', selectionModel: 'jev-test', confidence: 0.9, relevance: 0.8,
    } } });
    database.close();
    let calls = 0;
    const evaluator = fakeEvaluator(() => { calls += 1; return { selected: 'current-b', confidence: 0.8, relevance: 0.9 }; });
    const options = { mode: 'history' as const, settingsPath: fixture.settingsPath, databasePath: fixture.databasePath,
      allowCurrentCatalog: true, sessionIds: ['session-accepted'], repeat: 1, inputPricePerMillion: 0.042,
      cachePath: fixture.cachePath, refresh: false, showState: false, showResponse: false, evaluator };
    const first = await runStudy({ ...options, forceJev: true });
    const second = await runStudy({ ...options, forceJev: true });
    expect(calls).toBe(2);
    expect(first[0]).toMatchObject({ jevSelection: 'current-b', cached: false, accepted: true });
    expect(first[0]!.reportedOnly).toBeUndefined();
    expect(second[0]!.cached).toBe(false);
    const reported = await runStudy(options);
    expect(reported[0]).toMatchObject({ jevSelection: 'current-a', reportedOnly: true });
    expect(calls).toBe(2);
  });

  it('evaluates the original objective for recent sessions with no selection and agent-only selection', async () => {
    const fixture = await createFixture();
    const database = new Database(fixture.databasePath, { strict: true });
    insertRun(database, 'agent-only', 'session-agent-only', {
      goal: 'Prepared goal', metadata: {
        taskPreparation: { originalObjective: 'Original agent-only objective' },
        agentSelection: { selectedAgentId: 'current-a' },
      },
    }, '2026-01-06T00:00:00.000Z');
    insertRun(database, 'no-selection', 'session-no-selection', {
      goal: 'Original no-selection objective',
    }, '2026-01-07T00:00:00.000Z');
    insertRun(database, 'child', 'session-no-selection', { goal: 'Child goal' }, '2026-01-08T00:00:00.000Z');
    database.query("UPDATE agent_runs SET parent_run_id = 'no-selection' WHERE id = 'child'").run();
    database.close();
    const objectives: string[] = [];
    const evaluator = fakeEvaluator((objective) => {
      objectives.push(objective);
      return { selected: 'current-b', confidence: 0.8, relevance: 0.9 };
    });
    const results = await runStudy({ mode: 'history', settingsPath: fixture.settingsPath,
      databasePath: fixture.databasePath, allowCurrentCatalog: true, limit: 2, repeat: 1,
      inputPricePerMillion: 0.042, cachePath: fixture.cachePath, refresh: true,
      showState: false, showResponse: false, evaluator });
    expect(objectives).toEqual(['Original no-selection objective', 'Original agent-only objective']);
    expect(results.map((result) => [result.runId, result.existingSelection, result.jevSelection])).toEqual([
      ['no-selection', undefined, 'current-b'],
      ['agent-only', 'current-a', 'current-b'],
    ]);
  });

  it('uses a preparer original objective when execution is absent and reports sessions with no usable objective', async () => {
    const fixture = await createFixture();
    const database = new Database(fixture.databasePath, { strict: true });
    insertRun(database, 'selector-only', 'session-setup', {
      goal: 'Synthetic selector goal', metadata: { command: 'agent-selection',
        agentSelection: { originalObjective: 'Original setup objective' } },
    }, '2026-01-06T00:00:00.000Z');
    insertRun(database, 'preparer-only', 'session-setup', {
      goal: 'Synthetic preparer goal', metadata: { command: 'task-preparation',
        taskPreparation: { originalObjective: 'Original setup objective' } },
    }, '2026-01-06T00:00:01.000Z');
    insertRun(database, 'no-objective', 'session-empty', {
      goal: 'Synthetic selector goal', metadata: { command: 'agent-selection' },
    }, '2026-01-07T00:00:00.000Z');
    database.close();
    const objectives: string[] = [];
    const evaluator = fakeEvaluator((objective) => {
      objectives.push(objective);
      return { selected: 'current-b', confidence: 0.8, relevance: 0.9 };
    });
    const results = await runStudy({ mode: 'history', settingsPath: fixture.settingsPath,
      databasePath: fixture.databasePath, allowCurrentCatalog: true, limit: 2, repeat: 1,
      inputPricePerMillion: 0.042, cachePath: fixture.cachePath, refresh: true,
      showState: false, showResponse: false, evaluator });
    expect(objectives).toEqual(['Original setup objective']);
    expect(results[0]).toMatchObject({ runId: 'no-objective', sessionId: 'session-empty',
      error: 'Skipped: session has no usable original objective.' });
    expect(results[1]).toMatchObject({ runId: 'preparer-only', sessionId: 'session-setup',
      objective: 'Original setup objective', jevSelection: 'current-b' });
  });
});

async function createFixture(): Promise<{ settingsPath: string; databasePath: string; cachePath: string }> {
  directory = await mkdtemp(join(tmpdir(), 'jev-routing-study-'));
  const agents = join(directory, 'agents');
  const databasePath = join(directory, 'runtime.sqlite');
  const settingsPath = join(directory, 'agent.settings.json');
  await mkdir(agents);
  await writeAgent(join(agents, 'current-a.json'), 'current-a');
  await writeAgent(join(agents, 'current-b.json'), 'current-b');
  await writeFile(settingsPath, JSON.stringify({
    runtime: { mode: 'sqlite', sqlitePath: databasePath },
    agent: { mode: 'fixed', id: 'current-a', configPath: join(agents, 'current-a.json') },
    agents: { dirs: [agents] },
    agentSelection: {
      engine: 'typesafe',
      typesafe: {
        model: 'jev-test',
        policy: { minimumConfidence: 0.5, minimumRelevance: 0.5 },
      },
    },
  }));

  const database = new Database(databasePath, { create: true, strict: true });
  database.exec(`
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      parent_run_id TEXT,
      record_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE agent_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
  `);
  const historicalCandidates = [historicalCandidate('exact-alpha'), historicalCandidate('exact-beta')];
  insertRun(database, 'selector-1', null, {
    goal: 'Select an agent',
    createdAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:00.100Z',
    input: {
      originalObjective: 'Selector input objective',
      candidates: historicalCandidates,
      attachments: {
        images: ['/private/image.png'],
        audio: ['/private/audio.mp3'],
        files: ['/private/document.pdf'],
      },
    },
    result: { selectedAgentId: 'exact-alpha', reason: 'Historical choice' },
    usage: { promptTokens: 80, completionTokens: 9, estimatedCostUSD: 0.004 },
  }, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.125Z');
  database.query('INSERT INTO agent_events VALUES (?, ?, ?, ?, ?)').run(
    'event-1', 'selector-1', 2, 'model.completed', JSON.stringify({ durationMs: 70 }),
  );
  insertRun(database, 'execution-exact', 'session-exact', {
    goal: 'Prepared exact goal',
    metadata: {
      taskPreparation: { originalObjective: 'Original exact objective' },
      agentSelection: { selectionRunId: 'selector-1' },
    },
  }, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.001Z');
  insertRun(database, 'execution-approx', 'session-approx', {
    goal: 'Approximate goal',
    metadata: { agentSelection: { selectedAgentId: 'current-a' } },
  }, '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.001Z');
  database.close();
  return { settingsPath, databasePath, cachePath: join(directory, 'cache.jsonl') };
}

async function writeAgent(path: string, id: string): Promise<void> {
  await writeFile(path, JSON.stringify({
    version: 1,
    id,
    name: id,
    invocationModes: ['run'],
    defaultInvocationMode: 'run',
    model: { provider: 'ollama', model: 'fixture' },
    tools: [],
    capabilities: {
      modalitiesSupported: ['text', 'image', 'audio', 'file'],
      modalityRoles: { text: 'analyze', image: 'analyze', audio: 'analyze', file: 'analyze' },
    },
  }));
}

function historicalCandidate(id: string): Record<string, unknown> {
  return {
    id,
    name: id,
    description: `${id} description`,
    invocationModes: ['run'],
    defaultInvocationMode: 'run',
    tools: [],
    delegates: [],
    capabilities: { modalitiesSupported: ['text', 'image', 'audio', 'file'] },
  };
}

function insertRun(
  database: Database,
  id: string,
  sessionId: string | null,
  record: Record<string, unknown>,
  createdAt = '2026-01-02T00:00:00.000Z',
  updatedAt = '2026-01-02T00:00:00.001Z',
): void {
  database.query('INSERT INTO agent_runs VALUES (?, ?, NULL, ?, ?, ?)').run(id, sessionId, JSON.stringify(record), createdAt, updatedAt);
}

function fakeEvaluator(
  choose: (objective: string) => { selected: string; confidence: number; relevance: number },
): TypeSafeAgentSelectionClient {
  return {
    async evaluate(request): Promise<TypeSafeAgentSelectionResponse> {
      const state = request.state as { objective: string; candidates: Array<{ id: string }> };
      const choice = choose(state.objective);
      const probabilities = Object.fromEntries(state.candidates.map((candidate) => [
        candidate.id,
        candidate.id === choice.selected ? choice.confidence : (1 - choice.confidence) / (state.candidates.length - 1),
      ]));
      const answers: TypeSafeAgentSelectionResponse['answers'] = {};
      state.candidates.forEach((candidate, index) => {
        answers[`candidate_${index}_relevant`] = {
          type: 'noul',
          noul: candidate.id === choice.selected ? choice.relevance : 0.2,
        };
      });
      if (state.candidates.length > 1) {
        answers.selection = { type: 'choice', choice: choice.selected, confidence: choice.confidence, probabilities };
      }
      return { model: request.model, answers, usage: { input_tokens: 1000, output_tokens: 5 } };
    },
  };
}
