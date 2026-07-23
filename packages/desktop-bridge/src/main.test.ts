import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('desktop bridge process', () => {
  it('keeps CLI child output inside JSON-RPC notifications', async () => {
    const entrypoint = resolve(import.meta.dirname, 'main.ts');
    const child = spawn('bun', [entrypoint], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);

    child.stdin.end([
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'initialize',
        method: 'initialize',
        params: { protocolVersion: '1.10', clientInfo: { name: 'integration-test' } },
      }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'cli/execute',
        params: { argv: ['--version'] },
      }),
      '',
    ].join('\n'));

    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', resolveExit);
    });
    const output = await stdout;
    const diagnostics = await stderr;
    const messages = output.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(exitCode).toBe(0);
    expect(diagnostics).toBe('');
    expect(messages[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'runtime/ready',
      params: { protocolVersion: '1.10' },
    });
    expect(messages).toContainEqual(expect.objectContaining({
      jsonrpc: '2.0',
      method: 'cli/output',
      params: expect.objectContaining({ requestId: 7, stream: 'stdout' }),
    }));
    expect(messages).toContainEqual(expect.objectContaining({
      jsonrpc: '2.0',
      id: 7,
      result: expect.objectContaining({ exitCode: 0 }),
    }));
  }, 30_000);

  it('rejects protocol v1 consistently before and after initialization', async () => {
    const entrypoint = resolve(import.meta.dirname, 'main.ts');
    const child = spawn('bun', [entrypoint], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    const legacyHello = JSON.stringify({ version: 1, id: 'hello', type: 'hello' });

    child.stdin.end([
      legacyHello,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'initialize',
        method: 'initialize',
        params: { protocolVersion: '1.10', clientInfo: { name: 'integration-test' } },
      }),
      legacyHello,
      '',
    ].join('\n'));

    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', resolveExit);
    });
    const messages = (await stdout).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const diagnostics = await stderr;
    const legacyResponses = messages.filter((message) => message.id === 'hello');

    expect(exitCode).toBe(0);
    expect(diagnostics).toBe('');
    expect(legacyResponses).toHaveLength(2);
    expect(legacyResponses[0]).toEqual(legacyResponses[1]);
    expect(legacyResponses[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 'hello',
      error: {
        code: -32600,
        message: 'jsonrpc must be exactly "2.0".',
        data: { protocolCode: 'INVALID_REQUEST' },
      },
    });
  }, 30_000);
});

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  let output = '';
  for await (const chunk of stream) output += String(chunk);
  return output;
}
