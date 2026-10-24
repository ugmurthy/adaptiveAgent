import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { InMemoryOrchestrationStore, type AgentRun, type JsonValue, type OrchestrationStage, type RunRecoveryPlan, type RunResult } from '@adaptive-agent/core';

import type { AgentConfigFile, AgentSdkRunOptions, SupportedModality } from './index.js';
import { buildOrchestrationPlan, createOrchestrationSdk, type AgentCatalogEntry, type OrchestrationAgentRunner, type OrchestrationLifecycleEvent, type OrchestrationSdkOptions } from './orchestration.js';

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

  it('keeps a caller session across specialist runs when its execution id differs', async () => {
    const calls: Array<{ agentId: string; goal: string; options: AgentSdkRunOptions }> = [];
    const sdk = await createOrchestrationSdk({
      agentCatalog: [
        { agentId: 'general', agentConfig: agent('general', ['text']) },
        { agentId: 'image-analyst', agentConfig: agent('image-analyst', ['text', 'image'], ['image']) },
        { agentId: 'audio-analyst', agentConfig: agent('audio-analyst', ['text', 'audio'], ['audio']) },
      ],
      requestedAgentConfig: agent('general', ['text']),
      agentRunnerFactory: async (agentId) => fakeRunner(agentId, calls),
    });

    const result = await sdk.runRaw('compare the image and audio', {
      ...multimodalOptions(), executionId: 'execution-1', sessionId: 'task-session-2',
    });
    const inspection = await sdk.inspectExecution('execution-1');

    expect(inspection.execution?.id).toBe('execution-1');
    expect(inspection.plan).toMatchObject({ sessionId: 'task-session-2', executionId: 'execution-1' });
    expect(result.sessionId).toBe('task-session-2');
    expect(calls).toHaveLength(3);
    expect(calls.every(({ options }) => options.sessionId === 'task-session-2'
      && options.metadata?.orchestration && (options.metadata.orchestration as { executionId: string }).executionId === 'execution-1')).toBe(true);
  });

  it('builds one grouped specialist node when one agent is assigned image and audio', () => {
    const catalog = catalogFor([
      agent('general', ['text']),
      agent('media-analyst', ['text', 'image', 'audio'], ['image', 'audio']),
    ]);

    const plan = buildOrchestrationPlan({
      sessionId: 'session-1',
      requestedAgentId: 'general',
      goal: 'compare the image and audio',
      options: multimodalOptions(),
      catalog,
      finalizeWithRequestedAgent: true,
    });

    expect(plan.executionShape).toBe('sequential');
    expect(plan.routingDecision.assignments).toContainEqual(expect.objectContaining({
      agentId: 'media-analyst',
      modalities: ['image', 'audio'],
    }));
    expect(plan.nodes.map((node) => [node.id, node.agentId, node.dependsOn])).toEqual([
      ['image_audio_specialist', 'media-analyst', []],
      ['final_synthesis', 'general', ['image_audio_specialist']],
    ]);
    expect(plan.nodes[0]?.inputSelector?.claimIds).toEqual(['images.0', 'contentParts.0']);
  });

  it('builds a plan from a validated engine-neutral routing decision', () => {
    const catalog = catalogFor([
      agent('general', ['text']),
      agent('image-analyst', ['text', 'image']),
      agent('audio-analyst', ['text', 'audio']),
    ]);

    const plan = buildOrchestrationPlan({
      sessionId: 'session-adaptive',
      requestedAgentId: 'general',
      goal: 'compare the image and audio',
      options: multimodalOptions(),
      catalog,
      routingDecision: {
        mode: 'orchestration',
        primaryAgentId: 'general',
        synthesisAgentId: 'general',
        assignments: [
          { agentId: 'general', modalities: ['text'], reason: 'Primary' },
          { agentId: 'image-analyst', modalities: ['image'], reason: 'Image assignment' },
          { agentId: 'audio-analyst', modalities: ['audio'], reason: 'Audio assignment' },
        ],
        selectedCatalogAgentIds: ['general', 'image-analyst', 'audio-analyst'],
        reason: 'JEV chose two modality specialists.',
        confidence: 0.88,
        source: 'typesafe',
      },
      finalizeWithRequestedAgent: true,
    });

    expect(plan.routingDecision).toMatchObject({ source: 'typesafe', confidence: 0.88 });
    expect(plan.routingReason).toBe('JEV chose two modality specialists.');
    expect(plan.routingDiagnostics.subjectCandidates).toEqual([]);
    expect(plan.nodes.map((node) => node.agentId)).toEqual(['image-analyst', 'audio-analyst', 'general']);
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
    expect(imageCall.goal).toContain('Assigned modalities: image.');
    expect(audioCall.goal).toContain('Assigned modalities: audio.');
    expect(imageCall.goal).toContain('Do not request inputs for other modalities; other specialists handle them.');
    expect(audioCall.goal).toContain('Original user request: compare the image and audio');
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

  it('filters structured multimodal input to each assigned specialist', async () => {
    const calls: Array<{ agentId: string; goal: string; options: AgentSdkRunOptions }> = [];
    const sdk = await createOrchestrationSdk({
      agentCatalog: [
        { agentId: 'general', agentConfig: agent('general', ['text']) },
        { agentId: 'image-analyst', agentConfig: agent('image-analyst', ['text', 'image'], ['image']) },
        { agentId: 'audio-analyst', agentConfig: agent('audio-analyst', ['text', 'audio'], ['audio']) },
      ],
      requestedAgentConfig: agent('general', ['text']),
      agentRunnerFactory: async (agentId) => fakeRunner(agentId, calls),
    });

    await sdk.run('compare the structured media', {
      input: {
        context: 'shared context',
        image: { reference: 'image-1' },
        audio: { reference: 'audio-1' },
      },
    });

    expect(calls.find((call) => call.agentId === 'image-analyst')?.options.input).toEqual({
      context: 'shared context',
      image: { reference: 'image-1' },
    });
    expect(calls.find((call) => call.agentId === 'audio-analyst')?.options.input).toEqual({
      context: 'shared context',
      audio: { reference: 'audio-1' },
    });
    expect(calls.find((call) => call.agentId === 'general')?.options.input).toMatchObject({
      originalInput: { context: 'shared context' },
    });
  });

  it('persists allocated stage ids before invoking runners', async () => {
    const store = new InMemoryOrchestrationStore();
    const observed: Array<{ goal: string; runId: string | undefined; status: string | undefined }> = [];
    const sdk = await createOrchestrationSdk({
      agentCatalog: [{ agentId: 'general', agentConfig: agent('general', ['text']) }],
      requestedAgentConfig: agent('general', ['text']),
      orchestrationStore: store,
      agentRunnerFactory: async () => ({
        async runRaw(goal, options = {}) {
          const stage = (await store.listStages('execution-1'))[0];
          observed.push({ goal, runId: options.runId, status: stage?.status });
          return success(options.runId!);
        },
        async inspect(runId) { return { run: { rootRunId: runId } }; },
      }),
    });

    const result = await sdk.run('answer', { executionId: 'execution-1' });

    expect(observed).toEqual([{ goal: 'answer', runId: result.finalResult.runId, status: 'running' }]);
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

  it('allows synthesis after a failed dependency under the wait_for_all policy', async () => {
    const calls: string[] = [];
    const sdk = await createOrchestrationSdk({
      agentCatalog: [
        { agentId: 'general', agentConfig: agent('general', ['text']) },
        { agentId: 'image-analyst', agentConfig: agent('image-analyst', ['text', 'image'], ['image']) },
      ],
      requestedAgentConfig: agent('general', ['text']),
      concurrency: { failurePolicy: 'wait_for_all' },
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
      sessionId: 'task-session-resume',
      contentParts: [{ type: 'audio', audio: { source: { kind: 'path', path: '/tmp/audio.wav' }, format: 'wav' } }],
    });
    expect(first.finalResult.status).toBe('clarification_requested');
    expect(first.sessionId).toBe('task-session-resume');
    expect((await store.getExecution('execution-resume'))?.status).toBe('paused');

    const resumedSdk = await createOrchestrationSdk(options);
    const resumed = await resumedSdk.resumeExecution('execution-resume');

    expect(resumed.finalResult.status).toBe('success');
    expect(resumed.sessionId).toBe('task-session-resume');
    expect((await resumedSdk.inspectExecution('execution-resume')).plan?.sessionId).toBe('task-session-resume');
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

  it('executes one grouped multimodal specialist run with all assigned attachments', async () => {
    const calls: Array<{ agentId: string; goal: string; options: AgentSdkRunOptions }> = [];
    const sdk = await createOrchestrationSdk({
      agentCatalog: [
        { agentId: 'general', agentConfig: agent('general', ['text']) },
        { agentId: 'media-analyst', agentConfig: agent('media-analyst', ['text', 'image', 'audio'], ['image', 'audio']) },
      ],
      requestedAgentConfig: agent('general', ['text']),
      sessionIdFactory: () => 'session-grouped',
      agentRunnerFactory: async (agentId) => fakeRunner(agentId, calls),
    });

    const result = await sdk.run('compare the image and audio', multimodalOptions());

    expect(result.stages.map((stage) => stage.agentId)).toEqual(['media-analyst', 'general']);
    const specialistCall = calls.find((call) => call.agentId === 'media-analyst')!;
    expect(specialistCall.options.images).toEqual([{ path: '/tmp/image.png' }]);
    expect(specialistCall.options.contentParts).toEqual([
      { type: 'audio', audio: { source: { kind: 'path', path: '/tmp/audio.wav' }, format: 'wav' } },
    ]);
    expect(specialistCall.goal).toContain('Assigned modalities: image, audio.');
    expect(specialistCall.goal).toContain('Original user request: compare the image and audio');
    expect(specialistCall.options.metadata?.orchestration).toMatchObject({
      selectedCatalogAgentIds: ['general', 'media-analyst'],
      routingSource: 'deterministic',
      catalogFingerprint: result.plan.catalogFingerprint,
    });
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

  it('uses valid active profiles discovered from configured agent dirs without explicit catalog entries', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'orchestration-discovery-'));
    const calls: Array<{ agentId: string; goal: string; options: AgentSdkRunOptions }> = [];
    try {
      const agentsDir = join(tempDir, 'agents');
      const requested = agent('general', ['text']);
      await mkdir(agentsDir);
      await writeFile(join(agentsDir, 'general.json'), JSON.stringify(requested));
      await writeFile(join(agentsDir, 'media.json'), JSON.stringify(agent('media-analyst', ['text', 'image', 'audio'], ['image', 'audio'])));
      await writeFile(join(agentsDir, 'duplicate-a.json'), JSON.stringify(agent('aaa-duplicate', ['text', 'image', 'audio'], ['image', 'audio'])));
      await writeFile(join(agentsDir, 'duplicate-b.json'), JSON.stringify(agent('aaa-duplicate', ['text', 'image', 'audio'], ['image', 'audio'])));
      await writeFile(join(agentsDir, 'invalid.json'), '{invalid');
      await writeFile(join(tempDir, 'agent.settings.json'), JSON.stringify({ agents: { dirs: ['./agents'] } }));

      const sdk = await createOrchestrationSdk({
        cwd: tempDir,
        agentConfig: requested,
        agentConfigPath: join(agentsDir, 'general.json'),
        requestedAgentConfig: requested,
        includeDiscoveredAgents: true,
        sessionIdFactory: () => 'session-discovered',
        agentRunnerFactory: async (agentId) => fakeRunner(agentId, calls),
      });

      const result = await sdk.run('compare the image and audio', multimodalOptions());

      expect(result.stages.map((stage) => stage.agentId)).toEqual(['media-analyst', 'general']);
      expect(result.plan.routingDecision.selectedCatalogAgentIds).toEqual(['general', 'media-analyst']);
      await sdk.close();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('orchestration execution recovery', () => {
  it('recovers a failed stage, preserves successful siblings, and restarts skipped synthesis with fresh input', async () => {
    const harness = recoveryHarness({ failFirstRunFor: ['image-analyst'] });
    const sdk = await harness.sdk();
    const failed = await sdk.run('compare the image and audio', { ...multimodalOptions(), executionId: 'exec-recover', sessionId: 'session-recover' });
    expect(failed.finalResult.status).toBe('failure');
    const before = stagesByNode(await harness.store.listStages('exec-recover'));
    expect([before.image_specialist.status, before.audio_specialist.status, before.final_synthesis.status]).toEqual(['failed', 'succeeded', 'skipped']);

    const recovered = await sdk.recoverExecution('exec-recover');

    expect(recovered).toMatchObject({ executionId: 'exec-recover', sessionId: 'session-recover', outcome: 'completed' });
    expect(recovered.plans).toEqual([expect.objectContaining({ runId: before.image_specialist.runId, action: 'continue_new_run' })]);
    expect(recovered.actions).toHaveLength(1);
    expect(recovered.result?.finalResult.status).toBe('success');
    const after = stagesByNode(await harness.store.listStages('exec-recover'));
    const continuationRunId = `${before.image_specialist.runId}-continuation`;
    expect(after.image_specialist).toMatchObject({ status: 'succeeded', runId: continuationRunId });
    expect(after.audio_specialist).toMatchObject({ status: 'succeeded', runId: before.audio_specialist.runId, version: before.audio_specialist.version });
    expect(after.final_synthesis.status).toBe('succeeded');
    expect(after.final_synthesis.runId).not.toBe(before.final_synthesis.runId);
    expect(after.final_synthesis.upstreamRunIds.sort()).toEqual([before.audio_specialist.runId, continuationRunId].sort());
    expect(harness.calls.filter((call) => call.agentId === 'audio-analyst' && call.kind === 'run')).toHaveLength(1);
    expect(harness.calls.filter((call) => call.kind === 'recover')).toEqual([{ agentId: 'image-analyst', kind: 'recover', runId: before.image_specialist.runId }]);
    const synthesisCall = harness.runCalls.find((call) => call.agentId === 'general')!;
    expect(synthesisCall.options.runId).toBe(after.final_synthesis.runId);
    expect((synthesisCall.options.input as { upstreamResults: Record<string, unknown> }).upstreamResults.image_specialist).toEqual({ agentId: 'image-analyst', runId: continuationRunId });
    expect((await harness.store.getExecution('exec-recover'))?.status).toBe('succeeded');
    const links = (await sdk.inspectSession('session-recover')).links;
    expect(links).toContainEqual(expect.objectContaining({ nodeId: 'image_specialist', runId: continuationRunId, status: 'succeeded', metadata: expect.objectContaining({ recoveredFromRunId: before.image_specialist.runId }) }));
    expect(links).toContainEqual(expect.objectContaining({ nodeId: 'final_synthesis', runId: after.final_synthesis.runId, status: 'succeeded' }));

    const noOp = await sdk.recoverExecution('exec-recover');
    expect(noOp).toMatchObject({ outcome: 'completed', plans: [], actions: [] });
    expect(noOp.result?.finalResult).toMatchObject({ status: 'success', runId: after.final_synthesis.runId });
    expect(harness.calls.filter((call) => call.kind === 'recover')).toHaveLength(1);
  });

  it('keeps continuation stage identity across SDK restarts without recovering twice', async () => {
    const harness = recoveryHarness({ failFirstRunFor: ['image-analyst'] });
    await (await harness.sdk()).run('analyze image', { images: [{ path: '/tmp/image.png' }], executionId: 'exec-restart' });
    const original = stagesByNode(await harness.store.listStages('exec-restart'));

    expect((await (await harness.sdk()).recoverExecution('exec-restart')).outcome).toBe('completed');
    const restarted = await harness.sdk();
    const inspection = await restarted.inspectExecution('exec-restart');
    const stages = stagesByNode(inspection.stages);
    expect(stages.image_specialist.runId).toBe(`${original.image_specialist.runId}-continuation`);

    const again = await restarted.recoverExecution('exec-restart');
    expect(again).toMatchObject({ outcome: 'completed', actions: [] });
    expect(again.result?.stages.find((stage) => stage.nodeId === 'image_specialist')).toMatchObject({ runId: stages.image_specialist.runId, result: { status: 'success' } });
    expect(stagesByNode(await harness.store.listStages('exec-restart'))).toEqual(stages);
    expect(harness.calls.filter((call) => call.kind === 'recover')).toHaveLength(1);
  });

  it('restarts a downstream synthesis that already consumed a failed upstream result instead of recovering it', async () => {
    const harness = recoveryHarness({ failFirstRunFor: ['image-analyst', 'general'], failurePolicy: 'wait_for_all' });
    const sdk = await harness.sdk();
    const failed = await sdk.run('compare the image and audio', { ...multimodalOptions(), executionId: 'exec-downstream' });
    expect(failed.finalResult.status).toBe('failure');
    const before = stagesByNode(await harness.store.listStages('exec-downstream'));
    expect([before.image_specialist.status, before.audio_specialist.status, before.final_synthesis.status]).toEqual(['failed', 'succeeded', 'failed']);

    const recovered = await sdk.recoverExecution('exec-downstream');

    expect(recovered.outcome).toBe('completed');
    expect(recovered.plans.map((plan) => plan.runId)).toEqual([before.image_specialist.runId]);
    expect(harness.calls.filter((call) => call.kind === 'recover').map((call) => call.agentId)).toEqual(['image-analyst']);
    const after = stagesByNode(await harness.store.listStages('exec-downstream'));
    expect(after.final_synthesis.status).toBe('succeeded');
    expect(after.final_synthesis.runId).not.toBe(before.final_synthesis.runId);
    expect(after.audio_specialist.runId).toBe(before.audio_specialist.runId);
    expect(harness.runCalls.filter((call) => call.agentId === 'general').map((call) => call.options.runId)).toEqual([before.final_synthesis.runId, after.final_synthesis.runId]);
    expect(recovered.result?.finalResult.runId).toBe(after.final_synthesis.runId);
  });

  it('plans without model calls or store mutations in dry run', async () => {
    const harness = recoveryHarness({ failFirstRunFor: ['image-analyst'] });
    const sdk = await harness.sdk();
    await sdk.run('compare the image and audio', { ...multimodalOptions(), executionId: 'exec-dry' });
    const execution = await harness.store.getExecution('exec-dry');
    const stages = await harness.store.listStages('exec-dry');
    const callsBefore = harness.calls.length;

    const planned = await sdk.recoverExecution('exec-dry', { dryRun: true });

    expect(planned).toMatchObject({ outcome: 'planned', actions: [] });
    expect(planned.plans).toEqual([expect.objectContaining({ action: 'continue_new_run', executable: true })]);
    expect(planned.reason).toContain('restart final_synthesis');
    expect(planned.reason).toContain('preserve audio_specialist');
    expect(harness.calls.slice(callsBefore).every((call) => call.kind === 'plan')).toBe(true);
    expect(await harness.store.getExecution('exec-dry')).toEqual(execution);
    expect(await harness.store.listStages('exec-dry')).toEqual(stages);
  });

  it.each(['requires_user_action', 'requires_reconciliation'] as const)('does not bypass %s when a failed downstream input would change', async (action) => {
    const harness = recoveryHarness({ failFirstRunFor: ['image-analyst', 'general'], failurePolicy: 'wait_for_all' });
    const sdk = await harness.sdk();
    await sdk.run('compare the image and audio', { ...multimodalOptions(), executionId: 'exec-protected-downstream' });
    const stages = await harness.store.listStages('exec-protected-downstream');
    const synthesis = stagesByNode(stages).final_synthesis;
    harness.planOverrides.set(synthesis.runId, { action, executable: false, reason: 'explicit resolution required' });
    expect(await sdk.recoverExecution('exec-protected-downstream')).toMatchObject({ outcome: 'blocked', reason: expect.stringContaining(action), actions: [] });
    expect(await harness.store.listStages('exec-protected-downstream')).toEqual(stages);
    expect(harness.calls.filter((call) => call.kind === 'recover')).toHaveLength(0);
    expect(harness.runCalls.filter((call) => call.agentId === 'general')).toHaveLength(1);
  });

  it('reports a recovered stage that fails again without looping into another recovery', async () => {
    const harness = recoveryHarness({ failFirstRunFor: ['image-analyst'], recoveryFails: true });
    const sdk = await harness.sdk();
    await sdk.run('analyze image', { images: [{ path: '/tmp/image.png' }], executionId: 'exec-fails-again' });

    const recovered = await sdk.recoverExecution('exec-fails-again');

    expect(recovered.outcome).toBe('failed');
    expect(recovered.actions).toHaveLength(1);
    expect(harness.calls.filter((call) => call.kind === 'recover')).toHaveLength(1);
    expect(harness.runCalls.filter((call) => call.agentId === 'general')).toHaveLength(0);
    expect((await harness.store.getExecution('exec-fails-again'))?.status).toBe('failed');
    expect(stagesByNode(await harness.store.listStages('exec-fails-again')).final_synthesis.status).toBe('skipped');
  });

  it('blocks cancelled executions, catalog drift, user action, reconciliation, and runners without recovery', async () => {
    const harness = recoveryHarness({ failFirstRunFor: ['image-analyst'] });
    const sdk = await harness.sdk();
    await sdk.run('analyze image', { images: [{ path: '/tmp/image.png' }], executionId: 'exec-blocked' });
    const imageRunId = stagesByNode(await harness.store.listStages('exec-blocked')).image_specialist.runId;

    harness.planOverrides.set(imageRunId, { action: 'requires_reconciliation', executable: false, reason: 'tool side effect is uncertain' });
    expect(await sdk.recoverExecution('exec-blocked')).toMatchObject({ outcome: 'blocked', reason: expect.stringContaining('requires_reconciliation') });
    harness.planOverrides.set(imageRunId, { action: 'requires_user_action', executable: false, reason: 'approval required' });
    expect(await sdk.recoverExecution('exec-blocked')).toMatchObject({ outcome: 'blocked', reason: expect.stringContaining('approval required') });
    harness.planOverrides.delete(imageRunId);

    const drifted = await createOrchestrationSdk({ ...harness.options, agentCatalog: [...harness.options.agentCatalog, { agentId: 'extra', agentConfig: agent('extra', ['text']) }] });
    expect(await drifted.recoverExecution('exec-blocked')).toMatchObject({ outcome: 'blocked', reason: expect.stringContaining('CATALOG_CHANGED') });

    const legacy = await createOrchestrationSdk({ ...harness.options, agentRunnerFactory: async (agentId: string) => ({ ...harness.runner(agentId), getRecoveryPlan: undefined, recoverRaw: undefined }) });
    expect(await legacy.recoverExecution('exec-blocked')).toMatchObject({ outcome: 'blocked', reason: expect.stringContaining('does not support run recovery') });

    const failedExecution = (await harness.store.getExecution('exec-blocked'))!;
    await harness.store.updateExecution('exec-blocked', { status: 'cancelled' }, failedExecution.version);
    expect(await sdk.recoverExecution('exec-blocked')).toMatchObject({ outcome: 'blocked', reason: expect.stringContaining('cancelled') });
    expect(harness.calls.filter((call) => call.kind === 'recover')).toHaveLength(0);
  });

  it('reports busy for live leases and recently active schedulers', async () => {
    const harness = recoveryHarness({});
    const store = harness.store;
    const stageRunId = crypto.randomUUID();
    const fingerprint = await catalogFingerprintForHarness();
    await store.createExecution({ id: 'exec-busy', status: 'running', request: { goal: 'answer', options: {} }, catalogFingerprint: fingerprint, plan: singlePlan('session-busy', fingerprint), stages: [{ runId: stageRunId, nodeId: 'requested', agentId: 'general' }] });
    const claimed = await store.claimReadyStage('exec-busy');
    expect(claimed?.runId).toBe(stageRunId);
    harness.runs.set(stageRunId, { status: 'running', leaseOwner: 'other-process', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });

    const sdk = await harness.sdk();
    expect(await sdk.recoverExecution('exec-busy')).toMatchObject({ outcome: 'busy', reason: expect.stringContaining('live lease') });
    harness.runs.set(stageRunId, { status: 'running', leaseOwner: 'other-process', leaseExpiresAt: new Date(Date.now() - 1_000).toISOString() });
    const recent = await harness.sdk();
    expect(await recent.recoverExecution('exec-busy')).toMatchObject({ outcome: 'busy', reason: expect.stringContaining('active scheduler') });
    expect(harness.calls.filter((call) => call.kind === 'recover' || call.kind === 'run')).toHaveLength(0);
    expect((await store.listStages('exec-busy'))[0]).toMatchObject({ status: 'running', version: claimed!.version });

    // Once stale, the expired-lease run is resumed through run-level recovery exactly once.
    const stale = await harness.sdk({ recoveryStaleAfterMs: 0 });
    const recovered = await stale.recoverExecution('exec-busy');
    expect(recovered).toMatchObject({ outcome: 'completed', plans: [expect.objectContaining({ action: 'resume_same_run' })] });
    expect((await store.listStages('exec-busy'))[0]).toMatchObject({ status: 'succeeded', runId: stageRunId });
  });

  it('lets only one of two overlapping recoveries run continuation and synthesis work', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const harness = recoveryHarness({ failFirstRunFor: ['image-analyst'], recoveryGate: gate });
    await (await harness.sdk()).run('analyze image', { images: [{ path: '/tmp/image.png' }], executionId: 'exec-overlap' });
    const first = await harness.sdk();
    const second = await harness.sdk();

    const inFlight = first.recoverExecution('exec-overlap');
    const sameProcess = first.recoverExecution('exec-overlap');
    const otherProcess = second.recoverExecution('exec-overlap');
    expect(await sameProcess).toMatchObject({ outcome: 'busy' });
    expect(await otherProcess).toMatchObject({ outcome: 'busy' });
    release();
    expect((await inFlight).outcome).toBe('completed');
    expect(harness.calls.filter((call) => call.kind === 'recover')).toHaveLength(1);
    expect(harness.runCalls.filter((call) => call.agentId === 'general')).toHaveLength(1);
  });
});

type HarnessRun = { status: AgentRun['status']; result?: JsonValue; errorMessage?: string; leaseOwner?: string; leaseExpiresAt?: string };

function recoveryHarness(config: { failFirstRunFor?: string[]; failurePolicy?: 'fail_fast' | 'wait_for_all'; recoveryFails?: boolean; recoveryGate?: Promise<void> }) {
  const store = new InMemoryOrchestrationStore();
  const runs = new Map<string, HarnessRun>();
  const calls: Array<{ agentId: string; kind: 'run' | 'plan' | 'recover'; runId: string }> = [];
  const runCalls: Array<{ agentId: string; options: AgentSdkRunOptions }> = [];
  const planOverrides = new Map<string, Pick<RunRecoveryPlan, 'action' | 'executable' | 'reason'>>();
  const failed = new Set<string>();
  const usage = success('usage').usage;
  const runner = (agentId: string): OrchestrationAgentRunner => ({
    async runRaw(_goal, options = {}) {
      const runId = options.runId!;
      calls.push({ agentId, kind: 'run', runId });
      runCalls.push({ agentId, options });
      if (config.failFirstRunFor?.includes(agentId) && !failed.has(agentId)) {
        failed.add(agentId);
        runs.set(runId, { status: 'failed', errorMessage: `${agentId} provider outage` });
        return { status: 'failure', runId, error: `${agentId} provider outage`, code: 'MODEL_ERROR', stepsUsed: 0, usage };
      }
      const output = { agentId, runId };
      runs.set(runId, { status: 'succeeded', result: output });
      return { ...success(runId), output };
    },
    async getRecoveryPlan(runId) {
      calls.push({ agentId, kind: 'plan', runId });
      const run = runs.get(runId);
      if (!run) throw new Error(`Run ${runId} does not exist`);
      const override = planOverrides.get(runId);
      if (override) return { runId, status: run.status, ...override };
      if (run.status === 'failed') return { runId, status: run.status, action: 'continue_new_run', executable: true, reason: 'continuable after provider outage' };
      if (run.status === 'running' || run.status === 'interrupted') return { runId, status: run.status, action: 'resume_same_run', executable: true, reason: 'resume from snapshot' };
      return { runId, status: run.status, action: 'not_recoverable', executable: false, reason: `run is ${run.status}` };
    },
    async recoverRaw(options) {
      calls.push({ agentId, kind: 'recover', runId: options.runId });
      const plan = await this.getRecoveryPlan!(options.runId);
      await config.recoveryGate;
      const runId = plan.action === 'continue_new_run' ? `${options.runId}-continuation` : options.runId;
      if (config.recoveryFails) {
        runs.set(runId, { status: 'failed', errorMessage: 'still failing' });
        return { runId: options.runId, action: plan.action, plan, result: { status: 'failure', runId, error: 'still failing', code: 'MODEL_ERROR', stepsUsed: 0, usage } };
      }
      const output = { agentId, runId };
      runs.set(runId, { status: 'succeeded', result: output });
      return { runId: options.runId, action: plan.action, plan, result: { ...success(runId), output } };
    },
    async interrupt() {},
    async inspect(runId) {
      const run = runs.get(runId);
      return { run: run ? { rootRunId: runId, id: runId, status: run.status, result: run.result, errorMessage: run.errorMessage, usage, leaseOwner: run.leaseOwner, leaseExpiresAt: run.leaseExpiresAt } : null };
    },
  });
  const options = {
    agentCatalog: [
      { agentId: 'general', agentConfig: agent('general', ['text']) },
      { agentId: 'image-analyst', agentConfig: agent('image-analyst', ['text', 'image'], ['image']) },
      { agentId: 'audio-analyst', agentConfig: agent('audio-analyst', ['text', 'audio'], ['audio']) },
    ],
    requestedAgentConfig: agent('general', ['text']),
    orchestrationStore: store,
    concurrency: { failurePolicy: config.failurePolicy ?? 'fail_fast' },
    agentRunnerFactory: async (agentId: string) => runner(agentId),
  };
  return { store, runs, calls, runCalls, planOverrides, options, runner, sdk: (overrides: Partial<OrchestrationSdkOptions> = {}) => createOrchestrationSdk({ ...options, ...overrides }) };
}

async function catalogFingerprintForHarness(): Promise<string> {
  const probe = recoveryHarness({});
  return (await (await probe.sdk()).run('probe', { executionId: 'probe' })).plan.catalogFingerprint;
}

function singlePlan(sessionId: string, catalogFingerprint: string): JsonValue {
  const catalog = catalogFor([agent('general', ['text']), agent('image-analyst', ['text', 'image'], ['image']), agent('audio-analyst', ['text', 'audio'], ['audio'])]);
  return JSON.parse(JSON.stringify(buildOrchestrationPlan({ sessionId, requestedAgentId: 'general', goal: 'answer', options: {}, catalog, catalogFingerprint, finalizeWithRequestedAgent: true }))) as JsonValue;
}

function stagesByNode(stages: OrchestrationStage[]): Record<string, OrchestrationStage> {
  return Object.fromEntries(stages.map((stage) => [stage.nodeId, stage]));
}

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
