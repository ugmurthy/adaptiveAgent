import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'bun:test';

import { runTask } from './run-desktop-bridge.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture(failRun = false): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-client-'));
  directories.push(dir);
  const path = join(dir, 'bridge.ts');
  await writeFile(path, `
    import { createInterface } from 'node:readline';
    const send = (message: unknown) => console.log(JSON.stringify({ jsonrpc: '2.0', ...message }));
    send({ method: 'runtime/ready', params: { protocolVersion: '1.19' } });
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      if (request.method === 'initialize') send({ id: request.id, result: { protocolVersion: '1.19' } });
      if (request.method === 'runtime/initialize') {
        if (request.params.cwd !== process.cwd() || request.params.settingsConfigPath !== process.cwd() + '/agent.settings.json') throw Error('Incorrect paths');
        send({ id: request.id, result: { agent: { id: 'fixture' } } });
      }
      if (request.method === 'agent/run') {
        if (request.params.goal !== 'Test a bridge task' || !request.params.runId) throw Error('Incorrect run');
        send({ method: 'agent/event', params: { type: 'run.status_changed' } });
        ${failRun
          ? "send({ id: request.id, error: { code: -32603, message: 'secret-provider-error', data: { protocolCode: 'RUNTIME_ERROR' } } });"
          : "send({ id: request.id, result: { runId: request.params.runId, status: 'success' } });"}
      }
      if (request.method === 'run/inspect') send({ id: request.id, result: { run: { metadata: {
        agentSelection: { selectedAgentId: 'worker', rejectedTypeSafe: { threshold: 'confidence', minimum: 0.7, decision: { selectedAgentId: 'other' } } },
        executionRouting: { mode: 'direct', rejectedTypeSafe: { threshold: 'relevance', minimum: 0.8, decision: { mode: 'orchestration' } } },
      } } } });
      if (request.method === 'runtime/shutdown') { send({ id: request.id, result: { shutdown: true } }); break; }
    }
  `);
  return path;
}

test('runs through JSON-RPC and prints inspected selection and routing fallback metadata', async () => {
  const path = await fixture();
  const messages: string[] = [];
  const original = console.log;
  console.log = (...args) => messages.push(args.join(' '));
  try { await runTask('Test a bridge task', path); } finally { console.log = original; }
  expect(messages[0]).toContain(`Workspace: ${process.cwd()}\nSettings: ${process.cwd()}/agent.settings.json`);
  expect(JSON.parse(messages[1]!)).toMatchObject({
    status: 'success',
    agentSelection: { rejectedTypeSafe: { threshold: 'confidence', minimum: 0.7, decision: { selectedAgentId: 'other' } } },
    executionRouting: { rejectedTypeSafe: { threshold: 'relevance', minimum: 0.8, decision: { mode: 'orchestration' } } },
  });
});

test('reports a protocol error code without echoing provider diagnostics', async () => {
  const path = await fixture(true);
  await expect(runTask('Test a bridge task', path)).rejects.toThrow('agent/run failed (RUNTIME_ERROR)');
});
