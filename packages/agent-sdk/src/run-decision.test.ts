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
  vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
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
