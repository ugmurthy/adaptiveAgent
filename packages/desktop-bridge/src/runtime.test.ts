import { describe, expect, it, vi } from 'vitest';

import { ADAPTIVE_AGENT_CLI_COMMANDS } from '@adaptive-agent/agent-sdk/cli';
import type { ResolvedAgentSdkConfig } from '@adaptive-agent/agent-sdk';

import { JSON_RPC_ERROR_CODES, type DesktopMessage, type DesktopRpcRequest } from './protocol.js';
import { DesktopRuntime, safeResolvedConfiguration, validateRestrictedDesktopConfiguration, type CliExecutor } from './runtime.js';

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
      agent: { id: 'agent-1', name: 'Researcher', defaultInvocationMode: 'run' },
      model: { provider: 'openrouter', model: 'test-model', credentialAvailable: true },
      inference: { mode: 'byok' },
      interaction: { approvalMode: 'reject', clarificationMode: 'fail' },
    });
    expect(JSON.stringify(summary)).not.toContain('never-expose-this');
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
      data: { supportedProtocolVersions: ['1.10', '1.11'] },
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
