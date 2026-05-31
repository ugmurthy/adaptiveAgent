import { spawn } from 'node:child_process';

import type { ToolDefinition } from '../types.js';

export interface ShellExecToolConfig {
  /** Working directory for commands. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Maximum stdout/stderr capture in bytes. Defaults to 100 KiB. */
  maxOutputBytes?: number;
  /** Shell to use. Defaults to the system shell. */
  shell?: string;
}

interface ShellExecInput {
  command: string;
  cwd?: string;
}

interface ShellExecOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated?: boolean;
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutBytesAvailable?: number;
  stderrBytesAvailable?: number;
}

const DEFAULT_MAX_OUTPUT = 102_400; // 100 KiB
const DEFAULT_MODEL_RESULT_MAX_BYTES = 32 * 1024;

export function createShellExecTool(config?: ShellExecToolConfig): ToolDefinition {
  const defaultCwd = config?.cwd ?? process.cwd();
  const maxOutputBytes = config?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const shell = config?.shell;

  return {
    name: 'shell_exec',
    description:
      'Execute a shell command and return stdout, stderr, and exit code. Requires approval.',
    maxModelResultBytes: DEFAULT_MODEL_RESULT_MAX_BYTES,
    inputSchema: {
      type: 'object',
      required: ['command'],
      additionalProperties: false,
      properties: {
        command: { type: 'string', description: 'The shell command to execute.' },
        cwd: { type: 'string', description: 'Optional working directory for the command.' },
      },
    },
    requiresApproval: true,
    summarizeResult(output) {
      return summarizeShellExecOutput(output as ShellExecOutput);
    },
    formatResultForModel(output, context) {
      return formatShellExecOutputForModel(output as ShellExecOutput, context.maxBytes);
    },
    async execute(rawInput, context) {
      // Some models send tool input as a JSON string instead of an object — normalise.
      const input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
      const { command, cwd } = input as unknown as ShellExecInput;
      const workingDir = cwd ?? defaultCwd;

      return new Promise<ShellExecOutput>((resolve) => {
        const stdout = createBoundedTextBuffer(maxOutputBytes);
        const stderr = createBoundedTextBuffer(maxOutputBytes);
        let settled = false;
        const child = spawn(command, {
          cwd: workingDir,
          shell: shell ?? true,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });

        const finish = (output: ShellExecOutput) => {
          if (settled) {
            return;
          }
          settled = true;
          context.signal.removeEventListener('abort', abortHandler);
          resolve(output);
        };

        const abortHandler = () => {
          killProcessTree(child.pid);
        };

        context.signal.addEventListener('abort', abortHandler, { once: true });

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => stdout.push(chunk));
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => stderr.push(chunk));

        child.on('error', (error) => {
          stderr.push(error.message);
          finish(buildShellExecOutput(stdout, stderr, 1));
        });

        child.on('close', (code, closeSignal) => {
          const exitCode = typeof code === 'number' ? code : closeSignal ? 1 : 0;
          finish(buildShellExecOutput(stdout, stderr, exitCode));
        });
      }) as unknown as ReturnType<ToolDefinition['execute']>;
    },
  };
}

interface BoundedTextBuffer {
  push(chunk: string): void;
  text(): string;
  bytes: number;
  availableBytes: number;
  truncated: boolean;
}

function createBoundedTextBuffer(maxBytes: number): BoundedTextBuffer {
  let value = '';
  let bytes = 0;
  let availableBytes = 0;
  let truncated = false;

  return {
    push(chunk: string) {
      const chunkBytes = Buffer.byteLength(chunk, 'utf8');
      availableBytes += chunkBytes;
      if (bytes >= maxBytes) {
        truncated = true;
        return;
      }

      const remaining = maxBytes - bytes;
      if (chunkBytes <= remaining) {
        value += chunk;
        bytes += chunkBytes;
        return;
      }

      const capped = truncateUtf8(chunk, remaining);
      value += capped.text;
      bytes += capped.bytes;
      truncated = true;
    },
    text: () => value,
    get bytes() {
      return bytes;
    },
    get availableBytes() {
      return availableBytes;
    },
    get truncated() {
      return truncated;
    },
  };
}

function buildShellExecOutput(stdout: BoundedTextBuffer, stderr: BoundedTextBuffer, exitCode: number): ShellExecOutput {
  return {
    stdout: stdout.text(),
    stderr: stderr.text(),
    exitCode,
    truncated: stdout.truncated || stderr.truncated,
    stdoutBytes: stdout.bytes,
    stderrBytes: stderr.bytes,
    stdoutBytesAvailable: stdout.availableBytes,
    stderrBytesAvailable: stderr.availableBytes,
  };
}

function summarizeShellExecOutput(output: ShellExecOutput): unknown {
  if (typeof output.stdout !== 'string' || typeof output.stderr !== 'string') {
    return output;
  }

  return {
    exitCode: output.exitCode,
    stdoutBytes: output.stdoutBytes ?? Buffer.byteLength(output.stdout, 'utf8'),
    stderrBytes: output.stderrBytes ?? Buffer.byteLength(output.stderr, 'utf8'),
    stdoutBytesAvailable: output.stdoutBytesAvailable,
    stderrBytesAvailable: output.stderrBytesAvailable,
    truncated: output.truncated ?? false,
  };
}

function formatShellExecOutputForModel(output: ShellExecOutput, maxBytes: number): unknown {
  if (typeof output.stdout !== 'string' || typeof output.stderr !== 'string') {
    return output;
  }

  const stdoutBudget = Math.floor(maxBytes * 0.55);
  const stderrBudget = Math.floor(maxBytes * 0.35);
  const stdout = truncateUtf8(output.stdout, stdoutBudget);
  const stderr = truncateUtf8(output.stderr, stderrBudget);
  return {
    ...output,
    stdout: stdout.text,
    stderr: stderr.text,
    truncated:
      output.truncated ||
      stdout.bytes < Buffer.byteLength(output.stdout, 'utf8') ||
      stderr.bytes < Buffer.byteLength(output.stderr, 'utf8'),
    stdoutBytes: stdout.bytes,
    stderrBytes: stderr.bytes,
    stdoutBytesAvailable: output.stdoutBytesAvailable ?? Buffer.byteLength(output.stdout, 'utf8'),
    stderrBytesAvailable: output.stderrBytesAvailable ?? Buffer.byteLength(output.stderr, 'utf8'),
  };
}

function truncateUtf8(text: string, maxBytes: number): { text: string; bytes: number } {
  const source = Buffer.from(text, 'utf8');
  if (source.byteLength <= maxBytes) {
    return { text, bytes: source.byteLength };
  }

  let end = Math.max(0, maxBytes);
  while (end > 0 && (source[end] & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return {
    text: source.subarray(0, end).toString('utf8'),
    bytes: end,
  };
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) {
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Best effort. The runtime timeout already failed the tool call.
    }
  }
}
