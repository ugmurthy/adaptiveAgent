import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { ModelAdapter, ModelRequest } from '@adaptive-agent/core/types';
import { main, testDelegate } from './test-delegate.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const cwd = await mkdtemp(resolve(tmpdir(), 'manual-delegate-'));
  roots.push(cwd);
  await mkdir(resolve(cwd, 'skills', 'different-directory'), { recursive: true });
  await writeFile(resolve(cwd, 'agent.settings.json'), JSON.stringify({
    agent: { configPath: './agent.json' },
    skills: { dirs: ['./skills'], allowExampleSkills: false },
    workspace: { overrideRoot: '/not-the-workspace', overrideShellCwd: '/not-the-shell-cwd' },
    interaction: { approvalMode: 'auto', clarificationMode: 'fail' },
  }));
  await writeFile(resolve(cwd, 'agent.json'), JSON.stringify({
    version: 1, id: 'manual-test', name: 'Manual test', invocationModes: ['run'], defaultInvocationMode: 'run',
    model: { provider: 'ollama', model: 'unused' }, tools: [], delegates: ['missing-unrelated-delegate'],
  }));
  await writeFile(resolve(cwd, 'skills', 'different-directory', 'SKILL.md'), `---
name: reader
description: Reads a fixture
allowedTools:
  - read_file
---
UNIQUE SKILL INSTRUCTIONS: read the requested file and report its contents.
`);
  await writeFile(resolve(cwd, 'input.txt'), 'asymmetric fixture content 739');
  return cwd;
}

function adapter(generate: ModelAdapter['generate']): ModelAdapter {
  return { provider: 'test', model: 'offline', capabilities: { toolCalling: true, jsonOutput: true, streaming: false, usage: false }, generate };
}

test('listing uses cwd settings and discovers unconfigured skills without loading unrelated delegates', async () => {
  const cwd = await fixture();
  await rm(resolve(cwd, 'agent.json'));
  const lines: string[] = [];
  expect(await testDelegate({ cwd, print: (line) => lines.push(line) })).toBe(0);
  expect(lines.join('\n')).toContain('reader');
  expect(lines.join('\n')).toContain(resolve(cwd, 'skills', 'different-directory', 'SKILL.md'));
  expect(lines.join('\n')).toContain('Discovered 1 delegate(s).');
});

test('executes one child with skill instructions and scoped tools, capturing tool results on the next turn', async () => {
  const cwd = await fixture();
  const requests: ModelRequest[] = [];
  const model = adapter(async (request) => {
    requests.push(structuredClone({ ...request, signal: undefined, onRetry: undefined }));
    return requests.length === 1
      ? { finishReason: 'tool_calls', toolCalls: [{ id: 'read-1', name: 'read_file', input: { path: 'input.txt' } }] }
      : { finishReason: 'stop', text: 'Report: asymmetric fixture content 739' };
  });
  expect(await testDelegate({ cwd, delegate: 'delegate.reader', task: 'Read input.txt', outputPath: 'trace.jsonl', modelAdapter: model, print: () => {} })).toBe(0);
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[0].messages)).toContain('UNIQUE SKILL INSTRUCTIONS');
  expect(JSON.stringify(requests[0].messages)).toContain('Read input.txt');
  expect(requests[0].tools?.map((tool) => tool.name)).toEqual(['read_file']);
  expect(JSON.stringify(requests[1].messages.filter((message) => message.role === 'tool'))).toContain('asymmetric fixture content 739');
  const records = (await readFile(resolve(cwd, 'trace.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  expect(records.filter((record) => record.type === 'model.request')).toHaveLength(2);
  expect(records.filter((record) => record.type === 'model.response')).toHaveLength(2);
  const child = records.find((record) => record.type === 'delegate.result').data;
  expect(child).toMatchObject({ delegateName: 'reader', status: 'succeeded', result: 'Report: asymmetric fixture content 739' });
  expect(records.filter((record) => record.type === 'event' && record.data.type === 'delegate.spawned')).toHaveLength(1);
  await expect(testDelegate({ cwd, delegate: 'reader', task: 'again', outputPath: 'trace.jsonl', modelAdapter: model, print: () => {} })).rejects.toThrow('EEXIST');
});

test('records provider errors and returns a failed exit status rather than parent success', async () => {
  const cwd = await fixture();
  const model = adapter(async () => { throw new Error('offline provider failure'); });
  expect(await testDelegate({ cwd, delegate: 'reader', task: 'Fail', outputPath: 'failed.jsonl', modelAdapter: model, print: () => {} })).toBe(1);
  const trace = await readFile(resolve(cwd, 'failed.jsonl'), 'utf8');
  expect(trace).toContain('model.error');
  expect(trace).toContain('offline provider failure');
  expect(trace).toContain('"status":"failed"');
});

test('rejects missing task, unknown delegate, and contradictory CLI arguments', async () => {
  const cwd = await fixture();
  await expect(testDelegate({ cwd, delegate: 'reader', task: '  ' })).rejects.toThrow('--task');
  await expect(testDelegate({ cwd, delegate: 'unknown', task: 'Read' })).rejects.toThrow('Unknown delegate');
  await expect(main(['--list', '--task', 'Read'])).rejects.toThrow('--list cannot');
  await expect(main(['--delegate', 'reader'])).rejects.toThrow('Use --list');
});
