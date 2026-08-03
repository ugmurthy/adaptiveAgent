import { describe, expect, it, vi } from 'vitest';

import type { TraceService } from '../trace-session/reader.js';
import type { TraceReport } from '../trace-session/types.js';
import { parseSidecarArgs, readBoundedNdjsonFrames } from '../trace-sidecar.js';
import {
  JSON_RPC_ERROR_CODES,
  TraceSidecarProtocolError,
  parseTraceSidecarRpcRequest,
} from './protocol.js';
import { TraceSidecarRuntime } from './runtime.js';

describe('trace sidecar protocol', () => {
  it('parses strict trace requests and rejects unknown fields', () => {
    expect(parseTraceSidecarRpcRequest(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'trace/get',
      params: {
        target: { kind: 'run', runId: 'run-1' },
        include: { reasoning: true },
      },
    }))).toMatchObject({ method: 'trace/get' });

    expect(() => parseTraceSidecarRpcRequest(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'trace/get',
      params: { target: { kind: 'run', runId: 'run-1', databaseUrl: 'postgres://untrusted' } },
    }))).toThrowError(expect.objectContaining<Partial<TraceSidecarProtocolError>>({
      code: 'INVALID_PARAMS',
      jsonRpcCode: JSON_RPC_ERROR_CODES.invalidParams,
    }));
  });

  it('bounds list requests and validates time windows', () => {
    expect(() => parseTraceSidecarRpcRequest(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'trace/listSessions', params: { limit: 501 },
    }))).toThrowError(/limit must be an integer/);
    expect(() => parseTraceSidecarRpcRequest(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'trace/listSessions', params: { since: 'now-ish' },
    }))).toThrowError(/ISO timestamp or relative duration/);
  });
});

describe('trace sidecar runtime policy', () => {
  it('requires initialization and reports host-authorized capabilities', async () => {
    const runtime = new TraceSidecarRuntime(serviceReturning(report()), 'sqlite', {
      allowMessages: true,
      allowReasoning: false,
      allowRawToolPayloads: false,
    });
    await expect(runtime.handle(request('runtime/info'))).rejects.toMatchObject({ code: 'NOT_INITIALIZED' });

    const initialized = await runtime.handle(request('initialize', {
      protocolVersion: '1.0', clientInfo: { name: 'test-client' },
    })) as { capabilities: Record<string, boolean>; backend: Record<string, unknown> };
    expect(initialized.capabilities).toMatchObject({ messages: true, reasoning: false, rawToolPayloads: false });
    expect(initialized.backend).toEqual({ kind: 'sqlite', readOnly: true });
  });

  it('infers messages for reasoning and rejects unauthorized reasoning explicitly', async () => {
    const service = serviceReturning(report());
    const runtime = new TraceSidecarRuntime(service, 'sqlite', {
      allowMessages: true,
      allowReasoning: false,
      allowRawToolPayloads: false,
    });
    await initialize(runtime);

    await expect(runtime.handle(request('trace/get', {
      target: { kind: 'run', runId: 'run-1' },
      include: { reasoning: true },
    }))).rejects.toMatchObject({
      code: 'SENSITIVE_DATA_NOT_ALLOWED',
      data: { capability: 'reasoning' },
    });
    expect(service.trace).not.toHaveBeenCalled();
  });

  it('loads authorized reasoning and removes raw tool payloads by default', async () => {
    const service = serviceReturning(report());
    const runtime = new TraceSidecarRuntime(service, 'postgres', {
      allowMessages: true,
      allowReasoning: true,
      allowRawToolPayloads: false,
    });
    await initialize(runtime);

    const result = await runtime.handle(request('trace/get', {
      target: { kind: 'run', runId: 'run-1' },
      include: { reasoning: true },
    })) as TraceReport;
    expect(service.trace).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1', messages: true, reasoning: true,
    }));
    expect(JSON.parse(JSON.stringify(result)).timeline[0]).not.toHaveProperty('params');
    expect(JSON.parse(JSON.stringify(result)).timeline[0]).not.toHaveProperty('output');
    expect(JSON.stringify(result)).not.toContain('opaque-secret');
  });

  it('returns authorized messages without reasoning unless reasoning is requested and authorized', async () => {
    const runtime = new TraceSidecarRuntime(serviceReturning(report()), 'sqlite', {
      allowMessages: true,
      allowReasoning: false,
      allowRawToolPayloads: false,
    });
    await initialize(runtime);
    const result = await runtime.handle(request('trace/get', {
      target: { kind: 'run', runId: 'run-1' }, include: { messages: true },
    })) as TraceReport;
    expect(result.llmMessages[0]?.effectiveMessages[0]?.content).toBe('authorized-message');
    expect(JSON.stringify(result.llmMessages)).not.toContain('authorized-reasoning');
  });

  it('returns raw tool payloads only when both host and request opt in', async () => {
    const runtime = new TraceSidecarRuntime(serviceReturning(report()), 'sqlite', {
      allowMessages: false,
      allowReasoning: false,
      allowRawToolPayloads: true,
    });
    await initialize(runtime);
    const result = await runtime.handle(request('trace/get', {
      target: { kind: 'run', runId: 'run-1' }, include: { rawToolPayloads: true },
    })) as TraceReport;
    expect(result.timeline[0]).toMatchObject({ params: { secret: 'input' }, output: { secret: 'output' } });
  });

  it('passes a bounded default into sessionless storage queries', async () => {
    const service = serviceReturning(report());
    service.listSessionless = vi.fn(async () => []);
    const runtime = new TraceSidecarRuntime(service, 'postgres', {
      allowMessages: false,
      allowReasoning: false,
      allowRawToolPayloads: false,
    });
    await initialize(runtime);
    await runtime.handle(request('trace/listSessionlessRuns'));
    expect(service.listSessionless).toHaveBeenCalledWith(100);
  });
});

describe('trace sidecar startup policy', () => {
  it('accepts an exact trusted SQLite path and keeps backend selectors exclusive', () => {
    expect(parseSidecarArgs(['--sqlite-path', './runtime.sqlite'])).toMatchObject({ sqlitePath: './runtime.sqlite' });
    expect(() => parseSidecarArgs(['--sqlite-path', './runtime.sqlite', '--settings', './settings.json'])).toThrow(/exactly one backend source/);
  });

  it('makes reasoning imply messages without accepting RPC database configuration', () => {
    expect(parseSidecarArgs(['--settings', './agent.settings.json', '--allow-reasoning'])).toMatchObject({
      settingsPath: './agent.settings.json',
      allowMessages: true,
      allowReasoning: true,
      allowRawToolPayloads: false,
    });
    expect(() => parseSidecarArgs(['--settings', './agent.settings.json', '--database-url-env', 'DATABASE_URL'])).toThrow(/exactly one backend source/);
    expect(() => parseSidecarArgs(['--settings', 'first.json', '--settings', 'second.json'])).toThrow(/cannot be repeated/);
  });

  it('bounds unterminated NDJSON frames before parsing them', async () => {
    const frames = [];
    for await (const frame of readBoundedNdjsonFrames(chunks(['1234', '5678', '90\n{}\n']), 8)) frames.push(frame);
    expect(frames).toEqual([
      { line: '', oversized: true },
      { line: '{}', oversized: false },
    ]);
  });
});

function request(method: string, params?: Record<string, unknown>) {
  return { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) } as never;
}

async function initialize(runtime: TraceSidecarRuntime): Promise<void> {
  await runtime.handle(request('initialize', { protocolVersion: '1.0', clientInfo: { name: 'test' } }));
}

function serviceReturning(value: TraceReport): TraceService & { trace: ReturnType<typeof vi.fn> } {
  return {
    trace: vi.fn(async () => value),
    usage: vi.fn(),
    listSessions: vi.fn(),
    listPerformance: vi.fn(),
    aggregate: vi.fn(),
    listSessionless: vi.fn(),
    close: vi.fn(),
  } as unknown as TraceService & { trace: ReturnType<typeof vi.fn> };
}

function report(): TraceReport {
  return {
    rootRuns: [{ result: { value: 'opaque-secret' }, errorMessage: 'opaque-secret' }],
    timeline: [{
      rootRunId: 'run-1', runId: 'run-1', depth: 0, stepId: 'step-1', toolCallId: 'tool-1',
      eventType: 'tool.completed', toolName: 'secret-tool', params: { secret: 'input' }, output: { secret: 'output' },
      accounting: { value: 'opaque-secret' }, startedAt: null, completedAt: null, durationMs: null,
      outcome: 'failed: opaque-secret', childRunId: null, eventSeq: 1,
    }],
    milestones: [{ text: 'opaque-secret', eventType: 'tool.completed' }],
    runTree: [{ result: { value: 'opaque-secret' } }],
    delegates: [{
      child_error_message: 'opaque-secret', child_result: { value: 'opaque-secret' },
      parent_last_event_payload: { value: 'opaque-secret' }, child_last_event_payload: { value: 'opaque-secret' },
    }],
    summary: { status: 'failed', reason: 'opaque-secret' },
    warnings: ['opaque-secret'],
    diagnostics: { findings: [{ message: 'opaque-secret' }] },
    llmMessages: [{ effectiveMessages: [{ content: 'authorized-message', reasoning: 'authorized-reasoning' }] }],
    plans: [{ plan_summary: 'opaque-secret' }],
  } as unknown as TraceReport;
}

async function* chunks(values: string[]): AsyncGenerator<string> {
  for (const value of values) yield value;
}
