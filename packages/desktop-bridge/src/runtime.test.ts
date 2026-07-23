import { describe, expect, it, vi } from 'vitest';

import { JSON_RPC_ERROR_CODES, type DesktopMessage, type DesktopRpcRequest } from './protocol.js';
import { DesktopRuntime, type CliExecutor } from './runtime.js';

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

describe('desktop runtime protocol 1.10', () => {
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
      data: { supportedProtocolVersions: ['1.10'] },
    });
  });

  it('lists the complete CLI command surface and its execution restrictions', async () => {
    const { runtime } = createRuntime({ execute: vi.fn() });
    await initialize(runtime);
    const result = await runtime.handleRpc(request({ id: 2, method: 'cli/commands' })) as Array<Record<string, unknown>>;

    expect(result.map(({ command }) => command)).toEqual(expect.arrayContaining([
      'run', 'chat', 'spec', 'swarm-run', 'ambient', 'eval', 'context', 'init', 'doctor', 'update', 'uninstall',
    ]));
    expect(result.find(({ command }) => command === 'eval')).toMatchObject({ subcommands: ['cases', 'gaia'] });
    expect(result.find(({ command }) => command === 'context')).toMatchObject({ subcommands: ['create', 'list', 'show', 'delete'] });
    expect(result.find(({ command }) => command === 'update')).toMatchObject({ cliExecute: false });
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
