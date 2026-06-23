import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AgentConfigFile, AgentSdkRunOptions, SupportedModality } from './index.js';
import { buildOrchestrationPlan, createOrchestrationSdk, type AgentCatalogEntry, type OrchestrationAgentRunner, type OrchestrationLifecycleEvent } from './orchestration.js';

describe('orchestration sdk', () => {
  it('builds a single-node plan when requested agent supports all modalities', () => {
    const catalog = catalogFor([agent('general', ['text', 'image'])]);

    const plan = buildOrchestrationPlan({
      sessionId: 'session-1',
      requestedAgentId: 'general',
      goal: 'describe this image',
      options: { images: [{ path: '/tmp/image.png' }] },
      catalog,
      finalizeWithRequestedAgent: true,
    });

    expect(plan.executionShape).toBe('single');
    expect(plan.nodes).toEqual([
      expect.objectContaining({ id: 'requested', agentId: 'general', stage: 'single', dependsOn: [] }),
    ]);
  });

  it('builds parallel specialist nodes followed by requested-agent synthesis', () => {
    const catalog = catalogFor([
      agent('general', ['text']),
      agent('image-analyst', ['text', 'image'], ['image']),
      agent('audio-analyst', ['text', 'audio'], ['audio']),
    ]);

    const plan = buildOrchestrationPlan({
      sessionId: 'session-1',
      requestedAgentId: 'general',
      goal: 'compare the image and audio',
      options: multimodalOptions(),
      catalog,
      finalizeWithRequestedAgent: true,
    });

    expect(plan.executionShape).toBe('parallel_fanout_then_synthesis');
    expect(plan.nodes.map((node) => [node.id, node.agentId, node.dependsOn])).toEqual([
      ['image_specialist', 'image-analyst', []],
      ['audio_specialist', 'audio-analyst', []],
      ['final_synthesis', 'general', ['image_specialist', 'audio_specialist']],
    ]);
  });

  it('routes supported but non-preferred modalities to a stronger specialist', () => {
    const catalog = catalogFor([
      agent('general', ['text', 'image'], ['text']),
      agent('image-analyst', ['text', 'image'], ['image']),
    ]);

    const plan = buildOrchestrationPlan({
      sessionId: 'session-1',
      requestedAgentId: 'general',
      goal: 'describe this image',
      options: { images: [{ path: '/tmp/image.png' }] },
      catalog,
      finalizeWithRequestedAgent: true,
    });

    expect(plan.executionShape).toBe('sequential');
    expect(plan.nodes.map((node) => [node.id, node.agentId, node.dependsOn])).toEqual([
      ['image_specialist', 'image-analyst', []],
      ['final_synthesis', 'general', ['image_specialist']],
    ]);
  });

  it('routes text-only subject requests to a matching domain specialist', () => {
    const catalog = catalogFor([
      agent('general', ['text']),
      agent('legal-analyst', ['text'], [], ['contract law'], ['indemnity', 'warranty']),
    ]);

    const plan = buildOrchestrationPlan({
      sessionId: 'session-1',
      requestedAgentId: 'general',
      goal: 'Analyze this contract law question and summarize the indemnity risk.',
      options: {},
      catalog,
      finalizeWithRequestedAgent: true,
    });

    expect(plan.detectedSubjects).toEqual(['contract law']);
    expect(plan.routingDiagnostics.subjectCandidates).toEqual([
      { agentId: 'general', score: 0, matchedSubjects: [], matchedKeywords: [], selected: false, requestedAgent: true },
      { agentId: 'legal-analyst', score: 6, matchedSubjects: ['contract law'], matchedKeywords: ['indemnity'], selected: true, requestedAgent: false },
    ]);
    expect(plan.executionShape).toBe('sequential');
    expect(plan.nodes.map((node) => [node.id, node.agentId, node.stage, node.dependsOn])).toEqual([
      ['subject_contract_law_specialist', 'legal-analyst', 'subject_specialist', []],
      ['final_synthesis', 'general', 'final_synthesis', ['subject_contract_law_specialist']],
    ]);
    expect(plan.nodes[0]?.inputSelector).toEqual({ includeGoal: true });
  });

  it('does not route to a subject specialist when the requested agent has an equal subject match', () => {
    const catalog = catalogFor([
      agent('general', ['text'], [], ['contract law']),
      agent('legal-analyst', ['text'], [], ['contract law']),
    ]);

    const plan = buildOrchestrationPlan({
      sessionId: 'session-1',
      requestedAgentId: 'general',
      goal: 'Summarize this contract law issue.',
      options: {},
      catalog,
      finalizeWithRequestedAgent: true,
    });

    expect(plan.executionShape).toBe('single');
    expect(plan.nodes).toEqual([
      expect.objectContaining({ id: 'requested', agentId: 'general', stage: 'single', dependsOn: [] }),
    ]);
  });

  it('executes independent specialist root runs before final synthesis', async () => {
    const calls: Array<{ agentId: string; goal: string; options: AgentSdkRunOptions }> = [];
    const events: OrchestrationLifecycleEvent[] = [];
    const sdk = await createOrchestrationSdk({
      agentCatalog: [
        { agentId: 'general', agentConfig: agent('general', ['text']) },
        { agentId: 'image-analyst', agentConfig: agent('image-analyst', ['text', 'image'], ['image']) },
        { agentId: 'audio-analyst', agentConfig: agent('audio-analyst', ['text', 'audio'], ['audio']) },
      ],
      requestedAgentConfig: agent('general', ['text']),
      sessionIdFactory: () => 'session-1',
      agentRunnerFactory: async (agentId) => fakeRunner(agentId, calls),
      orchestrationListener: (event) => events.push(event),
    });

    const result = await sdk.run('compare the image and audio', multimodalOptions());
    const inspection = await sdk.inspectSession('session-1');

    expect(result.executionShape).toBe('parallel_fanout_then_synthesis');
    expect(result.stages.map((stage) => stage.agentId)).toEqual(['image-analyst', 'audio-analyst', 'general']);
    expect(calls[0]?.options).toMatchObject({ images: [{ path: '/tmp/image.png' }] });
    expect(calls[0]?.options.contentParts).toBeUndefined();
    expect(calls[1]?.options.images).toBeUndefined();
    expect(calls[1]?.options.contentParts).toEqual([{ type: 'audio', audio: { source: { kind: 'path', path: '/tmp/audio.wav' }, format: 'wav' } }]);
    expect(inspection.links.map((link) => [link.nodeId, link.upstreamRunIds])).toEqual([
      ['image_specialist', []],
      ['audio_specialist', []],
      ['final_synthesis', ['image-analyst-run-1', 'audio-analyst-run-1']],
    ]);
    expect(calls[2]?.options.input).toEqual({
      originalInput: null,
      upstreamResults: {
        image_specialist: { agentId: 'image-analyst', runId: 'image-analyst-run-1' },
        audio_specialist: { agentId: 'audio-analyst', runId: 'audio-analyst-run-1' },
      },
    });
    expect(events.map((event) => event.type)).toEqual([
      'orchestration.plan.created',
      'orchestration.session.created',
      'orchestration.session.running',
      'orchestration.stage.starting',
      'orchestration.stage.starting',
      'orchestration.stage.linked',
      'orchestration.stage.linked',
      'orchestration.stage.starting',
      'orchestration.stage.linked',
      'orchestration.session.completed',
    ]);
    expect(events[0]).toMatchObject({ type: 'orchestration.plan.created', sessionId: 'session-1', executionShape: 'parallel_fanout_then_synthesis' });
    expect(events.at(-1)).toMatchObject({ type: 'orchestration.session.completed', sessionId: 'session-1', status: 'succeeded', finalRunId: 'general-run-1' });
  });

  it('resolves catalog agent names from configured agent search dirs', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'orchestration-catalog-'));
    const calls: Array<{ agentId: string; goal: string; options: AgentSdkRunOptions }> = [];
    try {
      await mkdir(join(tempDir, 'agents'));
      await writeFile(join(tempDir, 'agent.settings.json'), JSON.stringify({ agents: { dirs: ['./agents'] } }));
      await writeFile(join(tempDir, 'agents', 'audio-agent.json'), JSON.stringify(agent('mesh-audio-min', ['text', 'audio'], ['audio'])));

      const sdk = await createOrchestrationSdk({
        cwd: tempDir,
        agentCatalogPaths: ['audio-agent'],
        requestedAgentConfig: agent('general', ['text']),
        sessionIdFactory: () => 'session-1',
        agentRunnerFactory: async (agentId) => fakeRunner(agentId, calls),
      });

      const result = await sdk.run('transcribe this audio', {
        contentParts: [{ type: 'audio', audio: { source: { kind: 'path', path: '/tmp/audio.mp3' }, format: 'mp3' } }],
      });

      expect(result.stages.map((stage) => stage.agentId)).toEqual(['mesh-audio-min', 'general']);
      expect(calls[0]?.options.contentParts).toEqual([{ type: 'audio', audio: { source: { kind: 'path', path: '/tmp/audio.mp3' }, format: 'mp3' } }]);
      await sdk.close();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function agent(id: string, modalitiesSupported: SupportedModality[], modalitiesPreferred: SupportedModality[] = [], subjectsPreferred: string[] = [], keywords: string[] = []): AgentConfigFile {
  return {
    id,
    name: id,
    invocationModes: ['run'],
    defaultInvocationMode: 'run',
    model: { provider: 'ollama', model: 'qwen3.5' },
    tools: [],
    routing: keywords.length > 0 ? { keywords } : undefined,
    capabilities: { modalitiesSupported, modalitiesPreferred, modalityRoles: Object.fromEntries(modalitiesPreferred.map((modality) => [modality, 'analyze'])), subjectsPreferred },
  };
}

function catalogFor(entries: AgentConfigFile[]): Map<string, AgentCatalogEntry> {
  return new Map(entries.map((entry) => [entry.id, { agentId: entry.id, agentConfig: entry }]));
}

function multimodalOptions(): AgentSdkRunOptions {
  return {
    images: [{ path: '/tmp/image.png' }],
    contentParts: [{ type: 'audio', audio: { source: { kind: 'path', path: '/tmp/audio.wav' }, format: 'wav' } }],
  };
}

function fakeRunner(agentId: string, calls: Array<{ agentId: string; goal: string; options: AgentSdkRunOptions }>): OrchestrationAgentRunner {
  let count = 0;
  return {
    async runRaw(goal, options = {}) {
      count += 1;
      const runId = `${agentId}-run-${count}`;
      calls.push({ agentId, goal, options });
      return { status: 'success', runId, output: { agentId, runId }, stepsUsed: 1, usage: { promptTokens: 0, completionTokens: 0, estimatedCostUSD: 0 } };
    },
    async inspect(runId) {
      return { run: { rootRunId: runId } };
    },
  };
}
