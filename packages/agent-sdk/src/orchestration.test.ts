import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { InMemoryOrchestrationStore, type RunResult } from '@adaptive-agent/core';

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

  it('fails planning before starting a stage when no agent can consume a required modality', () => {
    const catalog = catalogFor([agent('general', ['text'])]);

    expect(() => buildOrchestrationPlan({
      sessionId: 'session-1',
      requestedAgentId: 'general',
      goal: 'transcribe this audio',
      options: { contentParts: [{ type: 'audio', audio: { source: { kind: 'path', path: '/tmp/audio.wav' }, format: 'wav' } }] },
      catalog,
      finalizeWithRequestedAgent: true,
    })).toThrow('No agent supports required modality "audio"');
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

    const result = await sdk.run('compare the image and audio', {
      ...multimodalOptions(),
      inferenceTier: 'high',
      executionContext: {
        inferenceMode: 'gateway',
        inferenceTier: 'high',
        authorizationRef: 'permit-orchestration',
      },
    });
    const inspection = await sdk.inspectSession('session-1');

    expect(result.executionShape).toBe('parallel_fanout_then_synthesis');
    expect(result.stages.map((stage) => stage.agentId)).toEqual(['image-analyst', 'audio-analyst', 'general']);
    const imageCall = calls.find((call) => call.agentId === 'image-analyst')!;
    const audioCall = calls.find((call) => call.agentId === 'audio-analyst')!;
    const synthesisCall = calls.find((call) => call.agentId === 'general')!;
    expect(imageCall.options).toMatchObject({ images: [{ path: '/tmp/image.png' }] });
    expect(imageCall.options.contentParts).toBeUndefined();
    expect(audioCall.options.images).toBeUndefined();
    expect(audioCall.options.contentParts).toEqual([{ type: 'audio', audio: { source: { kind: 'path', path: '/tmp/audio.wav' }, format: 'wav' } }]);
    expect(calls.every((call) =>
      call.options.executionContext?.authorizationRef === 'permit-orchestration'
    )).toBe(true);
    expect(calls.every((call) => call.options.inferenceTier === 'high')).toBe(true);
    expect(inspection.links.map((link) => link.nodeId).sort()).toEqual(['audio_specialist', 'final_synthesis', 'image_specialist']);
    expect(synthesisCall.options.input).toEqual({
      originalInput: null,
      upstreamResults: {
        image_specialist: { agentId: 'image-analyst', runId: imageCall.options.runId },
        audio_specialist: { agentId: 'audio-analyst', runId: audioCall.options.runId },
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
    expect(events.at(-1)).toMatchObject({ type: 'orchestration.session.completed', sessionId: 'session-1', status: 'succeeded', finalRunId: synthesisCall.options.runId });
  });

  it('persists allocated stage ids before invoking runners', async () => {
    const store = new InMemoryOrchestrationStore();
    const observed: Array<{ runId: string | undefined; status: string | undefined }> = [];
    const sdk = await createOrchestrationSdk({
      agentCatalog: [{ agentId: 'general', agentConfig: agent('general', ['text']) }],
      requestedAgentConfig: agent('general', ['text']),
      orchestrationStore: store,
      agentRunnerFactory: async () => ({
        async runRaw(_goal, options = {}) {
          const stage = (await store.listStages('execution-1'))[0];
          observed.push({ runId: options.runId, status: stage?.status });
          return success(options.runId!);
        },
        async inspect(runId) { return { run: { rootRunId: runId } }; },
      }),
    });

    const result = await sdk.run('answer', { executionId: 'execution-1' });

    expect(observed).toEqual([{ runId: result.finalResult.runId, status: 'running' }]);
    expect((await store.getExecution('execution-1'))?.status).toBe('succeeded');
  });

  it('retains generic files for synthesis without forwarding unsupported raw media', async () => {
    const calls: Array<{ agentId: string; goal: string; options: AgentSdkRunOptions }> = [];
    const sdk = await createOrchestrationSdk({
      agentCatalog: [
        { agentId: 'general', agentConfig: agent('general', ['text', 'file']) },
        { agentId: 'image-analyst', agentConfig: agent('image-analyst', ['text', 'image'], ['image']) },
        { agentId: 'audio-analyst', agentConfig: agent('audio-analyst', ['text', 'audio'], ['audio']) },
      ],
      requestedAgentConfig: agent('general', ['text', 'file']),
      agentRunnerFactory: async (agentId) => fakeRunner(agentId, calls),
    });

    await sdk.run('analyze all attachments', {
      images: [{ path: '/tmp/image.png' }],
      contentParts: [
        { type: 'audio', audio: { source: { kind: 'path', path: '/tmp/audio.wav' }, format: 'wav' } },
        { type: 'file', file: { source: { kind: 'path', path: '/tmp/notes.txt' }, mimeType: 'text/plain' } },
      ],
    });

    const synthesis = calls.find((call) => call.agentId === 'general')!;
    expect(synthesis.options.images).toBeUndefined();
    expect(synthesis.options.contentParts).toEqual([
      { type: 'file', file: { source: { kind: 'path', path: '/tmp/notes.txt' }, mimeType: 'text/plain' } },
    ]);
  });

  it('fails fast when one parallel stage fails and cancels an interaction-paused sibling', async () => {
    const store = new InMemoryOrchestrationStore();
    const interrupted: string[] = [];
    const sdk = await createOrchestrationSdk({
      agentCatalog: [
        { agentId: 'general', agentConfig: agent('general', ['text']) },
        { agentId: 'image-analyst', agentConfig: agent('image-analyst', ['text', 'image'], ['image']) },
        { agentId: 'audio-analyst', agentConfig: agent('audio-analyst', ['text', 'audio'], ['audio']) },
      ],
      requestedAgentConfig: agent('general', ['text']),
      orchestrationStore: store,
      agentRunnerFactory: async (agentId): Promise<OrchestrationAgentRunner> => ({
        async runRaw(_goal, options = {}) {
          if (agentId === 'image-analyst') return { status: 'failure', runId: options.runId!, error: 'image failed', code: 'MODEL_ERROR', stepsUsed: 0, usage: success(options.runId!).usage };
          return { status: 'clarification_requested', runId: options.runId!, message: 'Need audio context.' };
        },
        async interrupt(runId) { interrupted.push(runId); },
        async inspect(runId) { return { run: { rootRunId: runId } }; },
      }),
    });

    const result = await sdk.run('analyze both', { executionId: 'execution-fail-fast', ...multimodalOptions() });

    expect(result.finalResult).toMatchObject({ status: 'failure', error: 'image failed' });
    expect((await store.getExecution('execution-fail-fast'))?.status).toBe('failed');
    expect((await store.listStages('execution-fail-fast')).map((stage) => stage.status).sort()).toEqual(['cancelled', 'failed', 'skipped']);
    expect(interrupted).toHaveLength(1);
  });

  it('allows synthesis after a failed dependency under the continue policy', async () => {
    const calls: string[] = [];
    const sdk = await createOrchestrationSdk({
      agentCatalog: [
        { agentId: 'general', agentConfig: agent('general', ['text']) },
        { agentId: 'image-analyst', agentConfig: agent('image-analyst', ['text', 'image'], ['image']) },
      ],
      requestedAgentConfig: agent('general', ['text']),
      concurrency: { failurePolicy: 'continue' },
      agentRunnerFactory: async (agentId): Promise<OrchestrationAgentRunner> => ({
        async runRaw(_goal, options = {}) {
          calls.push(agentId);
          return agentId === 'image-analyst'
            ? { status: 'failure', runId: options.runId!, error: 'image unavailable', code: 'MODEL_ERROR', stepsUsed: 0, usage: success(options.runId!).usage }
            : success(options.runId!);
        },
        async inspect(runId) { return { run: { rootRunId: runId } }; },
      }),
    });

    const result = await sdk.run('analyze image', { images: [{ path: '/tmp/image.png' }] });

    expect(result.finalResult.status).toBe('success');
    expect(calls).toEqual(['image-analyst', 'general']);
  });

  it('persists pauses and resumes without rerunning completed stages', async () => {
    const store = new InMemoryOrchestrationStore();
    const records = new Map<string, RunResult>();
    const calls: string[] = [];
    let synthesisPaused = true;
    const factory = async (agentId: string): Promise<OrchestrationAgentRunner> => ({
      async runRaw(_goal, options = {}) {
        calls.push(agentId);
        const result: RunResult = agentId === 'general' && synthesisPaused
          ? { status: 'clarification_requested', runId: options.runId!, message: 'Confirm synthesis.' }
          : success(options.runId!);
        records.set(options.runId!, result);
        return result;
      },
      async resumeRaw(runId) {
        synthesisPaused = false;
        const result = success(runId);
        records.set(runId, result);
        return result;
      },
      async inspect(runId) {
        const result = records.get(runId);
        return { run: result?.status === 'success' ? { rootRunId: runId, result: result.output, usage: result.usage } : { rootRunId: runId } };
      },
    });
    const options = {
      agentCatalog: [
        { agentId: 'general', agentConfig: agent('general', ['text']) },
        { agentId: 'audio-analyst', agentConfig: agent('audio-analyst', ['text', 'audio'], ['audio']) },
      ],
      requestedAgentConfig: agent('general', ['text']),
      orchestrationStore: store,
      agentRunnerFactory: factory,
    };
    const firstSdk = await createOrchestrationSdk(options);
    const first = await firstSdk.run('transcribe', {
      executionId: 'execution-resume',
      contentParts: [{ type: 'audio', audio: { source: { kind: 'path', path: '/tmp/audio.wav' }, format: 'wav' } }],
    });
    expect(first.finalResult.status).toBe('clarification_requested');
    expect((await store.getExecution('execution-resume'))?.status).toBe('paused');

    const resumedSdk = await createOrchestrationSdk(options);
    const resumed = await resumedSdk.resumeExecution('execution-resume');

    expect(resumed.finalResult.status).toBe('success');
    expect(calls.filter((agentId) => agentId === 'audio-analyst')).toHaveLength(1);
    expect((await store.getExecution('execution-resume'))?.status).toBe('succeeded');
  });

  it('cancels paused stages and refuses a changed catalog on resume', async () => {
    const store = new InMemoryOrchestrationStore();
    const interrupted: string[] = [];
    const firstSdk = await createOrchestrationSdk({
      agentCatalog: [{ agentId: 'general', agentConfig: agent('general', ['text']) }],
      requestedAgentConfig: agent('general', ['text']),
      orchestrationStore: store,
      agentRunnerFactory: async () => ({
        async runRaw(_goal, options = {}) { return { status: 'approval_requested', runId: options.runId!, approvalId: 'approval-1', rootRunId: options.runId!, message: 'Approve', toolName: 'write_file' }; },
        async interrupt(runId) { interrupted.push(runId); },
        async inspect(runId) { return { run: { rootRunId: runId } }; },
      }),
    });
    await firstSdk.run('write', { executionId: 'execution-cancel' });
    await firstSdk.interruptExecution('execution-cancel');
    expect(interrupted).toHaveLength(1);
    expect((await store.getExecution('execution-cancel'))?.status).toBe('cancelled');
    expect((await store.listStages('execution-cancel'))[0]?.status).toBe('cancelled');

    const changedSdk = await createOrchestrationSdk({
      agentCatalog: [{ agentId: 'general', agentConfig: agent('general', ['text'], [], [], ['changed']) }],
      requestedAgentConfig: agent('general', ['text'], [], [], ['changed']),
      orchestrationStore: store,
      agentRunnerFactory: async (agentId) => fakeRunner(agentId, []),
    });
    await expect(changedSdk.resumeExecution('execution-cancel')).rejects.toThrow('CATALOG_CHANGED');
  });

  it('reconciles a completed run after restart without invoking it twice', async () => {
    const store = new InMemoryOrchestrationStore();
    const runs = new Map<string, { status: 'succeeded'; result: string; usage: Extract<RunResult, { status: 'success' }>['usage'] }>();
    let invocations = 0;
    const options = {
      agentCatalog: [{ agentId: 'general', agentConfig: agent('general', ['text']) }],
      requestedAgentConfig: agent('general', ['text']),
      orchestrationStore: store,
      agentRunnerFactory: async (): Promise<OrchestrationAgentRunner> => ({
        async runRaw(_goal, runOptions = {}) {
          invocations += 1;
          runs.set(runOptions.runId!, { status: 'succeeded', result: 'finished before restart', usage: success(runOptions.runId!).usage });
          throw new Error('scheduler stopped after the run completed');
        },
        async inspect(runId) { return { run: runs.get(runId) ? { rootRunId: runId, ...runs.get(runId)! } : null }; },
      }),
    };
    const firstSdk = await createOrchestrationSdk(options);
    await expect(firstSdk.run('answer', { executionId: 'execution-restart' })).rejects.toThrow('scheduler stopped');
    expect((await store.listStages('execution-restart'))[0]?.status).toBe('running');

    const restartedSdk = await createOrchestrationSdk(options);
    const result = await restartedSdk.resumeExecution('execution-restart');

    expect(result.finalResult).toMatchObject({ status: 'success', output: 'finished before restart' });
    expect(invocations).toBe(1);
    expect((await store.getExecution('execution-restart'))?.status).toBe('succeeded');
  });

  it('does not let a completing stage overwrite concurrent cancellation', async () => {
    const store = new InMemoryOrchestrationStore();
    let releaseRun!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseRun = resolve; });
    const sdk = await createOrchestrationSdk({
      agentCatalog: [{ agentId: 'general', agentConfig: agent('general', ['text']) }],
      requestedAgentConfig: agent('general', ['text']),
      orchestrationStore: store,
      agentRunnerFactory: async (): Promise<OrchestrationAgentRunner> => ({
        async runRaw(_goal, options = {}) {
          markStarted();
          await release;
          return success(options.runId!);
        },
        async interrupt() {},
        async inspect(runId) { return { run: { rootRunId: runId, status: 'succeeded', result: 'done', usage: success(runId).usage } }; },
      }),
    });
    const running = sdk.run('answer', { executionId: 'execution-cancel-race' });
    await started;
    await sdk.interruptExecution('execution-cancel-race');
    releaseRun();

    await expect(running).rejects.toThrow('is cancelled');
    expect((await store.getExecution('execution-cancel-race'))?.status).toBe('cancelled');
    expect((await store.listStages('execution-cancel-race'))[0]?.status).toBe('cancelled');
  });

  it('does not mutate the SDK catalog fingerprint from a per-run override', async () => {
    const store = new InMemoryOrchestrationStore();
    const sdk = await createOrchestrationSdk({
      agentCatalog: [{ agentId: 'general', agentConfig: agent('general', ['text']) }],
      requestedAgentConfig: agent('general', ['text']),
      orchestrationStore: store,
      agentRunnerFactory: async (agentId) => fakeRunner(agentId, []),
    });

    await sdk.run('first', { executionId: 'execution-custom-fingerprint', catalogFingerprint: 'caller-supplied' });
    await sdk.run('second', { executionId: 'execution-default-fingerprint' });

    expect((await store.getExecution('execution-custom-fingerprint'))?.catalogFingerprint).toBe('caller-supplied');
    expect((await store.getExecution('execution-default-fingerprint'))?.catalogFingerprint).not.toBe('caller-supplied');
  });

  it('does not include inline API-key values in catalog compatibility fingerprints', async () => {
    const store = new InMemoryOrchestrationStore();
    const firstConfig = agent('general', ['text']);
    firstConfig.model.apiKey = 'first-secret';
    const secondConfig = agent('general', ['text']);
    secondConfig.model.apiKey = 'rotated-secret';
    const create = (config: AgentConfigFile) => createOrchestrationSdk({
      agentCatalog: [{ agentId: 'general', agentConfig: config }],
      requestedAgentConfig: config,
      orchestrationStore: store,
      agentRunnerFactory: async (agentId) => fakeRunner(agentId, []),
    });

    await (await create(firstConfig)).run('first', { executionId: 'execution-first-secret' });
    await (await create(secondConfig)).run('second', { executionId: 'execution-second-secret' });

    expect((await store.getExecution('execution-first-secret'))?.catalogFingerprint)
      .toBe((await store.getExecution('execution-second-secret'))?.catalogFingerprint);
  });

  it('rejects context refs until orchestration stage propagation is defined', async () => {
    const sdk = await createOrchestrationSdk({
      agentCatalog: [{ agentId: 'general', agentConfig: agent('general', ['text']) }],
      requestedAgentConfig: agent('general', ['text']),
      agentRunnerFactory: async (agentId) => fakeRunner(agentId, []),
    });

    await expect(sdk.run('continue prior work', {
      contextRefs: [{ kind: 'run', id: 'run-123' }],
    })).rejects.toThrow('Context refs are not supported for orchestration');
    await sdk.close();
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
      const runId = options.runId ?? `${agentId}-run-${count}`;
      calls.push({ agentId, goal, options });
      return { ...success(runId), output: { agentId, runId } };
    },
    async inspect(runId) {
      return { run: { rootRunId: runId } };
    },
  };
}

function success(runId: string): Extract<RunResult, { status: 'success' }> {
  return { status: 'success', runId, output: { runId }, stepsUsed: 1, usage: { promptTokens: 0, completionTokens: 0, estimatedCostUSD: 0 } };
}
