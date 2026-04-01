import { exec } from 'node:child_process';

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
}

const DEFAULT_MAX_OUTPUT = 102_400; // 100 KiB

export function createShellExecTool(config?: ShellExecToolConfig): ToolDefinition {
  const defaultCwd = config?.cwd ?? process.cwd();
  const maxOutputBytes = config?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const shell = config?.shell;

  return {
    name: 'shell_exec',
    description:
      'Execute a shell command and return stdout, stderr, and exit code. Requires approval.',
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
    async execute(input, context) {
      const { command, cwd } = input as unknown as ShellExecInput;
      const workingDir = cwd ?? defaultCwd;

      return new Promise<ShellExecOutput>((resolve, reject) => {
        const child = exec(
          command,
          {
            cwd: workingDir,
            maxBuffer: maxOutputBytes,
            shell: shell ?? undefined,
          },
          (error, stdout, stderr) => {
            resolve({
              stdout: stdout.toString(),
              stderr: stderr.toString(),
              exitCode: error?.code ?? (typeof error?.code === 'number' ? error.code : 0),
            } as ShellExecOutput);
          },
        );

        context.signal.addEventListener('abort', () => {
          child.kill('SIGTERM');
        });
      }) as unknown as ReturnType<ToolDefinition['execute']>;
    },
  };
}
