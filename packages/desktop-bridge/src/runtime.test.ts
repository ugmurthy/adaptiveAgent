import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ADAPTIVE_AGENT_CLI_COMMANDS } from '@adaptive-agent/agent-sdk/cli';
import { AgentSdk, type OrchestratedRunResult, type ResolvedAgentSdkConfig, type TaskPreparationResult } from '@adaptive-agent/agent-sdk';
import * as agentCreate from '@adaptive-agent/agent-sdk/agent-create';
import { InMemoryOrchestrationStore } from '@adaptive-agent/core';

import { JSON_RPC_ERROR_CODES, type DesktopMessage, type DesktopRpcRequest } from './protocol.js';
import { DesktopRuntime, safeResolvedConfiguration, updateDesktopSettings, validateRestrictedDesktopConfiguration, type CliExecutor, type DesktopOrchestrationFactory } from './runtime.js';

function request(value: Omit<DesktopRpcRequest, 'jsonrpc'>): DesktopRpcRequest {
  return { jsonrpc: '2.0', ...value } as DesktopRpcRequest;
}

function createRuntime(executor?: CliExecutor, orchestrationFactory?: DesktopOrchestrationFactory) {
  const messages: DesktopMessage[] = [];
  return {
    messages,
    runtime: new DesktopRuntime((message) => messages.push(message), executor, orchestrationFactory),
  };
}

async function initialize(runtime: DesktopRuntime): Promise<void> {
  await runtime.handleRpc(request({
    id: 'init',
    method: 'initialize',
    params: { protocolVersion: '1.10', clientInfo: { name: 'test-client' } },
  }));
}

function taskPreparationResult(runId: string, decision: 'clarify' | 'invalid', questions: string[]) {
  return {
    originalObjective: 'deploy',
    title: 'Deploy Application',
    name: 'deploy-application',
    decision,
    preparedObjective: '',
    assumptions: [],
    clarificationQuestions: questions,
    reason: decision === 'clarify' ? 'More detail is required.' : 'The request cannot be executed.',
    preparationAgentId: 'task-preparer',
    preparationRunId: runId,
  };
}

function preparationRun(preparation: TaskPreparationResult) {
  return {
    id: preparation.preparationRunId,
    rootRunId: preparation.preparationRunId,
    status: 'succeeded',
    version: 1,
    input: {
      originalObjective: preparation.originalObjective,
      workspaceRoot: '/workspace',
      attachments: { images: [], files: preparation.originalObjective === 'deploy it' ? ['file-1/release.txt'] : [], audio: [] },
    },
    result: {
      title: preparation.title,
      name: preparation.name,
      decision: preparation.decision,
      preparedObjective: preparation.preparedObjective,
      assumptions: preparation.assumptions,
      clarificationQuestions: preparation.clarificationQuestions,
      reason: preparation.reason,
    },
    metadata: {
      agentId: 'task-preparer', command: 'task-preparation', role: 'task-preparer',
      targetAgentId: 'deployer', preparationMode: 'auto',
    },
  };
}

function desktopPreparationTarget(runStore: unknown, runRaw: ReturnType<typeof vi.fn>) {
  return {
    agentPath: '/agents/deployer.json',
    runRaw,
    created: { runtime: { runStore } },
    config: {
      agent: {
        id: 'deployer', name: 'Deployer', invocationModes: ['run'], defaultInvocationMode: 'run', tools: [],
      },
      model: { provider: 'ollama', model: 'test-model' },
      inference: { mode: 'byok', tier: 'medium' },
      interaction: { approvalMode: 'manual', clarificationMode: 'interactive' },
      workspaceRoot: '/workspace',
      settings: { taskPreparation: { mode: 'auto', agent: './task-preparer.json' } },
    },
  } as unknown as AgentSdk;
}

describe('desktop runtime protocol', () => {
  it('updates editable settings without dropping advanced configuration', () => {
    const updated = updateDesktopSettings(
      { env: { EXISTING: 'value' }, gateway: { url: 'ws://gateway' }, model: { overrideBaseUrl: 'https://models' }, taskPreparation: { agent: './agents/task-preparer.json' } },
      {
        agent: { mode: 'auto', configPath: ' ./agents/researcher.json ', id: 'researcher' },
        inference: { mode: 'byok', tier: 'high' },
        workspace: { root: ' /workspace ', shellCwd: ' /workspace/project ' },
        interaction: { approvalMode: 'manual', clarificationMode: 'fail' },
        taskPreparation: { mode: 'auto' },
      },
    );
    expect(updated).toMatchObject({
      env: { EXISTING: 'value' },
      gateway: { url: 'ws://gateway' },
      model: { overrideBaseUrl: 'https://models' },
      agent: { mode: 'auto', configPath: './agents/researcher.json', id: 'researcher' },
      inference: { mode: 'byok', tier: 'high' },
      workspace: { overrideRoot: '/workspace', overrideShellCwd: '/workspace/project' },
      interaction: { approvalMode: 'manual', clarificationMode: 'fail' },
      taskPreparation: { mode: 'auto', agent: './agents/task-preparer.json' },
    });
  });

  it('applies enhanced task preparation to bridge-initiated runs', async () => {
    const runRaw = vi.fn(async () => ({ status: 'success', runId: 'execution-1', output: 'done', stepsUsed: 1, usage: {} }));
    const preparation = {
      originalObjective: 'fix it', decision: 'enhance', preparedObjective: 'Fix the failing test and verify it.',
      title: 'Fix Failing Test', name: 'fix-failing-test',
      assumptions: [], clarificationQuestions: [], reason: 'Added completion criteria.',
      preparationAgentId: 'task-preparer', preparationRunId: 'preparation-1',
    } as const;
    const { runtime } = createRuntime();
    await runtime.handleRpc(request({ id: 'init', method: 'initialize', params: { protocolVersion: '1.17', clientInfo: { name: 'desktop' } } }));
    const prepareRunTask = vi.fn(async () => preparation);
    Object.assign(runtime as unknown as Record<string, unknown>, {
      sdk: { runRaw, config: { agent: { id: 'developer', name: 'Developer' }, workspaceRoot: '/workspace', settings: { taskPreparation: { mode: 'auto' } } } },
      prepareRunTask,
    });

    await expect(runtime.handleRpc(request({
      id: 'run', method: 'agent/run', params: { executionId: 'execution-1', goal: 'fix it' },
    }))).resolves.toMatchObject({ status: 'success', finalRunId: 'execution-1' });
    const generatedSessionId = (prepareRunTask.mock.calls as unknown[][])[0]?.[3];
    expect(generatedSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(runRaw).toHaveBeenCalledWith('Fix the failing test and verify it.', expect.objectContaining({
      runId: 'execution-1',
      sessionId: generatedSessionId,
      metadata: { taskPreparation: expect.objectContaining({
        originalObjective: 'fix it',
        title: 'Fix Failing Test',
        name: 'fix-failing-test',
        preparationRunId: 'preparation-1',
      }) },
    }));
  });

  it('executes an auto-selected profile in the same session and records the selection', async () => {
    const selectedRunRaw = vi.fn(async () => ({ status: 'success', runId: 'execution-auto', output: 'done', stepsUsed: 1, usage: {} }));
    const fallback = { config: { workspaceRoot: '/workspace', settings: {} } };
    const selectedSdk = {
      runRaw: selectedRunRaw,
      config: { agent: { id: 'researcher', name: 'Research Agent' }, workspaceRoot: '/workspace', settings: {} },
    };
    const selection = {
      selectedAgentId: 'researcher',
      reason: 'The objective requires research.',
      selectionAgentId: 'task-preparer',
      selectionRunId: 'selection-1',
    };
    const { runtime, messages } = createRuntime();
    await runtime.handleRpc(request({ id: 'init', method: 'initialize', params: { protocolVersion: '1.19', clientInfo: { name: 'desktop' } } }));
    Object.assign(runtime as unknown as Record<string, unknown>, {
      sdk: fallback,
      selectDesktopRunSdk: vi.fn(async () => ({ sdk: selectedSdk, selection })),
      prepareRunTask: vi.fn(async () => undefined),
    });

    await expect(runtime.handleRpc(request({
      id: 'run-auto', method: 'agent/run', params: { executionId: 'execution-auto', goal: 'research it', sessionId: 'session-auto' },
    }))).resolves.toMatchObject({ status: 'success', finalRunId: 'execution-auto' });
    expect(selectedRunRaw).toHaveBeenCalledWith('research it', expect.objectContaining({
      runId: 'execution-auto',
      sessionId: 'session-auto',
      metadata: { agentSelection: expect.objectContaining({
        selectedAgentId: 'researcher',
        selectionRunId: 'selection-1',
      }) },
    }));
    expect(messages).toContainEqual({
      jsonrpc: '2.0',
      method: 'agent/event',
      params: {
        schemaVersion: 1,
        type: 'run.agent_selected',
        runId: 'execution-auto',
        payload: { agentId: 'researcher', agentName: 'Research Agent' },
      },
    });
  });

  it('keeps selector lifecycle internal while target lifecycle and synthetic selection remain visible', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'desktop-auto-events-'));
    const fallbackPath = join(cwd, 'agent.json');
    const selectorPath = join(cwd, 'selector.json');
    const targetPath = join(cwd, 'target.json');
    const agent = (id: string, name: string) => ({
      id, name, invocationModes: ['run'], defaultInvocationMode: 'run',
      model: { provider: 'ollama', model: 'test-model' }, tools: [],
    });
    await writeFile(fallbackPath, JSON.stringify(agent('fallback', 'Fallback')));
    await writeFile(selectorPath, JSON.stringify(agent('selector', 'Selector')));
    await writeFile(targetPath, JSON.stringify(agent('target', 'Target')));
    await writeFile(join(cwd, 'agent.settings.json'), JSON.stringify({ agents: { dirs: [cwd] } }));

    const sharedRuntime = {};
    const targetRunRaw = vi.fn(async () => ({ status: 'success', runId: 'execution-auto-events', output: 'done', stepsUsed: 1, usage: {} }));
    let targetListener: ((event: any) => void) | undefined;
    const create = vi.spyOn(AgentSdk, 'create').mockImplementation(async (options) => {
      if (!options) throw new Error('Expected SDK options.');
      if (options.agentConfigPath === selectorPath) {
        options.eventListener?.({ schemaVersion: 1, type: 'run.completed', runId: 'selector-run', payload: {} } as any);
        return {
          config: { agent: { id: 'selector', tools: [] } },
          runRaw: vi.fn(async () => ({
            status: 'success', runId: 'selector-run', stepsUsed: 1, usage: {},
            output: { selectedAgentId: 'target', reason: 'Best match.' },
          })),
          close: vi.fn(async () => undefined),
        } as unknown as AgentSdk;
      }
      targetListener = options.eventListener;
      return {
        agentPath: targetPath,
        config: { agent: agent('target', 'Target'), workspaceRoot: cwd, settings: {} },
        created: { runtime: sharedRuntime },
        runRaw: targetRunRaw,
        close: vi.fn(async () => undefined),
      } as unknown as AgentSdk;
    });
    const { runtime, messages } = createRuntime();
    await runtime.handleRpc(request({ id: 'init', method: 'initialize', params: { protocolVersion: '1.19', clientInfo: { name: 'desktop' } } }));
    const fallback = {
      agentPath: fallbackPath,
      config: {
        agent: agent('fallback', 'Fallback'), workspaceRoot: cwd,
        settings: { agent: { mode: 'auto' }, taskPreparation: { agent: selectorPath } },
      },
      created: { runtime: sharedRuntime },
      close: vi.fn(async () => undefined),
    } as unknown as AgentSdk;
    Object.assign(runtime as unknown as Record<string, unknown>, {
      sdk: fallback,
      sdkOptions: { cwd, eventListener: (event: any) => (runtime as any).writeAgentEvent(event) },
      settingsCwd: cwd,
    });

    try {
      const selected = await (runtime as unknown as { selectDesktopRunSdk: Function })
        .selectDesktopRunSdk(fallback, 'Research it', [], 'session-auto-events');
      expect(selected).toMatchObject({
        sdk: { config: { agent: { id: 'target' } } },
        selection: { selectedAgentId: 'target', selectionAgentId: 'selector', selectionRunId: 'selector-run' },
      });
      expect(create.mock.calls[0]?.[0]).toMatchObject({
        agentConfigPath: selectorPath, runtime: sharedRuntime, eventListener: undefined,
      });
      expect(typeof targetListener).toBe('function');
      expect(messages).not.toContainEqual(expect.objectContaining({
        method: 'agent/event', params: expect.objectContaining({ runId: 'selector-run' }),
      }));

      (runtime as any).writeRunAgentSelected('execution-auto-events', selected.sdk);
      targetListener?.({ schemaVersion: 1, type: 'run.completed', runId: 'execution-auto-events', payload: {} });
      expect(messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: 'agent/event', params: expect.objectContaining({ type: 'run.agent_selected', runId: 'execution-auto-events' }) }),
        expect.objectContaining({ method: 'agent/event', params: expect.objectContaining({ type: 'run.completed', runId: 'execution-auto-events' }) }),
      ]));
    } finally {
      create.mockRestore();
      await runtime.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('routes image and audio to catalog orchestration when no single run profile supports both', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'desktop-mixed-media-'));
    const selectorPath = join(cwd, 'selector.json');
    const agent = (id: string, modalities: string[]) => ({
      id, name: id, invocationModes: ['run'], defaultInvocationMode: 'run',
      model: { provider: 'ollama', model: 'test-model' }, tools: [],
      capabilities: { modalitiesSupported: modalities },
    });
    await writeFile(join(cwd, 'agent.json'), JSON.stringify(agent('fallback', ['text'])));
    await writeFile(selectorPath, JSON.stringify(agent('selector', ['text'])));
    await writeFile(join(cwd, 'image.json'), JSON.stringify(agent('image', ['text', 'image'])));
    await writeFile(join(cwd, 'audio.json'), JSON.stringify(agent('audio', ['text', 'audio'])));
    await writeFile(join(cwd, 'agent.settings.json'), JSON.stringify({ agents: { dirs: [cwd] } }));
    const runRaw = vi.fn();
    const close = vi.fn(async () => undefined);
    const create = vi.spyOn(AgentSdk, 'create').mockResolvedValue({
      config: { agent: { id: 'selector', tools: [] } }, runRaw, close,
    } as unknown as AgentSdk);
    const { runtime } = createRuntime();
    const fallback = {
      config: { agent: agent('fallback', ['text']), workspaceRoot: cwd, settings: { agent: { mode: 'auto' }, taskPreparation: { agent: selectorPath } } },
      created: { runtime: {} },
    } as unknown as AgentSdk;
    Object.assign(runtime as unknown as Record<string, unknown>, { sdkOptions: { cwd }, settingsCwd: cwd });

    try {
      const selected = await (runtime as unknown as { selectDesktopRunSdk: Function }).selectDesktopRunSdk(
        fallback, 'Extract text and transcribe audio', [
          { kind: 'image', stagedRelativePath: 'image/diagram.png' },
          { kind: 'audio', stagedRelativePath: 'audio/recording.mp3' },
        ], 'session-mixed',
      );
      expect(selected).toEqual({ sdk: fallback });
      expect(runRaw).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      create.mockRestore();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns a terminal preparation result when fail mode needs clarification', async () => {
    const runRaw = vi.fn();
    const preparation = {
      originalObjective: 'deploy it', decision: 'clarify', preparedObjective: '', assumptions: [],
      title: 'Deploy Application', name: 'deploy-application',
      clarificationQuestions: ['Which environment should receive the deployment?'], reason: 'The target environment changes the operation.',
      preparationAgentId: 'task-preparer', preparationRunId: 'preparation-2',
    } as const;
    const { runtime } = createRuntime();
    await runtime.handleRpc(request({ id: 'init', method: 'initialize', params: { protocolVersion: '1.17', clientInfo: { name: 'desktop' } } }));
    Object.assign(runtime as unknown as Record<string, unknown>, {
      sdk: { runRaw, config: { agent: { id: 'deployer', name: 'Deployer' }, interaction: { clarificationMode: 'fail' }, workspaceRoot: '/workspace', settings: { taskPreparation: { mode: 'auto' } } } },
      prepareRunTask: vi.fn(async () => preparation),
    });

    await expect(runtime.handleRpc(request({
      id: 'run', method: 'agent/run', params: { executionId: 'execution-2', goal: 'deploy it' },
    }))).resolves.toMatchObject({
      executionId: 'execution-2', status: 'task_preparation_stopped', finalRunId: 'preparation-2',
      result: { decision: 'clarify', taskPreparation: { clarificationQuestions: ['Which environment should receive the deployment?'] } },
    });
    expect(runRaw).not.toHaveBeenCalled();
  });

  it('durably resumes interactive task preparation without losing the target execution request', async () => {
    const firstPreparation: TaskPreparationResult = {
      originalObjective: 'deploy it', decision: 'clarify', preparedObjective: '', assumptions: [],
      title: 'Deploy Application', name: 'deploy-application',
      clarificationQuestions: ['Which environment?', 'Which release?'], reason: 'Deployment details are required.',
      preparationAgentId: 'task-preparer', preparationRunId: 'preparation-interactive-1',
    };
    const completedPreparation: TaskPreparationResult = {
      ...firstPreparation,
      decision: 'enhance' as const,
      preparedObjective: 'Deploy release 42 to staging.',
      clarificationQuestions: [],
      reason: 'The answer supplied the deployment details.',
      preparationRunId: 'preparation-interactive-2',
    };
    const runs = new Map<string, any>([[firstPreparation.preparationRunId, preparationRun(firstPreparation)]]);
    const runStore = {
      getRun: vi.fn(async (id: string) => runs.get(id) ?? null),
      updateRun: vi.fn(async (id: string, patch: any) => {
        const updated = { ...runs.get(id), ...patch, version: runs.get(id).version + 1 };
        runs.set(id, updated);
        return updated;
      }),
    };
    const runRaw = vi.fn(async () => ({ status: 'success', runId: 'execution-interactive', output: 'done', stepsUsed: 1, usage: {} }));
    const sdk = desktopPreparationTarget(runStore, runRaw);
    const selection = {
      selectedAgentId: 'deployer', reason: 'Deployment task', selectionAgentId: 'selector', selectionRunId: 'selection-1',
    };
    const attachment = {
      attachmentId: 'file-1', kind: 'file' as const, stagedRelativePath: 'file-1/release.txt', name: 'release.txt',
      sizeBytes: 12, sha256: 'a'.repeat(64), mimeType: 'text/plain',
    };
    const parts = [{ type: 'file', file: { source: { kind: 'path', path: '/managed/file-1/release.txt' }, name: 'release.txt' } }];
    const fileAccess = {
      version: 1, workspaceRoot: '/workspace', attachmentRoots: ['/managed/file-1'],
      files: [{ path: '/managed/file-1/release.txt', sizeBytes: 12, sha256: 'a'.repeat(64) }],
    };
    const firstBridge = createRuntime();
    const first = firstBridge.runtime;
    await first.handleRpc(request({ id: 'init', method: 'initialize', params: { protocolVersion: '1.19', clientInfo: { name: 'desktop' } } }));
    Object.assign(first as unknown as Record<string, unknown>, {
      sdk,
      selectDesktopRunSdk: vi.fn(async () => ({ sdk, selection })),
      validateAndTranslateAttachments: vi.fn(async () => parts),
      fileAccessContext: vi.fn(async () => fileAccess),
      prepareRunTask: vi.fn(async () => firstPreparation),
    });

    await expect(first.handleRpc(request({
      id: 'run', method: 'agent/run', params: {
        executionId: 'execution-interactive', sessionId: 'session-interactive', goal: 'deploy it',
        input: { releaseId: 42 }, inferenceTier: 'high', attachments: [attachment],
      },
    }))).resolves.toMatchObject({
      executionId: 'execution-interactive', status: 'clarification_requested', finalRunId: firstPreparation.preparationRunId,
      result: {
        status: 'clarification_requested', runId: firstPreparation.preparationRunId,
        suggestedQuestions: ['Which environment?', 'Which release?'],
        message: expect.stringContaining('one free-form answer covering all questions'),
      },
    });
    expect(runRaw).not.toHaveBeenCalled();
    expect(firstBridge.messages).not.toContainEqual(expect.objectContaining({
      method: 'agent/event', params: expect.objectContaining({ runId: firstPreparation.preparationRunId }),
    }));

    // A new bridge instance proves resolution depends on the durable run marker, not an in-memory map.
    runs.set(completedPreparation.preparationRunId, preparationRun(completedPreparation));
    const restartedBridge = createRuntime();
    const restarted = restartedBridge.runtime;
    await restarted.handleRpc(request({ id: 'restart-init', method: 'initialize', params: { protocolVersion: '1.19', clientInfo: { name: 'desktop' } } }));
    const prepareRunTask = vi.fn(async () => completedPreparation);
    Object.assign(restarted as unknown as Record<string, unknown>, { sdk, prepareRunTask });

    await expect(restarted.handleRpc(request({
      id: 'answer', method: 'interaction/resolveClarification',
      params: { runId: firstPreparation.preparationRunId, answer: 'Use staging and release 42.' },
    }))).resolves.toMatchObject({ status: 'success', runId: 'execution-interactive' });
    expect(prepareRunTask).toHaveBeenCalledWith(
      sdk,
      'deploy it',
      [],
      'session-interactive',
      {
        'Which environment?': 'Use staging and release 42.',
        'Which release?': 'Use staging and release 42.',
      },
      { images: [], files: ['file-1/release.txt'], audio: [] },
    );
    expect(runRaw).toHaveBeenCalledWith('Deploy release 42 to staging.', expect.objectContaining({
      runId: 'execution-interactive',
      sessionId: 'session-interactive',
      input: { releaseId: 42 },
      contentParts: parts,
      executionContext: { fileAccess },
      inferenceTier: 'high',
      metadata: {
        agentSelection: expect.objectContaining({ selectedAgentId: 'deployer', selectionRunId: 'selection-1' }),
        taskPreparation: expect.objectContaining({
          preparationRunIds: ['preparation-interactive-1', 'preparation-interactive-2'],
          runs: [expect.objectContaining({ decision: 'clarify' }), expect.objectContaining({ decision: 'enhance' })],
        }),
      },
    }));
    expect(restartedBridge.messages).not.toContainEqual(expect.objectContaining({
      method: 'agent/event', params: expect.objectContaining({ runId: completedPreparation.preparationRunId }),
    }));
  });

  it('keeps repeated preparation clarification pending and terminates an invalid follow-up', async () => {
    const initial = taskPreparationResult('preparation-repeat-1', 'clarify', ['Choose a region.']);
    const repeated = taskPreparationResult('preparation-repeat-2', 'clarify', ['Confirm us-west-2.']);
    const invalid = taskPreparationResult('preparation-repeat-3', 'invalid', []);
    const runs = new Map<string, any>([[initial.preparationRunId, preparationRun(initial)]]);
    const runStore = {
      getRun: vi.fn(async (id: string) => runs.get(id) ?? null),
      updateRun: vi.fn(async (id: string, patch: any) => {
        const updated = { ...runs.get(id), ...patch, version: runs.get(id).version + 1 };
        runs.set(id, updated);
        return updated;
      }),
    };
    const runRaw = vi.fn();
    const sdk = desktopPreparationTarget(runStore, runRaw);
    const bridge = createRuntime();
    const runtime = bridge.runtime;
    await runtime.handleRpc(request({ id: 'init', method: 'initialize', params: { protocolVersion: '1.19', clientInfo: { name: 'desktop' } } }));
    Object.assign(runtime as unknown as Record<string, unknown>, { sdk, prepareRunTask: vi.fn(async () => initial) });
    await runtime.handleRpc(request({ id: 'run', method: 'agent/run', params: { executionId: 'execution-repeat', goal: 'deploy' } }));

    runs.set(repeated.preparationRunId, preparationRun(repeated));
    Object.assign(runtime as unknown as Record<string, unknown>, { prepareRunTask: vi.fn(async () => repeated) });
    await expect(runtime.handleRpc(request({
      id: 'again', method: 'interaction/resolveClarification', params: { runId: initial.preparationRunId, answer: 'us-west-2' },
    }))).resolves.toMatchObject({ status: 'clarification_requested', runId: repeated.preparationRunId });
    expect(runs.get(initial.preparationRunId).metadata.desktopTaskPreparation).toBeUndefined();
    expect(runs.get(repeated.preparationRunId).metadata.desktopTaskPreparation).toBeDefined();
    expect(runRaw).not.toHaveBeenCalled();
    expect(bridge.messages).not.toContainEqual(expect.objectContaining({
      method: 'agent/event', params: expect.objectContaining({ runId: repeated.preparationRunId }),
    }));

    runs.set(invalid.preparationRunId, preparationRun(invalid));
    Object.assign(runtime as unknown as Record<string, unknown>, { prepareRunTask: vi.fn(async () => invalid) });
    await expect(runtime.handleRpc(request({
      id: 'invalid', method: 'interaction/resolveClarification', params: { runId: repeated.preparationRunId, answer: 'confirmed' },
    }))).resolves.toMatchObject({ status: 'task_preparation_stopped', decision: 'invalid', runId: invalid.preparationRunId });
    expect(runRaw).not.toHaveBeenCalled();
  });

  it('still routes ordinary core clarification to the core resolver', async () => {
    const resolveClarification = vi.fn(async () => ({ status: 'success', runId: 'ordinary-run', output: 'done', stepsUsed: 1, usage: {} }));
    const sdk = {
      created: { runtime: { runStore: { getRun: vi.fn(async () => ({ id: 'ordinary-run', metadata: {}, rootRunId: 'ordinary-run' })) } } },
      agent: { resolveClarification },
      config: { agent: { id: 'agent' } },
    };
    const runtime = createRuntime().runtime;
    await initialize(runtime);
    Object.assign(runtime as unknown as Record<string, unknown>, { sdk });
    await expect(runtime.handleRpc(request({
      id: 'ordinary', method: 'interaction/resolveClarification', params: { runId: 'ordinary-run', answer: 'Use Markdown.' },
    }))).resolves.toMatchObject({ status: 'success', runId: 'ordinary-run' });
    expect(resolveClarification).toHaveBeenCalledWith('ordinary-run', 'Use Markdown.');
  });

  it('runs configured task preparation in the shared runtime with attachment summaries', async () => {
    const sharedRuntime = {};
    const preparationRunRaw = vi.fn(async () => ({
      status: 'success', runId: 'preparation-3', stepsUsed: 1, usage: {},
      output: { title: 'Review Files', name: 'review-files', decision: 'complete', preparedObjective: 'Review the files', assumptions: [], clarificationQuestions: [], reason: 'Already executable.' },
    }));
    const close = vi.fn(async () => undefined);
    const create = vi.spyOn(AgentSdk, 'create').mockResolvedValue({
      config: { agent: { id: 'task-preparer', tools: [] } }, runRaw: preparationRunRaw, close,
    } as unknown as AgentSdk);
    const { runtime, messages } = createRuntime();
    Object.assign(runtime as unknown as Record<string, unknown>, {
      sdkOptions: { cwd: '/workspace', eventListener: (event: any) => (runtime as any).writeAgentEvent(event) },
      settingsCwd: '/workspace',
    });
    const target = {
      config: {
        settings: { taskPreparation: { mode: 'auto', agent: './agents/task-preparer.json' } },
        agent: { id: 'target', name: 'Target', invocationModes: ['run'], defaultInvocationMode: 'run', model: {}, tools: [] },
        workspaceRoot: '/workspace',
      },
      created: { runtime: sharedRuntime },
    } as unknown as AgentSdk;
    const attachments = [
      { attachmentId: 'file-1', kind: 'file', stagedRelativePath: 'file-1/notes.txt', name: 'notes.txt', sizeBytes: 1, sha256: 'a'.repeat(64) },
      { attachmentId: 'image-1', kind: 'image', stagedRelativePath: 'image-1/photo.png', name: 'photo.png', sizeBytes: 1, sha256: 'b'.repeat(64) },
    ] as const;

    await expect((runtime as unknown as { prepareRunTask: Function }).prepareRunTask(target, 'Review the files', attachments, 'session-3'))
      .resolves.toMatchObject({ decision: 'complete', preparationRunId: 'preparation-3' });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      agentConfigPath: './agents/task-preparer.json', runtime: sharedRuntime, settingsOverrides: undefined, eventListener: undefined,
    }));
    expect(preparationRunRaw).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      sessionId: 'session-3',
      input: expect.objectContaining({ attachments: { files: ['file-1/notes.txt'], images: ['image-1/photo.png'], audio: [] } }),
    }));
    expect(messages).not.toContainEqual(expect.objectContaining({ method: 'agent/event' }));
    expect(close).toHaveBeenCalledOnce();
    create.mockRestore();
  });

  it('projects only allowlisted resolved settings and credential availability', () => {
    const summary = safeResolvedConfiguration({
      agent: { id: 'agent-1', name: 'Researcher', description: 'Finds facts', invocationModes: ['run'], defaultInvocationMode: 'run' },
      model: { provider: 'openrouter', model: 'test-model', apiKey: 'never-expose-this' },
      inference: { mode: 'byok', tier: 'medium' },
      runtime: { requestedMode: 'sqlite', mode: 'sqlite', autoMigrate: true, sqlitePath: '/tmp/runtime.sqlite' },
      workspaceRoot: '/workspace',
      shellCwd: '/workspace/project',
      interaction: { approvalMode: 'reject', clarificationMode: 'fail' },
    } as ResolvedAgentSdkConfig);

    expect(summary).toMatchObject({
      agent: { id: 'agent-1', name: 'Researcher', defaultInvocationMode: 'run', configurationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) },
      model: { provider: 'openrouter', model: 'test-model', credentialAvailable: true },
      inference: { mode: 'byok' },
      interaction: { approvalMode: 'reject', clarificationMode: 'fail' },
    });
    expect(JSON.stringify(summary)).not.toContain('never-expose-this');
  });

  it('produces a deterministic, change-sensitive fingerprint without hashing credential values into output', () => {
    const base = {
      agent: { id: 'agent-1', name: 'Researcher', description: 'Be precise', invocationModes: ['run'], defaultInvocationMode: 'run' },
      model: { provider: 'openrouter', model: 'test-model', apiKey: 'first-secret' },
      inference: { mode: 'byok', tier: 'medium' },
      runtime: { requestedMode: 'sqlite', mode: 'sqlite', autoMigrate: true, sqlitePath: '/tmp/runtime.sqlite' },
      workspaceRoot: '/workspace', shellCwd: '/workspace',
      interaction: { approvalMode: 'reject', clarificationMode: 'fail' },
    } as unknown as ResolvedAgentSdkConfig;
    const first = safeResolvedConfiguration(base).agent.configurationFingerprint;
    const credentialChanged = safeResolvedConfiguration({ ...base, model: { ...base.model, apiKey: 'second-secret' } }).agent.configurationFingerprint;
    const instructionsChanged = safeResolvedConfiguration({ ...base, agent: { ...base.agent, description: 'Be concise' } }).agent.configurationFingerprint;
    expect(credentialChanged).toBe(first);
    expect(instructionsChanged).not.toBe(first);
  });

  it('rejects conflicting reject and auto-approve settings for restricted desktop runs', () => {
    expect(() => validateRestrictedDesktopConfiguration({
      agent: { id: 'agent-1', name: 'Researcher', invocationModes: ['run'], defaultInvocationMode: 'run' },
      settings: { defaults: { autoApproveAll: true } },
      model: { provider: 'openrouter', model: 'test-model', apiKey: 'available' },
      inference: { mode: 'byok', tier: 'medium' },
      runtime: { requestedMode: 'memory', mode: 'memory', autoMigrate: true },
      workspaceRoot: '/workspace', shellCwd: '/workspace',
      interaction: { approvalMode: 'reject', clarificationMode: 'fail' },
    } as ResolvedAgentSdkConfig)).toThrow(/conflicts with defaults\.autoApproveAll true/);
  });

  it('fails closed unless restricted desktop execution resolves an exact SQLite path', () => {
    const config = {
      agent: { id: 'agent-1', name: 'Researcher', invocationModes: ['run'], defaultInvocationMode: 'run' },
      settings: {}, model: { provider: 'ollama', model: 'test-model' },
      inference: { mode: 'byok', tier: 'medium' }, workspaceRoot: '/workspace', shellCwd: '/workspace',
      interaction: { approvalMode: 'reject', clarificationMode: 'fail' },
    } as ResolvedAgentSdkConfig;
    expect(() => validateRestrictedDesktopConfiguration({ ...config, runtime: { requestedMode: 'memory', mode: 'memory', autoMigrate: true } })).toThrow(/runtime\.mode must be "sqlite"/);
    expect(() => validateRestrictedDesktopConfiguration({ ...config, runtime: { requestedMode: 'sqlite', mode: 'sqlite', autoMigrate: true, sqlitePath: '  ' } })).toThrow(/non-empty exact path/);
    expect(() => validateRestrictedDesktopConfiguration({ ...config, runtime: { requestedMode: 'sqlite', mode: 'sqlite', autoMigrate: true, sqlitePath: '/exact/runtime.sqlite' } })).not.toThrow();
  });

  it('permits manual approval but rejects interactive clarification', () => {
    const config = {
      agent: { id: 'agent-1', name: 'Researcher', invocationModes: ['run'], defaultInvocationMode: 'run' }, settings: {},
      model: { provider: 'ollama', model: 'test-model' }, inference: { mode: 'byok', tier: 'medium' },
      runtime: { requestedMode: 'sqlite', mode: 'sqlite', autoMigrate: true, sqlitePath: '/exact/runtime.sqlite' },
      workspaceRoot: '/workspace', shellCwd: '/workspace', interaction: { approvalMode: 'manual', clarificationMode: 'fail' },
    } as ResolvedAgentSdkConfig;
    expect(() => validateRestrictedDesktopConfiguration(config)).not.toThrow();
    expect(() => validateRestrictedDesktopConfiguration({ ...config, interaction: { ...config.interaction, clarificationMode: 'interactive' } })).toThrow(/clarificationMode must be "fail"/);
  });

  it('requires and negotiates the JSON-RPC protocol handshake', async () => {
    const { runtime } = createRuntime();
    await expect(runtime.handleRpc(request({ id: 1, method: 'runtime/info' }))).rejects.toMatchObject({
      code: 'NOT_INITIALIZED',
      jsonRpcCode: JSON_RPC_ERROR_CODES.notInitialized,
    });

    const result = await runtime.handleRpc(request({
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '1.10', clientInfo: { name: 'desktop' } },
    }));
    expect(result).toMatchObject({ protocolVersion: '1.10' });
  });

  it('reports supported versions when negotiation fails', async () => {
    const { runtime } = createRuntime();
    await expect(runtime.handleRpc(request({
      id: 'init',
      method: 'initialize',
      params: { protocolVersion: '2.0', clientInfo: { name: 'desktop' } },
    }))).rejects.toMatchObject({
      code: 'UNSUPPORTED_PROTOCOL_VERSION',
      data: { supportedProtocolVersions: ['1.10', '1.11', '1.12', '1.13', '1.14', '1.15', '1.16', '1.17', '1.18', '1.19'] },
    });
  });

  it('lists safe agent selection descriptors in protocol 1.18', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'desktop-agents-'));
    const agentPath = join(cwd, 'agent.json');
    await writeFile(agentPath, JSON.stringify({
      id: 'desktop-agent',
      name: 'Desktop Agent',
      invocationModes: ['run'],
      defaultInvocationMode: 'run',
      model: { provider: 'ollama', model: 'test-model', apiKey: 'must-not-leak' },
      tools: ['not-registered'],
      systemInstructions: 'private prompt',
    }));
    await writeFile(join(cwd, 'agent.settings.json'), JSON.stringify({ runtime: { mode: 'memory' } }));
    const legacy = createRuntime().runtime;
    const current = createRuntime().runtime;
    try {
      const legacyHandshake = await legacy.handleRpc(request({ id: 'legacy', method: 'initialize', params: { protocolVersion: '1.17', clientInfo: { name: 'desktop' } } })) as any;
      expect(legacyHandshake.capabilities.methods).not.toContain('agents/list');
      await expect(legacy.handleRpc(request({ id: 'agents', method: 'agents/list', params: { cwd } }))).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });

      const handshake = await current.handleRpc(request({ id: 'current', method: 'initialize', params: { protocolVersion: '1.18', clientInfo: { name: 'desktop' } } })) as any;
      expect(handshake.capabilities.methods).toContain('agents/list');
      const discovery = await current.handleRpc(request({ id: 'agents', method: 'agents/list', params: { cwd } })) as any;
      expect(discovery).toMatchObject({
        currentAgent: { id: 'desktop-agent', configPath: agentPath, validationState: 'valid' },
        settingsPath: join(cwd, 'agent.settings.json'),
        diagnostics: [],
      });
      expect(discovery.currentAgent.configurationFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(discovery)).not.toContain('must-not-leak');
      expect(JSON.stringify(discovery)).not.toContain('private prompt');
    } finally {
      await legacy.close();
      await current.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('advertises managed image and audio capabilities in protocol 1.17', async () => {
    const current = createRuntime().runtime;
    const initialized = await current.handleRpc(request({
      id: 'current', method: 'initialize', params: { protocolVersion: '1.17', clientInfo: { name: 'desktop' } },
    })) as any;
    expect(initialized.capabilities.attachments).toMatchObject({
      enabled: false,
      acceptedKinds: ['file', 'image', 'audio'],
      supportedImageMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      supportedAudioMimeTypes: ['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/flac', 'audio/mp4', 'audio/ogg', 'audio/aac', 'audio/aiff'],
      supportedAudioFormats: ['wav', 'mp3', 'flac', 'm4a', 'ogg', 'aac', 'aiff', 'pcm16', 'pcm24'],
      routing: { taskImage: 'catalog', taskAudio: 'catalog', chatImage: 'direct', chatAudio: 'direct' },
    });

    const legacy = createRuntime().runtime;
    const legacyInitialized = await legacy.handleRpc(request({
      id: 'legacy', method: 'initialize', params: { protocolVersion: '1.16', clientInfo: { name: 'desktop' } },
    })) as any;
    expect(legacyInitialized.capabilities.attachments).toMatchObject({ acceptedKinds: ['file'] });
  });

  it('exposes agent builder methods only in protocol 1.15', async () => {
    const legacy = createRuntime().runtime;
    const legacyInitialized = await legacy.handleRpc(request({ id: 'legacy', method: 'initialize', params: { protocolVersion: '1.14', clientInfo: { name: 'desktop' } } })) as any;
    expect(legacyInitialized.capabilities.methods).not.toContain('agent/validateConfig');
    await expect(legacy.handleRpc(request({ id: 'builder', method: 'agent/validateConfig', params: { agent: {} } }))).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });

    const current = createRuntime().runtime;
    const initialized = await current.handleRpc(request({ id: 'current', method: 'initialize', params: { protocolVersion: '1.15', clientInfo: { name: 'desktop' } } })) as any;
    expect(initialized.capabilities.methods).toEqual(expect.arrayContaining(['agent/createDraft', 'agent/validateConfig', 'agent/saveConfig']));
    expect(initialized.capabilities.methods).not.toContain('agent/archiveConfig');

    const lifecycle = createRuntime().runtime;
    const lifecycleInitialized = await lifecycle.handleRpc(request({ id: 'lifecycle', method: 'initialize', params: { protocolVersion: '1.16', clientInfo: { name: 'desktop' } } })) as any;
    expect(lifecycleInitialized.capabilities.methods).toEqual(expect.arrayContaining(['agent/readConfig', 'agent/archiveConfig', 'agent/restoreConfig']));
  });

  it('forwards protocol 1.19 draft controls to the shared Agent SDK workflow', async () => {
    const prepared = {
      command: 'agent-create', brief: 'Build a reviewer',
      generatorAgent: { requested: 'architect', id: 'architect', name: 'Architect' },
      agentsDir: '/workspace/agents', path: '/workspace/agents/reviewer.json', exists: false,
      agent: { version: 1, id: 'reviewer', name: 'Reviewer' }, draft: { agent: { id: 'reviewer', name: 'Reviewer', systemInstructions: 'Review code.' } },
      notes: [], recommendations: [],
    } as any;
    const preview = {
      path: prepared.path, agentsDir: prepared.agentsDir, exists: false, duplicatePaths: [],
      targetFingerprint: 'absent', agent: prepared.agent,
    };
    const prepare = vi.spyOn(agentCreate, 'prepareAgentCreate').mockResolvedValue(prepared);
    const validate = vi.spyOn(agentCreate, 'prepareAgentConfigSave').mockResolvedValue(preview as any);
    const { runtime } = createRuntime();
    try {
      await runtime.handleRpc(request({ id: 'init', method: 'initialize', params: { protocolVersion: '1.19', clientInfo: { name: 'desktop' } } }));
      Object.assign(runtime as unknown as Record<string, unknown>, {
        sdk: { config: { agent: { id: 'current-agent' } }, close: vi.fn() },
        settingsCwd: '/workspace',
        settingsPath: '/workspace/agent.settings.json',
      });

      await expect(runtime.handleRpc(request({
        id: 'draft', method: 'agent/createDraft', params: {
          brief: 'Build a reviewer', generatorAgent: 'architect', id: 'reviewer', provider: 'mistral', model: 'codestral-latest',
        },
      }))).resolves.toMatchObject({ path: prepared.path, agent: prepared.agent, targetFingerprint: 'absent' });
      expect(prepare).toHaveBeenCalledWith({
        brief: 'Build a reviewer', cwd: '/workspace', settingsConfigPath: '/workspace/agent.settings.json',
        generatorAgent: 'architect', id: 'reviewer', provider: 'mistral', model: 'codestral-latest',
      });
      expect(validate).toHaveBeenCalledWith(expect.objectContaining({ agent: prepared.agent, generatorAgent: 'architect' }));
    } finally {
      prepare.mockRestore();
      validate.mockRestore();
      await runtime.close();
    }
  });

  it('rejects draft overrides negotiated before protocol 1.19', async () => {
    const { runtime } = createRuntime();
    await runtime.handleRpc(request({ id: 'init', method: 'initialize', params: { protocolVersion: '1.18', clientInfo: { name: 'desktop' } } }));
    await expect(runtime.handleRpc(request({
      id: 'draft', method: 'agent/createDraft', params: { brief: 'Build a reviewer', id: 'reviewer' },
    }))).rejects.toMatchObject({ code: 'INVALID_PARAMS', jsonRpcCode: JSON_RPC_ERROR_CODES.invalidParams });
  });

  it('inspects the desktop-safe catalog and pins an exact agent in protocol 1.14', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'desktop-catalog-'));
    const agentPath = join(cwd, 'agent.json');
    await writeFile(agentPath, JSON.stringify({ id: 'desktop-agent', name: 'Desktop Agent', invocationModes: ['run'], defaultInvocationMode: 'run', model: { provider: 'ollama', model: 'test-model' }, tools: [] }));
    await writeFile(join(cwd, 'agent.settings.json'), JSON.stringify({ runtime: { mode: 'memory' }, interaction: { approvalMode: 'manual', clarificationMode: 'interactive' } }));
    const { runtime } = createRuntime();
    try {
      const initialized = await runtime.handleRpc(request({ id: 'protocol', method: 'initialize', params: { protocolVersion: '1.14', clientInfo: { name: 'desktop' } } })) as any;
      expect(initialized.capabilities.methods).toContain('catalog/inspect');
      const catalog = await runtime.handleRpc(request({ id: 'catalog', method: 'catalog/inspect', params: { cwd } })) as any;
      expect(catalog).toMatchObject({ currentAgent: { id: 'desktop-agent', configPath: agentPath }, settingsPath: join(cwd, 'agent.settings.json'), diagnostics: [] });
      expect(catalog).not.toHaveProperty('config');
      expect(catalog).not.toHaveProperty('tools');
      const descriptor = catalog.currentAgent;
      const result = await runtime.handleRpc(request({ id: 'runtime', method: 'runtime/initialize', params: { cwd, runtimeMode: 'memory', agentSelection: { id: descriptor.id, configPath: descriptor.configPath, configurationFingerprint: descriptor.configurationFingerprint } } })) as any;
      expect(result).toMatchObject({ agent: { id: 'desktop-agent' }, runtimeMode: 'memory' });
      await expect(runtime.handleRpc(request({ id: 'again', method: 'catalog/inspect', params: { cwd } }))).rejects.toMatchObject({ code: 'ALREADY_INITIALIZED' });
    } finally {
      await runtime.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('prepares a handler-backed delegate during sidecar runtime initialization', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'desktop-skill-handler-'));
    const skillDir = join(cwd, 'skills', 'sidecar-skill');
    const dependencyDir = join(skillDir, 'node_modules', 'sidecar-dependency');
    await mkdir(dependencyDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), `---
name: sidecar-skill
description: Sidecar handler skill
handler: handler.ts
---

Use the sidecar handler.
`);
    await writeFile(join(skillDir, 'handler.ts'), `import { value } from 'sidecar-dependency';
export async function execute() { return { value }; }
`);
    await writeFile(join(skillDir, 'package.json'), JSON.stringify({ type: 'module', dependencies: { 'sidecar-dependency': '1.0.0' } }));
    await writeFile(join(dependencyDir, 'package.json'), JSON.stringify({ name: 'sidecar-dependency', version: '1.0.0', type: 'module', exports: './index.js' }));
    await writeFile(join(dependencyDir, 'index.js'), `export const value = 'sidecar';\n`);
    const agentPath = join(cwd, 'agent.json');
    await writeFile(agentPath, JSON.stringify({
      id: 'desktop-skill-agent',
      name: 'Desktop Skill Agent',
      invocationModes: ['run'],
      defaultInvocationMode: 'run',
      model: { provider: 'ollama', model: 'test-model' },
      tools: [],
      delegates: ['sidecar-skill'],
    }));
    const home = join(cwd, 'home');
    await writeFile(join(cwd, 'agent.settings.json'), JSON.stringify({
      runtime: { mode: 'memory' },
      skills: { dirs: [join(cwd, 'skills')] },
      interaction: { approvalMode: 'manual', clarificationMode: 'interactive' },
      env: { ADAPTIVE_AGENT_HOME: home },
    }));
    const { runtime } = createRuntime();
    try {
      await runtime.handleRpc(request({ id: 'protocol', method: 'initialize', params: { protocolVersion: '1.16', clientInfo: { name: 'desktop' } } }));
      const catalog = await runtime.handleRpc(request({ id: 'catalog', method: 'catalog/inspect', params: { cwd } })) as any;
      const descriptor = catalog.currentAgent;
      const result = await runtime.handleRpc(request({
        id: 'runtime',
        method: 'runtime/initialize',
        params: {
          cwd,
          runtimeMode: 'memory',
          agentSelection: {
            id: descriptor.id,
            configPath: descriptor.configPath,
            configurationFingerprint: descriptor.configurationFingerprint,
          },
        },
      })) as any;

      expect(result.agent.id).toBe('desktop-skill-agent');
      expect(await readdir(join(home, 'cache', 'skill-handlers'))).toHaveLength(1);
    } finally {
      await runtime.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects stale fingerprints and wrong exact agent ids or paths', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'desktop-catalog-reject-'));
    const agentPath = join(cwd, 'agent.json');
    const writeAgent = (name: string) => writeFile(agentPath, JSON.stringify({ id: 'desktop-agent', name, invocationModes: ['run'], defaultInvocationMode: 'run', model: { provider: 'test', model: 'test-model' }, tools: [] }));
    await writeAgent('Original');
    await writeFile(join(cwd, 'agent.settings.json'), JSON.stringify({ runtime: { mode: 'memory' } }));
    const inspectRuntime = createRuntime().runtime;
    await inspectRuntime.handleRpc(request({ id: 'protocol', method: 'initialize', params: { protocolVersion: '1.14', clientInfo: { name: 'desktop' } } }));
    const descriptor = (await inspectRuntime.handleRpc(request({ id: 'catalog', method: 'catalog/inspect', params: { cwd } })) as any).currentAgent;
    await writeAgent('Changed');
    for (const selection of [
      descriptor,
      { ...descriptor, id: 'wrong-id' },
      { ...descriptor, configPath: join(cwd, 'missing.json') },
    ]) {
      const runtime = createRuntime().runtime;
      await runtime.handleRpc(request({ id: 'protocol', method: 'initialize', params: { protocolVersion: '1.14', clientInfo: { name: 'desktop' } } }));
      await expect(runtime.handleRpc(request({ id: 'runtime', method: 'runtime/initialize', params: { cwd, runtimeMode: 'memory', agentSelection: selection } }))).rejects.toMatchObject({ code: 'AGENT_SELECTION_MISMATCH', jsonRpcCode: JSON_RPC_ERROR_CODES.invalidParams });
      await runtime.close();
    }
    await inspectRuntime.close();
    await rm(cwd, { recursive: true, force: true });
  });

  it('uses an exact catalog selection instead of the settings startup-agent pin', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'desktop-catalog-selection-'));
    const startupPath = join(cwd, 'startup-agent.json');
    const selectedPath = join(cwd, 'selected-agent.json');
    const agent = (id: string) => ({ id, name: id, invocationModes: ['run'], defaultInvocationMode: 'run', model: { provider: 'mesh', model: 'test-model', apiKeyEnv: 'TEST_MESH_API_KEY' }, tools: [] });
    await writeFile(startupPath, JSON.stringify(agent('startup-agent')));
    await writeFile(selectedPath, JSON.stringify(agent('selected-agent')));
    await writeFile(join(cwd, 'agent.settings.json'), JSON.stringify({
      agent: { id: 'startup-agent', configPath: startupPath },
      agents: { dirs: [cwd] },
      runtime: { mode: 'memory' },
      env: { TEST_MESH_API_KEY: 'test-key' },
      inference: { mode: 'byok' },
      interaction: { approvalMode: 'auto', clarificationMode: 'fail' },
    }));
    const inspectRuntime = createRuntime().runtime;
    await inspectRuntime.handleRpc(request({ id: 'protocol', method: 'initialize', params: { protocolVersion: '1.16', clientInfo: { name: 'desktop' } } }));
    const catalog = await inspectRuntime.handleRpc(request({ id: 'catalog', method: 'catalog/inspect', params: { cwd } })) as any;
    const descriptor = catalog.agents.find((candidate: { id: string }) => candidate.id === 'selected-agent');
    expect(catalog.currentAgent.id).toBe('startup-agent');

    const selectedRuntime = createRuntime().runtime;
    try {
      await selectedRuntime.handleRpc(request({ id: 'protocol', method: 'initialize', params: { protocolVersion: '1.16', clientInfo: { name: 'desktop' } } }));
      const result = await selectedRuntime.handleRpc(request({ id: 'runtime', method: 'runtime/initialize', params: { cwd, runtimeMode: 'memory', inferenceMode: 'byok', approvalMode: 'auto', clarificationMode: 'fail', agentSelection: { id: descriptor.id, configPath: descriptor.configPath, configurationFingerprint: descriptor.configurationFingerprint } } })) as any;
      expect(result.agent.id).toBe('selected-agent');
    } finally {
      await selectedRuntime.close();
      await inspectRuntime.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('translates managed file, image, and audio attachments for runs and chats', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-attachments-'));
    const canonicalRoot = await realpath(root);
    const workspace = await mkdtemp(join(tmpdir(), 'desktop-workspace-'));
    const stage = async (attachmentId: string, name: string, content: Buffer) => {
      await mkdir(join(root, attachmentId));
      await writeFile(join(root, attachmentId, name), content);
      return {
        attachmentId,
        stagedRelativePath: `${attachmentId}/${name}`,
        name,
        sizeBytes: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
      };
    };
    const fileContent = Buffer.from('attachment contents');
    const file = {
      ...await stage('attachment-1', 'note.txt', fileContent),
      attachmentId: 'attachment-1',
      kind: 'file' as const,
      mimeType: 'text/plain',
    };
    const image = { ...await stage('attachment-image', 'photo.png', Buffer.from('image bytes')), kind: 'image' as const, mimeType: 'image/png' };
    const audio = { ...await stage('attachment-audio', 'recording.mp3', Buffer.from('audio bytes')), kind: 'audio' as const, mimeType: 'audio/mpeg', audioFormat: 'mp3' as const };
    const runRaw = vi.fn(async () => ({ status: 'success', runId: 'execution-1', output: 'done', stepsUsed: 1, usage: {} }));
    const chatRaw = vi.fn(async () => ({ status: 'success', runId: 'execution-chat', output: 'done', stepsUsed: 1, usage: {} }));
    const orchestrationRun = vi.fn(async (_goal: string, options: Record<string, unknown>) => ({
      sessionId: options.executionId,
      requestedAgentId: 'file-agent',
      detectedModalities: ['text', 'image', 'audio'],
      detectedSubjects: [],
      executionShape: 'parallel_fanout_then_synthesis',
      plan: { finalNodeId: 'final_synthesis' },
      stages: [
        { nodeId: 'image_specialist', stage: 'parallel_specialist', agentId: 'image-agent', runId: 'image-run', rootRunId: 'image-run', result: { status: 'success', runId: 'image-run', output: 'image', stepsUsed: 1, usage: {} } },
        { nodeId: 'audio_specialist', stage: 'parallel_specialist', agentId: 'audio-agent', runId: 'audio-run', rootRunId: 'audio-root', result: { status: 'failure', runId: 'audio-run', error: 'audio failed', code: 'MODEL_ERROR', stepsUsed: 1, usage: {} } },
        { nodeId: 'final_synthesis', stage: 'final_synthesis', agentId: 'file-agent', runId: 'final-run', rootRunId: 'final-root', result: { status: 'approval_requested', runId: 'final-run', approvalId: 'approval-1', rootRunId: 'final-root', message: 'Approve synthesis', toolName: 'write_report' } },
      ],
      finalResult: { status: 'approval_requested', runId: 'final-run', approvalId: 'approval-1', rootRunId: 'final-root', message: 'Approve synthesis', toolName: 'write_report' },
    } as unknown as OrchestratedRunResult));
    const orchestrationFactory: DesktopOrchestrationFactory = async () => ({
      runRaw: orchestrationRun,
      inspectExecution: vi.fn(),
      interruptExecution: vi.fn(),
      resumeExecution: vi.fn(),
      close: vi.fn(),
    });
    const { runtime } = createRuntime(undefined, orchestrationFactory);
    await runtime.handleRpc(request({
      id: 'init', method: 'initialize', params: { protocolVersion: '1.17', clientInfo: { name: 'desktop' } },
    }));
    Object.assign(runtime as unknown as Record<string, unknown>, {
      managedAttachmentRoot: root,
      settingsCwd: workspace,
      sdkOptions: { cwd: workspace },
      sdk: {
        agentPath: join(workspace, 'agent.json'),
        runRaw,
        chatRaw,
        created: { runtime: { orchestrationStore: new InMemoryOrchestrationStore() } },
        config: { agent: { id: 'file-agent', name: 'File Agent' }, workspaceRoot: workspace },
      },
    });
    await writeFile(join(workspace, 'agent.json'), JSON.stringify({ id: 'file-agent', name: 'File Agent', invocationModes: ['run'], defaultInvocationMode: 'run', model: { provider: 'ollama', model: 'test' }, tools: [] }));

    const catalogResult = await runtime.handleRpc(request({
      id: 'run', method: 'agent/run', params: { executionId: 'execution-1', goal: 'analyze them', attachments: [file, image, audio] },
    }));
    expect(catalogResult).toMatchObject({
      executionId: 'execution-1',
      mode: 'catalog',
      finalRunId: 'final-run',
      result: { status: 'approval_requested' },
    });
    expect((catalogResult as { stages: unknown }).stages).toEqual([
      { nodeId: 'image_specialist', stage: 'parallel_specialist', agentId: 'image-agent', runId: 'image-run', rootRunId: 'image-run', status: 'succeeded' },
      { nodeId: 'audio_specialist', stage: 'parallel_specialist', agentId: 'audio-agent', runId: 'audio-run', rootRunId: 'audio-root', status: 'failed' },
      { nodeId: 'final_synthesis', stage: 'final_synthesis', agentId: 'file-agent', runId: 'final-run', rootRunId: 'final-root', status: 'paused' },
    ]);
    expect(runRaw).not.toHaveBeenCalled();
    expect(orchestrationRun).toHaveBeenCalledWith('analyze them', expect.objectContaining({
      executionId: 'execution-1',
      contentParts: [
        expect.objectContaining({ type: 'file', file: expect.objectContaining({ name: 'note.txt', mimeType: 'text/plain' }) }),
        expect.objectContaining({ type: 'image', image: expect.objectContaining({ name: 'photo.png', mimeType: 'image/png' }) }),
        expect.objectContaining({ type: 'audio', audio: expect.objectContaining({ name: 'recording.mp3', mimeType: 'audio/mpeg', format: 'mp3' }) }),
      ],
      executionContext: { fileAccess: {
        version: 1,
        workspaceRoot: workspace,
        attachmentRoots: [join(canonicalRoot, 'attachment-1'), join(canonicalRoot, 'attachment-image'), join(canonicalRoot, 'attachment-audio')],
        files: expect.arrayContaining([
          { path: join(canonicalRoot, 'attachment-1', 'note.txt'), sizeBytes: fileContent.length, sha256: file.sha256 },
          { path: join(canonicalRoot, 'attachment-image', 'photo.png'), sizeBytes: image.sizeBytes, sha256: image.sha256 },
          { path: join(canonicalRoot, 'attachment-audio', 'recording.mp3'), sizeBytes: audio.sizeBytes, sha256: audio.sha256 },
        ]),
      } },
    }));

    await expect(runtime.handleRpc(request({
      id: 'chat', method: 'agent/chat', params: {
        executionId: 'execution-chat',
        chatSessionId: 'chat-session',
        transcript: [{ role: 'user', text: 'What is in these?', attachments: [image, audio] }],
      },
    }))).resolves.toMatchObject({ executionId: 'execution-chat', mode: 'direct', result: { status: 'success' } });
    expect(chatRaw).toHaveBeenCalledWith([{
      role: 'user',
      content: [
        { type: 'text', text: 'What is in these?' },
        expect.objectContaining({ type: 'image', image: expect.objectContaining({ path: join(canonicalRoot, 'attachment-image', 'photo.png') }) }),
        expect.objectContaining({ type: 'audio', audio: expect.objectContaining({ source: { kind: 'path', path: join(canonicalRoot, 'attachment-audio', 'recording.mp3') }, format: 'mp3' }) }),
      ],
    }], expect.objectContaining({ runId: 'execution-chat', sessionId: 'chat-session' }));

    const outside = `${root}-outside.txt`;
    await writeFile(outside, fileContent);
    await mkdir(join(root, 'attachment-2'));
    await symlink(outside, join(root, 'attachment-2', 'note.txt'));
    await expect(runtime.handleRpc(request({
      id: 'escape', method: 'agent/run', params: { executionId: 'execution-2', goal: 'read it', attachments: [{ ...file, attachmentId: 'attachment-2', stagedRelativePath: 'attachment-2/note.txt' }] },
    }))).rejects.toMatchObject({ code: 'ATTACHMENT_PATH_INVALID' });
    await rm(root, { recursive: true });
    await rm(workspace, { recursive: true });
    await rm(outside);
  });

  it('inspects, interrupts, and resumes durable catalog executions by execution id', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'desktop-catalog-controls-'));
    const store = new InMemoryOrchestrationStore();
    await writeFile(join(workspace, 'agent.json'), JSON.stringify({ id: 'general', name: 'General', invocationModes: ['run'], defaultInvocationMode: 'run', model: { provider: 'ollama', model: 'test' }, tools: [] }));
    await store.createExecution({
      id: 'execution-catalog',
      status: 'paused',
      request: { goal: 'analyze', options: {} },
      catalogFingerprint: 'catalog',
      plan: { sessionId: 'execution-catalog', requestedAgentId: 'general', finalNodeId: 'final_synthesis', nodes: [] },
      stages: [{ nodeId: 'final_synthesis', runId: 'final-run', agentId: 'general', status: 'paused' }],
    });
    const interruptExecution = vi.fn(async () => undefined);
    const resumeExecution = vi.fn(async () => ({
      sessionId: 'execution-catalog', requestedAgentId: 'general', detectedModalities: [], detectedSubjects: [], executionShape: 'single',
      plan: { finalNodeId: 'final_synthesis' },
      stages: [{
        nodeId: 'final_synthesis', stage: 'final_synthesis', agentId: 'general', runId: 'final-run', rootRunId: 'final-root',
        result: { status: 'success', runId: 'final-run', output: 'done', stepsUsed: 1, usage: {} },
      }],
      finalResult: { status: 'success', runId: 'final-run', output: 'done', stepsUsed: 1, usage: {} },
    } as unknown as OrchestratedRunResult));
    const orchestrationFactory: DesktopOrchestrationFactory = async () => ({
      runRaw: vi.fn(),
      inspectExecution: vi.fn(async () => ({
        execution: await store.getExecution('execution-catalog'),
        stages: await store.listStages('execution-catalog'),
        plan: { finalNodeId: 'final_synthesis' } as never,
      })),
      interruptExecution,
      resumeExecution,
      close: vi.fn(),
    });
    const { runtime } = createRuntime(undefined, orchestrationFactory);
    await runtime.handleRpc(request({ id: 'protocol', method: 'initialize', params: { protocolVersion: '1.17', clientInfo: { name: 'desktop' } } }));
    Object.assign(runtime as unknown as Record<string, unknown>, {
      settingsCwd: workspace,
      sdkOptions: { cwd: workspace },
      sdk: {
        agentPath: join(workspace, 'agent.json'),
        close: vi.fn(),
        created: { runtime: { orchestrationStore: store } },
        config: { agent: { id: 'general', name: 'General' }, workspaceRoot: workspace },
      },
    });

    await expect(runtime.handleRpc(request({ id: 'inspect', method: 'execution/inspect', params: { executionId: 'execution-catalog' } }))).resolves.toMatchObject({
      executionId: 'execution-catalog', mode: 'catalog', status: 'paused', finalRunId: 'final-run', traceTarget: { kind: 'session', sessionId: 'execution-catalog' },
    });
    await runtime.handleRpc(request({ id: 'interrupt', method: 'execution/interrupt', params: { executionId: 'execution-catalog' } }));
    expect(interruptExecution).toHaveBeenCalledWith('execution-catalog');
    await expect(runtime.handleRpc(request({ id: 'resume', method: 'execution/resume', params: { executionId: 'execution-catalog' } }))).resolves.toEqual({
      executionId: 'execution-catalog', mode: 'catalog', status: 'success', finalRunId: 'final-run', traceTarget: { kind: 'session', sessionId: 'execution-catalog' },
      stages: [{ nodeId: 'final_synthesis', stage: 'final_synthesis', agentId: 'general', runId: 'final-run', rootRunId: 'final-root', status: 'succeeded' }],
      result: { status: 'success', runId: 'final-run', output: 'done', stepsUsed: 1, usage: {} },
    });
    expect(resumeExecution).toHaveBeenCalledWith('execution-catalog');
    await runtime.close();
    await rm(workspace, { recursive: true, force: true });
  });

  it('redacts managed paths and file authority from inspect responses', async () => {
    const managedRoot = '/private/app/attachments/attachment-1';
    const inspect = vi.fn(async () => ({
      run: {
        id: 'run-1',
        status: 'succeeded',
        executionContext: {
          authorizationRef: 'retained-policy',
          fileAccess: { version: 1, workspaceRoot: '/workspace', attachmentRoots: [managedRoot] },
        },
      },
      events: [{ payload: { input: { path: `${managedRoot}/notes.txt` } } }],
    }));
    const { runtime } = createRuntime();
    await initialize(runtime);
    (runtime as unknown as { sdk: unknown }).sdk = { inspect };

    const replay = await runtime.handleRpc(request({
      id: 'replay', method: 'run/replay', params: { runId: 'run-1' },
    }));
    expect(JSON.stringify(replay)).not.toContain(managedRoot);
    expect(replay).toMatchObject({
      run: { executionContext: { authorizationRef: 'retained-policy' } },
      events: [{ payload: { input: { path: '[MANAGED_ATTACHMENT]/notes.txt' } } }],
    });
  });

  it('negotiates 1.11 and updates an access token without exposing it', async () => {
    const { runtime } = createRuntime();
    const initialized = await runtime.handleRpc(request({
      id: 'init',
      method: 'initialize',
      params: { protocolVersion: '1.11', clientInfo: { name: 'swift-host' } },
    })) as Record<string, unknown>;
    expect(initialized).toMatchObject({
      protocolVersion: '1.11',
      capabilities: { methods: expect.arrayContaining(['auth/updateAccessToken']) },
    });

    await expect(runtime.handleRpc(request({
      id: 'token',
      method: 'auth/updateAccessToken',
      params: { accessToken: 'swift-secret-token' },
    }))).resolves.toEqual({ updated: true });
    const info = await runtime.handleRpc(request({ id: 'info', method: 'runtime/info' }));
    expect(JSON.stringify(info)).not.toContain('swift-secret-token');
  });

  it('keeps protocol 1.10 behavior and does not expose the 1.11 token method', async () => {
    const { runtime } = createRuntime();
    const initialized = await runtime.handleRpc(request({
      id: 'init',
      method: 'initialize',
      params: { protocolVersion: '1.10', clientInfo: { name: 'legacy-host' } },
    })) as { capabilities: { methods: string[] } };
    expect(initialized.capabilities.methods).not.toContain('auth/updateAccessToken');
    expect(initialized.capabilities.methods).not.toContain('history/delete');
    await expect(runtime.handleRpc(request({
      id: 'token',
      method: 'auth/updateAccessToken',
      params: { accessToken: 'secret' },
    }))).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });
    await expect(runtime.handleRpc(request({
      id: 'history',
      method: 'history/delete',
      params: { target: { kind: 'root-run', rootRunId: 'root' } },
    }))).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });
  });

  it('dispatches Resume and Retry to their distinct runtime methods', async () => {
    const resumeRaw = vi.fn(async (runId: string) => ({ status: 'success', runId, output: 'resumed', stepsUsed: 1, usage: {} }));
    const retryRaw = vi.fn(async (runId: string) => ({ status: 'success', runId, output: 'retried', stepsUsed: 1, usage: {} }));
    const { runtime } = createRuntime();
    await initialize(runtime);
    (runtime as unknown as { sdk: unknown }).sdk = { resumeRaw, retryRaw };

    await expect(runtime.handleRpc(request({
      id: 'resume', method: 'run/resume', params: { runId: 'interrupted-run' },
    }))).resolves.toMatchObject({ runId: 'interrupted-run', output: 'resumed' });
    await expect(runtime.handleRpc(request({
      id: 'retry', method: 'run/retry', params: { runId: 'failed-run' },
    }))).resolves.toMatchObject({ runId: 'failed-run', output: 'retried' });

    expect(resumeRaw).toHaveBeenCalledWith('interrupted-run');
    expect(retryRaw).toHaveBeenCalledWith('failed-run');
  });

  it('dispatches constrained same-run recovery to core', async () => {
    const recoverRaw = vi.fn(async (options: { runId: string }) => ({ runId: options.runId, action: 'retry_same_run' }));
    const { runtime } = createRuntime();
    await initialize(runtime);
    (runtime as unknown as { sdk: unknown }).sdk = { recoverRaw };

    await expect(runtime.handleRpc(request({
      id: 'recover', method: 'run/recover', params: { runId: 'failed-run', strategy: 'same_run' },
    }))).resolves.toMatchObject({ runId: 'failed-run', action: 'retry_same_run' });
    expect(recoverRaw).toHaveBeenCalledWith({ runId: 'failed-run', strategy: 'same_run' });
  });

  it('exposes typed history maintenance only in protocol 1.12 with SQLite support', async () => {
    const previewDeletion = vi.fn(async (target) => ({ target, runIds: ['root'], rootRunIds: ['root'], ownedPlanIds: [], preservedPlanIds: [] }));
    const deleteHistory = vi.fn(async (target) => ({ target, runIds: ['root'], rootRunIds: ['root'], ownedPlanIds: [], preservedPlanIds: [] }));
    const { runtime } = createRuntime();
    const initialized = await runtime.handleRpc(request({
      id: 'init', method: 'initialize', params: { protocolVersion: '1.12', clientInfo: { name: 'desktop' } },
    })) as { capabilities: { methods: string[] } };
    expect(initialized.capabilities.methods).toEqual(expect.arrayContaining(['history/previewDeletion', 'history/delete']));
    (runtime as unknown as { sdk: unknown }).sdk = { created: { runtime: { maintenanceStore: { previewDeletion, deleteHistory } } } };

    await expect(runtime.handleRpc(request({
      id: 'preview', method: 'history/previewDeletion', params: { target: { kind: 'root-run', rootRunId: 'root' } },
    }))).resolves.toMatchObject({ runIds: ['root'] });
    await expect(runtime.handleRpc(request({
      id: 'delete', method: 'history/delete', params: { target: { kind: 'session', sessionId: 'session' } },
    }))).resolves.toMatchObject({ runIds: ['root'] });
    expect(previewDeletion).toHaveBeenCalledWith({ kind: 'root-run', rootRunId: 'root' });
    expect(deleteHistory).toHaveBeenCalledWith({ kind: 'session', sessionId: 'session' });

    (runtime as unknown as { sdk: unknown }).sdk = { created: { runtime: {} } };
    await expect(runtime.handleRpc(request({
      id: 'unsupported', method: 'history/delete', params: { target: { kind: 'root-run', rootRunId: 'root' } },
    }))).rejects.toMatchObject({ code: 'COMMAND_REJECTED' });
  });

  it('advertises and dispatches run/delete only in protocol 1.17 after runtime initialization', async () => {
    const deleteRun = vi.fn(async () => ({ deleted: true as const, rootRunId: 'root-run' }));
    const { runtime } = createRuntime();

    await expect(runtime.handleRpc(request({
      id: 'before-protocol', method: 'run/delete', params: { runId: 'child-run' },
    }))).rejects.toMatchObject({ code: 'NOT_INITIALIZED' });

    const initialized = await runtime.handleRpc(request({
      id: 'init', method: 'initialize', params: { protocolVersion: '1.17', clientInfo: { name: 'desktop' } },
    })) as { capabilities: { methods: string[] } };
    expect(initialized.capabilities.methods).toContain('run/delete');
    await expect(runtime.handleRpc(request({
      id: 'before-runtime', method: 'run/delete', params: { runId: 'child-run' },
    }))).rejects.toMatchObject({ code: 'NOT_INITIALIZED' });

    (runtime as unknown as { sdk: unknown }).sdk = {
      config: { runtime: { mode: 'sqlite' } },
      created: { runtime: { maintenanceStore: { deleteRun } } },
    };
    await expect(runtime.handleRpc(request({
      id: 'delete', method: 'run/delete', params: { runId: 'child-run' },
    }))).resolves.toEqual({ deleted: true, rootRunId: 'root-run' });
    expect(deleteRun).toHaveBeenCalledWith('child-run');

    const { runtime: legacy } = createRuntime();
    const legacyInitialized = await legacy.handleRpc(request({
      id: 'legacy-init', method: 'initialize', params: { protocolVersion: '1.16', clientInfo: { name: 'desktop' } },
    })) as { capabilities: { methods: string[] } };
    expect(legacyInitialized.capabilities.methods).not.toContain('run/delete');
    await expect(legacy.handleRpc(request({
      id: 'legacy-delete', method: 'run/delete', params: { runId: 'root-run' },
    }))).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });
  });

  it('returns stable run deletion errors and rejects memory mode without a CLI fallback', async () => {
    const { RuntimeDeletionError } = await import('@adaptive-agent/core');
    const execute = vi.fn();
    const { runtime } = createRuntime({ execute });
    await runtime.handleRpc(request({
      id: 'init', method: 'initialize', params: { protocolVersion: '1.17', clientInfo: { name: 'desktop' } },
    }));
    (runtime as unknown as { sdk: unknown }).sdk = {
      config: { runtime: { mode: 'sqlite' } },
      created: { runtime: { maintenanceStore: { deleteRun: vi.fn(async () => { throw new RuntimeDeletionError('RUN_NOT_FOUND', 'Run unknown does not exist.'); }) } } },
    };
    await expect(runtime.handleRpc(request({
      id: 'unknown', method: 'run/delete', params: { runId: 'unknown' },
    }))).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });

    (runtime as unknown as { sdk: unknown }).sdk = {
      config: { runtime: { mode: 'memory' } },
      created: { runtime: {} },
    };
    await expect(runtime.handleRpc(request({
      id: 'memory', method: 'run/delete', params: { runId: 'run' },
    }))).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('lists the complete CLI command surface and its execution restrictions', async () => {
    const { runtime } = createRuntime({ execute: vi.fn() });
    await initialize(runtime);
    const result = await runtime.handleRpc(request({ id: 2, method: 'cli/commands' })) as Array<Record<string, unknown>>;

    expect(result.map(({ command }) => command)).toEqual(ADAPTIVE_AGENT_CLI_COMMANDS);
    expect(result.find(({ command }) => command === 'ambient')).toMatchObject({
      subcommands: ['start'],
      cliExecute: false,
      unavailableReason: expect.any(String),
    });
    expect(result.find(({ command }) => command === 'eval')).toMatchObject({ subcommands: ['cases', 'gaia'] });
    expect(result.find(({ command }) => command === 'context')).toMatchObject({ subcommands: ['create', 'list', 'show', 'delete'] });
    expect(result.find(({ command }) => command === 'update')).toMatchObject({ cliExecute: false, unavailableReason: expect.any(String) });
    expect(result.find(({ command }) => command === 'uninstall')).toMatchObject({ cliExecute: false, unavailableReason: expect.any(String) });
  });

  it('validates with the canonical CLI parser, forces machine output, and streams opaque lines', async () => {
    const execute = vi.fn<CliExecutor['execute']>(async ({ argv, onOutput }) => {
      onOutput({ stream: 'stdout', line: 'not necessarily json' });
      return { exitCode: 0, timedOut: false };
    });
    const { runtime, messages } = createRuntime({ execute });
    await initialize(runtime);

    const result = await runtime.handleRpc(request({
      id: 9,
      method: 'cli/execute',
      params: { argv: ['config', '--cwd', '/tmp'] },
    }));

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      argv: ['config', '--cwd', '/tmp', '--output', 'json'],
    }));
    expect(messages).toContainEqual({
      jsonrpc: '2.0',
      method: 'cli/output',
      params: { requestId: 9, stream: 'stdout', line: 'not necessarily json' },
    });
    expect(result).toMatchObject({ command: 'config', exitCode: 0 });
  });

  it('scopes context commands to the initialized workspace unless cwd is explicit', async () => {
    const execute = vi.fn<CliExecutor['execute']>(async () => ({ exitCode: 0, timedOut: false }));
    const { runtime } = createRuntime({ execute });
    await initialize(runtime);
    (runtime as unknown as { sdk: unknown }).sdk = {
      config: {
        runtime: { mode: 'memory' },
        workspaceRoot: '/workspace/project',
      },
    };

    await runtime.handleRpc(request({
      id: 'default-project',
      method: 'cli/execute',
      params: { argv: ['context', 'list'] },
    }));
    await runtime.handleRpc(request({
      id: 'explicit-project',
      method: 'cli/execute',
      params: { argv: ['context', 'show', 'release', '--cwd', '/other/project'] },
    }));

    expect(execute).toHaveBeenNthCalledWith(1, expect.objectContaining({
      argv: ['context', 'list', '--output', 'json', '--cwd', '/workspace/project'],
    }));
    expect(execute).toHaveBeenNthCalledWith(2, expect.objectContaining({
      argv: ['context', 'show', 'release', '--cwd', '/other/project', '--output', 'json'],
    }));
  });

  it('rejects sidecar-unsafe and interactive CLI invocations', async () => {
    const { runtime } = createRuntime({ execute: vi.fn() });
    await initialize(runtime);

    await expect(runtime.handleRpc(request({
      id: 1,
      method: 'cli/execute',
      params: { argv: ['update', '--check'] },
    }))).rejects.toMatchObject({ code: 'COMMAND_REJECTED' });
    await expect(runtime.handleRpc(request({
      id: 2,
      method: 'cli/execute',
      params: { argv: ['chat'] },
    }))).rejects.toMatchObject({ code: 'COMMAND_REJECTED' });
    await expect(runtime.handleRpc(request({
      id: 3,
      method: 'cli/execute',
      params: { argv: ['run', 'describe it', '--image', '/tmp/image.png'] },
    }))).rejects.toMatchObject({ code: 'COMMAND_REJECTED' });
    await expect(runtime.handleRpc(request({
      id: 4,
      method: 'cli/execute',
      params: { argv: ['run', 'transcribe it', '--audio', '/tmp/audio.mp3'] },
    }))).rejects.toMatchObject({ code: 'COMMAND_REJECTED' });
  });
});
