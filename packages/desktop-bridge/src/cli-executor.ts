import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type { CliExecutionRequest, CliExecutionResult, CliExecutor } from './runtime.js';

export const CLI_CHILD_MODE = '--desktop-bridge-cli-child';

export class ProcessCliExecutor implements CliExecutor {
  private readonly children = new Set<ChildProcessWithoutNullStreams>();
  private closing = false;

  constructor(private readonly entrypointPath: string) {}

  async execute(request: CliExecutionRequest): Promise<CliExecutionResult> {
    if (this.closing) throw new Error('The CLI executor is shutting down.');

    const child = spawn(process.execPath, this.childArguments(request.argv), {
      env: childEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.children.add(child);

    const stdoutDone = emitLines(child.stdout, (line) => request.onOutput({ stream: 'stdout', line }));
    const stderrDone = emitLines(child.stderr, (line) => request.onOutput({ stream: 'stderr', line }));
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = request.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 1_000);
        killTimer.unref();
      }, request.timeoutMs);
    timer?.unref();

    if (request.stdin === undefined) child.stdin.end();
    else child.stdin.end(request.stdin);

    try {
      const { code, signal } = await waitForExit(child);
      await Promise.all([stdoutDone, stderrDone]);
      return {
        exitCode: code ?? (timedOut ? 124 : 1),
        ...(signal ? { signal } : {}),
        timedOut,
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      this.children.delete(child);
    }
  }

  async close(): Promise<void> {
    if (this.closing && this.children.size === 0) return;
    this.closing = true;
    const children = [...this.children];
    for (const child of children) child.kill('SIGTERM');
    await Promise.allSettled(children.map(async (child) => {
      await Promise.race([
        waitForExit(child),
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }));
  }

  private childArguments(argv: string[]): string[] {
    return isCompiledEntrypoint(this.entrypointPath)
      ? [CLI_CHILD_MODE, ...argv]
      : [this.entrypointPath, CLI_CHILD_MODE, ...argv];
  }
}

function isCompiledEntrypoint(entrypointPath: string): boolean {
  return entrypointPath.startsWith('/$bunfs/') || import.meta.url.startsWith('file:///$bunfs/');
}

function childEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Bun uses this internal variable to make a compiled executable act like the
  // Bun CLI. Inheriting it would bypass the embedded desktop bridge entrypoint.
  delete env.BUN_BE_BUN;
  return env;
}

async function emitLines(stream: NodeJS.ReadableStream, emit: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of stream) {
    pending += typeof chunk === 'string' ? chunk : decoder.decode(chunk as Uint8Array, { stream: true });
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, '');
      emit(line);
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
    }
  }
  pending += decoder.decode();
  if (pending.length > 0) emit(pending.replace(/\r$/, ''));
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}
