import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Sandbox } from '@e2b/code-interpreter';

import type { JsonValue, ToolContext } from '../../../packages/core/src/types.js';

export const name = 'persistent_e2b_run_code';
export const description =
  'Run Python code in an E2B sandbox that persists across multiple tool calls in the same delegated run. Supports run, upload, status, and close actions.';

export const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ['run', 'upload', 'status', 'close'],
      description: 'run uploads optional files then executes code, upload writes files without executing code, status reports the current sandbox session, close kills it immediately.',
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
    files: {
      type: 'array',
      description: 'Optional files to upload into the sandbox before code execution. Each file can use sourcePath, content, or base64.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sandboxPath'],
        properties: {
          sandboxPath: {
            type: 'string',
            description: 'Absolute destination path inside the E2B sandbox, e.g. /home/user/input.csv.',
          },
          sourcePath: {
            type: 'string',
            description: 'Local file path to read and upload.',
          },
          content: {
            type: 'string',
            description: 'Inline text content to write to sandboxPath.',
          },
          base64: {
            type: 'string',
            description: 'Base64-encoded file bytes to write to sandboxPath.',
          },
        },
      },
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
    uploadedFiles: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          sourcePath: { type: 'string' },
          bytes: { type: 'number' },
        },
      },
    },
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
  action: 'run' | 'upload' | 'status' | 'close';
  code?: string;
  timeoutMs?: number;
  idleTtlMs?: number;
  closeOnError?: boolean;
  template?: string;
  files?: UploadFileInput[];
}

interface UploadFileInput {
  sandboxPath: string;
  sourcePath?: string;
  content?: string;
  base64?: string;
}

interface UploadedFileOutput {
  path: string;
  sourcePath?: string;
  bytes: number;
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

  if (input.action === 'run' && !input.code?.trim() && (!input.files || input.files.length === 0)) {
    throw new Error('persistent_e2b_run_code requires code or files when action is run');
  }

  if (input.action === 'upload' && (!input.files || input.files.length === 0)) {
    throw new Error('persistent_e2b_run_code requires files when action is upload');
  }

  const { session, created } = await getOrCreateSession(context, idleTtlMs, input.template);
  const abortCleanup = closeOnAbort(context, session);

  try {
    session.lastUsedAt = Date.now();
    session.idleTtlMs = idleTtlMs;
    await session.sandbox.setTimeout(idleTtlMs);
    scheduleIdleCleanup(session);

    const uploadedFiles = input.files?.length ? await uploadFiles(session, input.files) : [];

    if (input.action === 'upload') {
      return sessionOutput('upload', session, {
        status: 'ok',
        created,
        reused: !created,
        idleTtlMs,
        uploadedFiles: uploadedFiles.map(toJsonObject),
      });
    }

    const execution = await session.sandbox.runCode(input.code ?? '', {
      language: 'python',
      timeoutMs: normalizeDuration(input.timeoutMs, DEFAULT_CELL_TIMEOUT_MS, 1_000, idleTtlMs),
    });
    const output = sessionOutput('run', session, {
      status: execution.error ? 'execution_error' : 'ok',
      created,
      reused: !created,
      idleTtlMs,
      uploadedFiles: uploadedFiles.map(toJsonObject),
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
  if (
    candidate.action !== 'run' &&
    candidate.action !== 'upload' &&
    candidate.action !== 'status' &&
    candidate.action !== 'close'
  ) {
    throw new Error('persistent_e2b_run_code action must be run, upload, status, or close');
  }

  return {
    action: candidate.action,
    code: typeof candidate.code === 'string' ? candidate.code : undefined,
    timeoutMs: typeof candidate.timeoutMs === 'number' ? candidate.timeoutMs : undefined,
    idleTtlMs: typeof candidate.idleTtlMs === 'number' ? candidate.idleTtlMs : undefined,
    closeOnError: typeof candidate.closeOnError === 'boolean' ? candidate.closeOnError : undefined,
    template: typeof candidate.template === 'string' && candidate.template.trim() ? candidate.template.trim() : undefined,
    files: parseUploadFiles(candidate.files),
  };
}

function parseUploadFiles(value: unknown): UploadFileInput[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error('persistent_e2b_run_code files must be an array');
  }

  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`persistent_e2b_run_code files[${index}] must be an object`);
    }

    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.sandboxPath !== 'string' || !candidate.sandboxPath.trim()) {
      throw new Error(`persistent_e2b_run_code files[${index}] requires sandboxPath`);
    }

    const sources = [candidate.sourcePath, candidate.content, candidate.base64].filter(
      (source) => typeof source === 'string',
    );
    if (sources.length !== 1) {
      throw new Error(`persistent_e2b_run_code files[${index}] requires exactly one of sourcePath, content, or base64`);
    }

    return {
      sandboxPath: normalizeSandboxPath(candidate.sandboxPath, index),
      sourcePath: typeof candidate.sourcePath === 'string' ? candidate.sourcePath : undefined,
      content: typeof candidate.content === 'string' ? candidate.content : undefined,
      base64: typeof candidate.base64 === 'string' ? candidate.base64 : undefined,
    };
  });
}

function normalizeSandboxPath(path: string, index: number): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith('/')) {
    throw new Error(`persistent_e2b_run_code files[${index}].sandboxPath must be absolute`);
  }

  if (trimmed.includes('\0')) {
    throw new Error(`persistent_e2b_run_code files[${index}].sandboxPath is invalid`);
  }

  return trimmed;
}

async function uploadFiles(session: SandboxSession, files: UploadFileInput[]): Promise<UploadedFileOutput[]> {
  const uploaded: UploadedFileOutput[] = [];

  for (const file of files) {
    const { data, bytes, sourcePath } = await materializeUploadFile(file);
    await session.sandbox.files.write(file.sandboxPath, data);
    uploaded.push({
      path: file.sandboxPath,
      ...(sourcePath ? { sourcePath } : {}),
      bytes,
    });
  }

  return uploaded;
}

async function materializeUploadFile(file: UploadFileInput): Promise<{
  data: string | ArrayBuffer;
  bytes: number;
  sourcePath?: string;
}> {
  if (file.sourcePath) {
    const sourcePath = resolve(file.sourcePath);
    const bytes = await readFile(sourcePath);
    return {
      data: toArrayBuffer(bytes),
      bytes: bytes.byteLength,
      sourcePath,
    };
  }

  if (file.base64 !== undefined) {
    const bytes = Buffer.from(file.base64, 'base64');
    return {
      data: toArrayBuffer(bytes),
      bytes: bytes.byteLength,
    };
  }

  const content = file.content ?? '';
  return {
    data: content,
    bytes: Buffer.byteLength(content, 'utf8'),
  };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function toJsonObject(file: UploadedFileOutput): Record<string, JsonValue> {
  return compactJsonObject({
    path: file.path,
    sourcePath: file.sourcePath,
    bytes: file.bytes,
  });
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
  unrefTimer(session.cleanupTimer);
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && timer && 'unref' in timer && typeof timer.unref === 'function') {
    timer.unref();
  }
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
