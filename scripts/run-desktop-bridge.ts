#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

// Match the bridge's string-valued protocol version (JSON number 1.10 would be ambiguous).
const DESKTOP_PROTOCOL_VERSION = '1.19';

type Message = Record<string, unknown>;

function record(value: unknown): Message | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Message : undefined;
}

export async function runTask(task: string, bridgePath = resolve(import.meta.dirname, '../packages/desktop-bridge/src/main.ts')): Promise<void> {
  const workspace = process.cwd();
  const settings = resolve(workspace, 'agent.settings.json');
  const child = spawn('bun', [bridgePath], { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] });
  child.on('error', () => { /* stdout closure is reported as a transport failure below */ });
  child.stdin.on('error', () => { /* a closed bridge is reported by the response reader */ });
  const exited = new Promise<void>((resolveExit) => child.once('close', () => resolveExit()));
  // Drain diagnostics, but do not echo them: provider libraries may include credentials.
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const reader = lines[Symbol.asyncIterator]();
  let initialized = false;
  let transportFailed = false;

  async function nextMessage(timeoutMs: number): Promise<Message> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const line = await Promise.race([
        reader.next(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Bridge response timed out.')), timeoutMs); }),
      ]);
      if (line.done) throw new Error('Bridge closed its output before responding.');
      let parsed: unknown;
      try { parsed = JSON.parse(line.value) as unknown; } catch { throw new Error('Invalid bridge JSON-RPC message.'); }
      const message = record(parsed);
      if (!message || message.jsonrpc !== '2.0') throw new Error('Invalid bridge JSON-RPC message.');
      return message;
    } catch (error) {
      transportFailed = true;
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function request(id: string, method: string, params?: Message, timeoutMs = 30_000): Promise<Message> {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const message = await nextMessage(Math.max(1, deadline - Date.now()));
      if (message.method === 'agent/event' || message.method === 'cli/output') continue;
      if (message.id !== id) throw new Error(`Unexpected bridge response while waiting for ${method}.`);
      const error = record(message.error);
      if (error) {
        const code = record(error.data)?.protocolCode;
        throw new Error(`${method} failed${typeof code === 'string' ? ` (${code})` : ''}. Check bridge diagnostics locally.`);
      }
      const result = record(message.result);
      if (!result) throw new Error(`${method} returned an invalid result.`);
      return result;
    }
  }

  try {
    const ready = await nextMessage(30_000);
    if (ready.method !== 'runtime/ready' || record(ready.params)?.protocolVersion !== DESKTOP_PROTOCOL_VERSION) {
      throw new Error('Unexpected desktop-bridge ready notification or protocol version.');
    }
    const handshake = await request('initialize', 'initialize', {
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
      clientInfo: { name: 'run-desktop-bridge', version: '1.0.0' },
      capabilities: {},
    });
    if (handshake.protocolVersion !== DESKTOP_PROTOCOL_VERSION) throw new Error('Bridge negotiated an unexpected protocol version.');
    await request('runtime', 'runtime/initialize', { cwd: workspace, settingsConfigPath: settings });
    initialized = true;
    console.log(`Workspace: ${workspace}\nSettings: ${settings}`);
    const result = await request('run', 'agent/run', { runId: randomUUID(), goal: task }, 600_000);
    const final = record(result.result) ?? result; // execution envelope or plain run result
    const runId = final.runId;
    if (typeof runId !== 'string') throw new Error('agent/run did not return a runId.');
    const inspection = await request('inspect', 'run/inspect', { runId });
    const run = record(inspection.run);
    if (!run) throw new Error(`Run ${runId} was not found for metadata inspection.`);
    const metadata = record(run.metadata);
    console.log(JSON.stringify({
      runId, status: final.status,
      ...(metadata?.agentSelection ? { agentSelection: metadata.agentSelection } : {}),
      ...(metadata?.executionRouting ? { executionRouting: metadata.executionRouting } : {}),
    }, null, 2));
    if (final.status !== 'success') throw new Error(`Run ended with status ${String(final.status)}.`);
  } finally {
    if (initialized && !transportFailed && child.exitCode === null) {
      try { await request('shutdown', 'runtime/shutdown', undefined, 3_000); } catch { /* terminate below */ }
    }
    child.stdin.end();
    if (child.exitCode === null) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const closed = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(false), 3_000); }),
      ]);
      if (timer) clearTimeout(timer);
      if (!closed) child.kill();
    }
    lines.close();
  }
}

if (import.meta.main) {
  const task = process.argv.slice(2).join(' ').trim();
  if (!task) {
    console.error('Usage: bun run scripts/run-desktop-bridge.ts <task description>');
    process.exitCode = 2;
  } else {
    runTask(task).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
