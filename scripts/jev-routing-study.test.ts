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

  it('limits history by the latest distinct non-null sessions', async () => {
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
    database.close();

    const latest = extractHistoricalCases(fixture.databasePath, { limit: 1 });
    const exact = extractHistoricalCases(fixture.databasePath, { sessionIds: ['session-exact'] });

    expect(latest.map((item) => [item.sessionId, item.runId])).toEqual([
      ['session-approx', 'execution-approx-2'],
      ['session-approx', 'execution-approx'],
    ]);
    expect(exact.map((item) => [item.sessionId, item.runId])).toEqual([
      ['session-exact', 'execution-exact'],
    ]);
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
  database.query('INSERT INTO agent_runs VALUES (?, ?, ?, ?, ?)').run(id, sessionId, JSON.stringify(record), createdAt, updatedAt);
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
