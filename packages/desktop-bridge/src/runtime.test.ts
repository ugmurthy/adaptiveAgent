import { describe, expect, it, vi } from 'vitest';

import { ADAPTIVE_AGENT_CLI_COMMANDS } from '@adaptive-agent/agent-sdk/cli';
import type { ResolvedAgentSdkConfig } from '@adaptive-agent/agent-sdk';

import { JSON_RPC_ERROR_CODES, type DesktopMessage, type DesktopRpcRequest } from './protocol.js';
import { DesktopRuntime, safeResolvedConfiguration, updateDesktopSettings, validateRestrictedDesktopConfiguration, type CliExecutor } from './runtime.js';

function request(value: Omit<DesktopRpcRequest, 'jsonrpc'>): DesktopRpcRequest {
  return { jsonrpc: '2.0', ...value } as DesktopRpcRequest;
}

function createRuntime(executor?: CliExecutor) {
  const messages: DesktopMessage[] = [];
  return {
    messages,
    runtime: new DesktopRuntime((message) => messages.push(message), executor),
  };
}

async function initialize(runtime: DesktopRuntime): Promise<void> {
  await runtime.handleRpc(request({
    id: 'init',
    method: 'initialize',
    params: { protocolVersion: '1.10', clientInfo: { name: 'test-client' } },
  }));
}

describe('desktop runtime protocol', () => {
  it('updates editable settings without dropping advanced configuration', () => {
    const updated = updateDesktopSettings(
      { env: { EXISTING: 'value' }, gateway: { url: 'ws://gateway' }, model: { overrideBaseUrl: 'https://models' } },
      {
        inference: { mode: 'byok', tier: 'high' },
        workspace: { root: ' /workspace ', shellCwd: ' /workspace/project ' },
        interaction: { approvalMode: 'manual', clarificationMode: 'fail' },
      },
    );
    expect(updated).toMatchObject({
      env: { EXISTING: 'value' },
      gateway: { url: 'ws://gateway' },
      model: { overrideBaseUrl: 'https://models' },
      inference: { mode: 'byok', tier: 'high' },
      workspace: { overrideRoot: '/workspace', overrideShellCwd: '/workspace/project' },
      interaction: { approvalMode: 'manual', clarificationMode: 'fail' },
    });
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
      data: { supportedProtocolVersions: ['1.10', '1.11', '1.12'] },
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
    await expect(runtime.handleRpc(request({
      id: 'token',
      method: 'auth/updateAccessToken',
      params: { accessToken: 'secret' },
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
  });
});
