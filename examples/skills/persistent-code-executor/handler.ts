import { Sandbox } from '@e2b/code-interpreter';

import type { JsonValue, ToolContext } from '../../../packages/core/src/types.js';

export const name = 'persistent_e2b_run_code';
export const description =
  'Run Python code in an E2B sandbox that persists across multiple tool calls in the same delegated run. Supports run, status, and close actions.';

export const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ['run', 'status', 'close'],
      description: 'run executes code, status reports the current sandbox session, close kills it immediately.',
    },
    code: {
      type: 'string',
      description: 'Python code to execute when action is run.',
    },
    timeoutMs: {
      type: 'number',
      description: 'Per-cell execution timeout. Defaults to 120000ms.',
    },
    idleTtlMs: {
      type: 'number',
      description: 'How long to keep the sandbox alive after this call. Defaults to 300000ms.',
    },
    closeOnError: {
      type: 'boolean',
      description: 'When true, close the sandbox if this code cell returns an execution error.',
    },
    template: {
      type: 'string',
      description: 'Optional E2B template to use when creating the sandbox.',
    },
  },
} as const;

export const outputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'sandboxId', 'status'],
  properties: {
    action: { type: 'string' },
    sandboxId: { type: 'string' },
    status: { type: 'string' },
    created: { type: 'boolean' },
    reused: { type: 'boolean' },
    closed: { type: 'boolean' },
    idleTtlMs: { type: 'number' },
    text: { type: 'string' },
    logs: {
      type: 'object',
      additionalProperties: false,
      properties: {
        stdout: { type: 'array', items: { type: 'string' } },
        stderr: { type: 'array', items: { type: 'string' } },
      },
    },
    results: { type: 'array' },
    error: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        value: { type: 'string' },
        traceback: { type: 'string' },
      },
    },
  },
} as const;

interface PersistentCodeInput {
  action: 'run' | 'status' | 'close';
  code?: string;
  timeoutMs?: number;
  idleTtlMs?: number;
  closeOnError?: boolean;
  template?: string;
}

interface SandboxSession {
  sandbox: Sandbox;
  sandboxId: string;
  runId: string;
  idleTtlMs: number;
  createdAt: number;
  lastUsedAt: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

type PersistentCodeOutput = Record<string, JsonValue>;

const DEFAULT_CELL_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_TTL_MS = 300_000;
const MIN_IDLE_TTL_MS = 30_000;
const MAX_IDLE_TTL_MS = 3_600_000;

const sessionsByRunId = new Map<string, SandboxSession>();

export async function execute(rawInput: JsonValue, context: ToolContext): Promise<PersistentCodeOutput> {
  const input = normalizeInput(rawInput);
  const idleTtlMs = normalizeDuration(input.idleTtlMs, DEFAULT_IDLE_TTL_MS, MIN_IDLE_TTL_MS, MAX_IDLE_TTL_MS);

  if (input.action === 'status') {
    const session = sessionsByRunId.get(context.runId);
    return session
      ? sessionOutput('status', session, { status: 'running', idleTtlMs: session.idleTtlMs })
      : { action: 'status', sandboxId: '', status: 'not_created', idleTtlMs };
  }

  if (input.action === 'close') {
    const session = sessionsByRunId.get(context.runId);
    if (!session) {
      return { action: 'close', sandboxId: '', status: 'not_created', closed: false };
    }

    await closeSession(session, 'explicit close');
    return { action: 'close', sandboxId: session.sandboxId, status: 'closed', closed: true };
  }

  if (!input.code?.trim()) {
    throw new Error('persistent_e2b_run_code requires code when action is run');
  }

  const { session, created } = await getOrCreateSession(context, idleTtlMs, input.template);
  const abortCleanup = closeOnAbort(context, session);

  try {
    session.lastUsedAt = Date.now();
    session.idleTtlMs = idleTtlMs;
    await session.sandbox.setTimeout(idleTtlMs);
    scheduleIdleCleanup(session);

    const execution = await session.sandbox.runCode(input.code, {
      language: 'python',
      timeoutMs: normalizeDuration(input.timeoutMs, DEFAULT_CELL_TIMEOUT_MS, 1_000, idleTtlMs),
    });
    const output = sessionOutput('run', session, {
      status: execution.error ? 'execution_error' : 'ok',
      created,
      reused: !created,
      idleTtlMs,
      text: execution.text ?? '',
      logs: {
        stdout: execution.logs?.stdout ?? [],
        stderr: execution.logs?.stderr ?? [],
      },
      results: execution.results?.map((result) => compactJsonObject({
        text: result.text,
        markdown: result.markdown,
        html: result.html,
        png: result.png,
        jpeg: result.jpeg,
        svg: result.svg,
      })) ?? [],
      ...(execution.error
        ? {
            error: {
              name: execution.error.name,
              value: execution.error.value,
              traceback: execution.error.traceback,
            },
          }
        : {}),
    });

    if (execution.error && input.closeOnError) {
      await closeSession(session, 'closeOnError');
      output.closed = true;
    }

    return output;
  } catch (error) {
    await closeSession(session, `sandbox operation failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    abortCleanup();
  }
}

function normalizeInput(rawInput: JsonValue): PersistentCodeInput {
  const input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('persistent_e2b_run_code expects an object input');
  }

  const candidate = input as Record<string, unknown>;
  if (candidate.action !== 'run' && candidate.action !== 'status' && candidate.action !== 'close') {
    throw new Error('persistent_e2b_run_code action must be run, status, or close');
  }

  return {
    action: candidate.action,
    code: typeof candidate.code === 'string' ? candidate.code : undefined,
    timeoutMs: typeof candidate.timeoutMs === 'number' ? candidate.timeoutMs : undefined,
    idleTtlMs: typeof candidate.idleTtlMs === 'number' ? candidate.idleTtlMs : undefined,
    closeOnError: typeof candidate.closeOnError === 'boolean' ? candidate.closeOnError : undefined,
    template: typeof candidate.template === 'string' && candidate.template.trim() ? candidate.template.trim() : undefined,
  };
}

async function getOrCreateSession(
  context: ToolContext,
  idleTtlMs: number,
  template?: string,
): Promise<{ session: SandboxSession; created: boolean }> {
  const existing = sessionsByRunId.get(context.runId);
  if (existing) {
    return { session: existing, created: false };
  }

  const sandbox = template
    ? await Sandbox.create(template, {
        timeoutMs: idleTtlMs,
        lifecycle: { onTimeout: 'kill' },
        metadata: sandboxMetadata(context),
      })
    : await Sandbox.create({
        timeoutMs: idleTtlMs,
        lifecycle: { onTimeout: 'kill' },
        metadata: sandboxMetadata(context),
      });
  const session: SandboxSession = {
    sandbox,
    sandboxId: sandbox.sandboxId,
    runId: context.runId,
    idleTtlMs,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  };

  sessionsByRunId.set(context.runId, session);
  scheduleIdleCleanup(session);
  return { session, created: true };
}

function sandboxMetadata(context: ToolContext): Record<string, string> {
  return {
    adaptiveAgentRootRunId: context.rootRunId,
    adaptiveAgentRunId: context.runId,
    adaptiveAgentDelegateName: context.delegateName ?? 'persistent-code-executor',
  };
}

function normalizeDuration(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(value), min), max);
}

function compactJsonObject(values: Record<string, JsonValue | undefined>): Record<string, JsonValue> {
  const compact: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      compact[key] = value;
    }
  }

  return compact;
}

function scheduleIdleCleanup(session: SandboxSession): void {
  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
  }

  session.cleanupTimer = setTimeout(() => {
    void closeSession(session, 'local idle ttl expired');
  }, session.idleTtlMs + 1_000);
}

function closeOnAbort(context: ToolContext, session: SandboxSession): () => void {
  if (context.signal.aborted) {
    void closeSession(session, 'tool aborted before execution');
    return () => undefined;
  }

  const onAbort = () => {
    void closeSession(session, 'tool aborted');
  };
  context.signal.addEventListener('abort', onAbort, { once: true });
  return () => context.signal.removeEventListener('abort', onAbort);
}

async function closeSession(session: SandboxSession, _reason: string): Promise<void> {
  if (sessionsByRunId.get(session.runId) !== session) {
    return;
  }

  sessionsByRunId.delete(session.runId);
  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
  }

  try {
    await session.sandbox.kill();
  } catch {
    // Best effort cleanup. E2B timeout with onTimeout: kill remains the remote failsafe.
  }
}

function sessionOutput(action: string, session: SandboxSession, fields: Record<string, JsonValue>): PersistentCodeOutput {
  return {
    action,
    sandboxId: session.sandboxId,
    runId: session.runId,
    ageMs: Date.now() - session.createdAt,
    idleMs: Date.now() - session.lastUsedAt,
    ...fields,
  };
}
