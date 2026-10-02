import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { AgentSdk } from './index.js';
import { validateSettings } from './config-validate.js';
import { agentSelectionMetadata, decideAutomaticRun, executionRoutingMetadata } from './run-decision.js';

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it('requires a dedicated selector profile for the TypeSafe agent fallback', () => {
  expect(() => validateSettings({ agent: { mode: 'auto' }, agentSelection: {
    engine: 'typesafe', typesafe: {}, lowConfidenceFallback: 'agent',
  } }, 'settings.json')).toThrow('settings.agentSelection.agent is required');
  expect(() => validateSettings({ agentSelection: { lowConfidenceFallback: 'direct' } }, 'settings.json'))
    .toThrow(/must be equal to one of the allowed values/);
  expect(validateSettings({ agent: { mode: 'auto' }, agentSelection: {
    engine: 'typesafe', typesafe: {}, agent: './selector.json', lowConfidenceFallback: 'agent',
  } }, 'settings.json').agentSelection?.lowConfidenceFallback).toBe('agent');
  expect(() => validateSettings({ agentSelection: { engine: 'typesafe', typesafe: {} },
    executionRouting: { mode: 'adaptive', lowConfidenceFallback: 'direct' },
  }, 'settings.json')).toThrow('"direct" is not supported with the TypeSafe engine');
});

async function fixture(adaptive: boolean, fallback?: 'agent' | 'error', selectorConfigured = true) {
  const cwd = await mkdtemp(join(tmpdir(), 'run-decision-'));
  directories.push(cwd);
  const profile = (id: string) => ({ id, name: id, invocationModes: ['run'], defaultInvocationMode: 'run', model: { provider: 'ollama', model: 'test' }, tools: [] });
  await Promise.all(['bootstrap', 'selector', 'researcher'].map((id) => writeFile(join(cwd, `${id}.json`), JSON.stringify(profile(id)))));
  const settings = {
    runtime: { mode: 'memory' as const },
    agents: { dirs: [cwd] },
    agent: { mode: 'auto' as const, configPath: './bootstrap.json' },
    agentSelection: {
      engine: 'typesafe' as const,
      ...(selectorConfigured ? { agent: './selector.json' } : {}),
      ...(fallback ? { lowConfidenceFallback: fallback } : {}),
      typesafe: { apiKeyEnv: 'TEST_TYPESAFE_API_KEY', model: 'jev-1.13.0', policy: { minimumConfidence: 0.7 } },
    },
    executionRouting: { mode: adaptive ? 'adaptive' as const : 'single' as const },
    taskPreparation: { mode: 'auto' as const, agent: './preparer.json' },
  };
  await writeFile(join(cwd, 'agent.settings.json'), JSON.stringify(settings));
  const fallbackSdk = {
    config: { agent: profile('bootstrap'), workspaceRoot: cwd, settings },
    agentPath: join(cwd, 'bootstrap.json'),
    created: { runtime: {} },
  } as unknown as AgentSdk;
  return { cwd, fallbackSdk };
}

it.each([[false, undefined], [true, undefined], [false, 'agent'], [true, 'agent']] as const)(
  'uses the named selector agent after low-confidence TypeSafe decision (adaptive=%s, fallback=%s)', async (adaptive, fallback) => {
  const { cwd, fallbackSdk } = await fixture(adaptive, fallback);
  const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { questions: Record<string, unknown>; state: { candidates: Array<{ id: string }> } };
    const answers = Object.fromEntries(Object.keys(request.questions).map((key) => {
      if (key === 'selection' || key === 'direct_primary') return [key, { type: 'choice', choice: 'researcher', confidence: 0.2, probabilities: { researcher: 0.2 } }];
      if (key === 'execution_mode') return [key, { type: 'choice', choice: 'direct', confidence: 0.2, probabilities: { direct: 0.2 } }];
      return [key, { type: 'noul', noul: 0.9 }];
    }));
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetch);
  const runRaw = vi.fn(async (_goal: string, options: { sessionId: string }) => ({
    status: 'success' as const,
    runId: 'selector-run',
    output: adaptive
      ? { mode: 'direct', primaryAgentId: 'researcher', assignments: [{ agentId: 'researcher', modalities: ['text'], reason: 'Best fit.' }], reason: 'Best fit.', confidence: 0.95 }
      : { selectedAgentId: 'researcher', reason: 'Best fit.' },
  }));
  const close = vi.fn(async () => undefined);
  const create = vi.spyOn(AgentSdk, 'create').mockResolvedValue({
    config: { agent: profileForRunner() }, runRaw, close,
  } as unknown as AgentSdk);
  const decision = await decideAutomaticRun({
    fallbackSdk, sdkOptions: { cwd, env: { TEST_TYPESAFE_API_KEY: 'test-key' } }, cwd,
    originalObjective: 'Research this', attachments: { images: [], files: [], audio: [] }, sessionId: 'same-session',
  });

  expect(fetch).toHaveBeenCalledOnce();
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ agentConfigPath: './selector.json', runtime: fallbackSdk.created.runtime }));
  expect(runRaw).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ sessionId: 'same-session' }));
  expect(close).toHaveBeenCalledOnce();
  expect(decision).toMatchObject(adaptive
    ? { kind: 'routing', routing: { routerId: 'selector', decision: { primaryAgentId: 'researcher', source: 'agent' } } }
    : { kind: 'selection', selection: { selectedAgentId: 'researcher', selectionAgentId: 'selector' } });
  if (decision.kind === 'selection') {
    expect(agentSelectionMetadata(decision.selection)).toMatchObject({
      selectedAgentId: 'researcher', selectionAgentId: 'selector',
      rejectedTypeSafe: { threshold: 'confidence', minimum: 0.7, decision: {
        selectedAgentId: 'researcher', confidence: 0.2, relevance: 0.9,
        policy: { source: 'inline', hash: createHash('sha256').update('{"minimumConfidence":0.7}').digest('hex') },
        probabilities: { researcher: 0.2 }, selectionModel: 'jev-1.13.0',
      } },
    });
  } else {
    expect(executionRoutingMetadata(decision.routing)).toMatchObject({
      source: 'agent', rejectedTypeSafe: { threshold: 'confidence', minimum: 0.7,
        choiceConfidence: 0.2, relevance: 0.9, model: 'jev-1.13.0',
        policy: { source: 'inline', hash: createHash('sha256').update('{"minimumConfidence":0.7}').digest('hex') },
        decision: { mode: 'direct', primaryAgentId: 'researcher', source: 'typesafe' },
      },
    });
  }
  },
);

function profileForRunner() { return { id: 'selector', name: 'selector', tools: [], delegates: [] }; }

it('validates the adaptive TypeSafe routing strategy', () => {
  for (const routingStrategy of ['combined', 'staged']) {
    expect(validateSettings({ agentSelection: { typesafe: { routingStrategy } } }, 'settings.json')
      .agentSelection?.typesafe?.routingStrategy).toBe(routingStrategy);
  }
  expect(() => validateSettings({ agentSelection: { typesafe: { routingStrategy: 'other' } } }, 'settings.json'))
    .toThrow(/must be equal to one of the allowed values/);
});

it.each([
  ['direct', 'success'], ['orchestration', 'success'],
  ['direct', 'mode'], ['direct', 'confidence'], ['direct', 'relevance'],
  ['orchestration', 'confidence'], ['orchestration', 'relevance'],
  ['direct', 'disabled'],
] as const)('staged production routing preserves %s / %s scores and usage', async (mode, outcome) => {
  const { cwd, fallbackSdk } = await fixture(true, outcome === 'disabled' ? 'error' : 'agent');
  const config = fallbackSdk.config.settings.agentSelection!.typesafe!;
  config.routingStrategy = 'staged';
  config.policy = { minimumConfidence: 0.7, minimumRelevance: 0.3 };
  const calls: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    calls.push(request.questions);
    const modeStage = Object.keys(request.questions).length === 1;
    const confidence = modeStage ? (outcome === 'mode' ? 0.6 : 0.91)
      : outcome === 'confidence' || outcome === 'disabled' ? 0.65 : 0.83;
    const answers = Object.fromEntries(Object.keys(request.questions).map((key) => {
      const choice = key === 'execution_mode' ? mode : key === 'orchestration_primary' ? 'bootstrap' : 'researcher';
      return [key, request.questions[key].type === 'choice'
        ? { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } }
        : { type: 'noul', noul: outcome === 'relevance' ? 0.25 : 0.42 }];
    }));
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers,
      usage: { input_tokens: modeStage ? 101 : 233, output_tokens: modeStage ? 7 : 19 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const runRaw = vi.fn(async () => ({ status: 'success', runId: 'fallback-run', output: {
    mode: 'direct', primaryAgentId: 'researcher', assignments: [{ agentId: 'researcher', modalities: ['text'], reason: 'Fallback.' }],
    reason: 'Fallback.', confidence: 0.95,
  } }));
  const create = vi.spyOn(AgentSdk, 'create').mockResolvedValue({
    config: { agent: profileForRunner() }, runRaw, close: vi.fn(),
  } as unknown as AgentSdk);
  const promise = decideAutomaticRun({ fallbackSdk, sdkOptions: { cwd, env: { TEST_TYPESAFE_API_KEY: 'test-key' } }, cwd,
    originalObjective: 'Research this', attachments: { images: [], files: [], audio: [] }, sessionId: 'session',
  });
  if (outcome === 'disabled') {
    await expect(promise).rejects.toMatchObject({ stagedAttempt: {
      threshold: 'confidence', choiceConfidence: 0.65, usage: { inputTokens: 334, outputTokens: 26 },
    } });
    expect(create).not.toHaveBeenCalled();
    return;
  }
  const decision = await promise;
  expect(calls[0]).toHaveProperty('execution_mode');
  expect(Object.keys(calls[0]!)).toEqual(['execution_mode']);
  expect(calls).toHaveLength(outcome === 'mode' ? 1 : 2);
  if (calls[1]) {
    expect(calls[1]).not.toHaveProperty('execution_mode');
    expect(calls[1]).toHaveProperty(mode === 'direct' ? 'selection' : 'assignment_text');
  }
  expect(decision.kind).toBe('routing');
  if (decision.kind !== 'routing') throw new Error('Expected routing');
  const metadata = executionRoutingMetadata(decision.routing);
  if (outcome === 'success') {
    expect(create).not.toHaveBeenCalled();
    expect(metadata).toMatchObject({ mode, source: 'typesafe', confidence: 0.42, choiceConfidence: 0.83,
      relevance: 0.42, typesafe: { usage: { inputTokens: 334, outputTokens: 26 } },
      stages: [{ name: 'mode', confidence: 0.91, usage: { inputTokens: 101, outputTokens: 7 } },
        { name: mode === 'direct' ? 'selection' : 'assignments', confidence: 0.83, relevance: 0.42 }],
    });
  } else {
    expect(create).toHaveBeenCalledOnce();
    expect(metadata).toMatchObject({ source: 'agent', rejectedStagedTypeSafe: {
      mode, threshold: outcome === 'relevance' ? 'relevance' : 'confidence',
      minimum: outcome === 'relevance' ? 0.3 : 0.7,
      policy: { source: 'inline', hash: createHash('sha256').update(JSON.stringify(config.policy)).digest('hex') },
      usage: { inputTokens: outcome === 'mode' ? 101 : 334, outputTokens: outcome === 'mode' ? 7 : 26 },
      ...(outcome === 'mode' ? {} : { decision: { mode, source: 'typesafe' }, relevance: outcome === 'relevance' ? 0.25 : 0.42 }),
    } });
    if (outcome === 'mode') expect(decision.routing.rejectedStagedTypeSafe).not.toHaveProperty('decision');
  }
});

it.each([true, false])('errors on low TypeSafe confidence when selector is unavailable or disabled (configured=%s)', async (selectorConfigured) => {
  const { cwd, fallbackSdk } = await fixture(false, selectorConfigured ? 'error' : undefined, selectorConfigured);
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
    model: 'jev-1.13.0', answers: {
      candidate_0_relevant: { type: 'noul', noul: 0.9 },
      candidate_1_relevant: { type: 'noul', noul: 0.9 },
      candidate_2_relevant: { type: 'noul', noul: 0.9 },
      selection: { type: 'choice', choice: 'researcher', confidence: 0.2, probabilities: { researcher: 0.2 } },
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const create = vi.spyOn(AgentSdk, 'create');
  await expect(decideAutomaticRun({
    fallbackSdk, sdkOptions: { cwd, env: { TEST_TYPESAFE_API_KEY: 'test-key' } }, cwd,
    originalObjective: 'Research this', attachments: { images: [], files: [], audio: [] }, sessionId: 'same-session',
  })).rejects.toThrow(/confidence 0.200 is below/);
  expect(create).not.toHaveBeenCalled();
});

it('records the default policy when TypeSafe has no policy or policyPath', async () => {
  const { cwd, fallbackSdk } = await fixture(false, 'error');
  fallbackSdk.config.settings.agentSelection!.typesafe!.policy = undefined;
  // The staged opt-in must not turn a nonadaptive run into mode-first routing.
  fallbackSdk.config.settings.agentSelection!.typesafe!.routingStrategy = 'staged';
  vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
    expect(request.questions).not.toHaveProperty('execution_mode');
    expect(request.questions.candidate_0_relevant).toMatchObject({
      instructions: { question: 'Is the referenced candidate agent a strong match for the objective and every requested attachment modality?' },
    });
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: {
      ...Object.fromEntries(Object.keys(request.questions).filter((key) => key.endsWith('_relevant'))
        .map((key) => [key, { type: 'noul', noul: 0.85 }])),
      selection: { type: 'choice', choice: 'researcher', confidence: 0.9, probabilities: { researcher: 0.9 } },
    } }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const decision = await decideAutomaticRun({
    fallbackSdk, sdkOptions: { cwd, env: { TEST_TYPESAFE_API_KEY: 'test-key' } }, cwd,
    originalObjective: 'Research this', attachments: { images: [], files: [], audio: [] }, sessionId: 'session',
  });
  expect(decision.kind).toBe('selection');
  if (decision.kind === 'selection') {
    expect(agentSelectionMetadata(decision.selection)).toMatchObject({
      policy: { source: 'default', hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
  }
});
