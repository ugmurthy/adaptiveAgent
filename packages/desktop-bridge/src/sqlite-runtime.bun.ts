import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'bun:test';

import type { DesktopRpcRequest } from './protocol.js';
import { DesktopRuntime, type CliExecutionRequest, type CliExecutor } from './runtime.js';

it('defaults the desktop runtime to SQLite and points CLI children at the initialized database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-bridge-sqlite-'));
  const agentPath = join(directory, 'agent.json');
  const settingsPath = join(directory, 'agent.settings.json');
  const sqlitePath = join(directory, 'desktop.sqlite');
  let execution: CliExecutionRequest | undefined;
  const executor: CliExecutor = {
    async execute(request) {
      execution = request;
      return { exitCode: 0, timedOut: false };
    },
  };
  const runtime = new DesktopRuntime(() => undefined, executor);

  try {
    await writeFile(agentPath, JSON.stringify({
      id: 'desktop-sqlite-agent',
      name: 'Desktop SQLite Agent',
      invocationModes: ['run'],
      defaultInvocationMode: 'run',
      model: { provider: 'ollama', model: 'qwen3.5' },
      tools: [],
    }));
    await writeFile(settingsPath, JSON.stringify({ runtime: { sqlitePath: './desktop.sqlite' } }));
    await runtime.handleRpc(request({
      id: 'initialize',
      method: 'initialize',
      params: { protocolVersion: '1.10', clientInfo: { name: 'desktop-test' } },
    }));

    const initialized = await runtime.handleRpc(request({
      id: 'runtime',
      method: 'runtime/initialize',
      params: { cwd: directory, agentConfigPath: agentPath, settingsConfigPath: settingsPath },
    }));
    expect(initialized).toMatchObject({ runtimeMode: 'sqlite' });
    expect(existsSync(sqlitePath)).toBe(true);

    await runtime.handleRpc(request({
      id: 'inspect',
      method: 'cli/execute',
      params: { argv: ['inspect', 'run-1'] },
    }));
    expect(execution).toMatchObject({
      argv: ['inspect', 'run-1', '--output', 'json', '--runtime', 'sqlite'],
      environment: { ADAPTIVE_AGENT_SQLITE_PATH: sqlitePath },
    });
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function request(value: Omit<DesktopRpcRequest, 'jsonrpc'>): DesktopRpcRequest {
  return { jsonrpc: '2.0', ...value } as DesktopRpcRequest;
}
