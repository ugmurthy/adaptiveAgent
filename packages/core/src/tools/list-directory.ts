import { readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';

import type { ToolDefinition } from '../types.js';

export interface ListDirectoryToolConfig {
  /** Restrict listing to paths under this root. Defaults to `process.cwd()`. */
  allowedRoot?: string;
}

interface ListDirectoryInput {
  path: string;
}

interface ListDirectoryOutput {
  path: string;
  entries: Array<{ name: string; type: 'file' | 'directory' | 'other' }>;
}

export function createListDirectoryTool(config?: ListDirectoryToolConfig): ToolDefinition {
  const allowedRoot = config?.allowedRoot ?? process.cwd();

  return {
    name: 'list_directory',
    description:
      'List the entries in a directory. Returns each entry name and whether it is a file or directory.',
    retryPolicy: {
      retryable: true,
      retryOn: ['timeout', 'network', 'not_found', 'unknown'],
    },
    inputSchema: {
      type: 'object',
      required: ['path'],
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Absolute or relative directory path to list.' },
      },
    },
    async execute(rawInput) {
      // Some models send tool input as a JSON string instead of an object — normalise.
      const input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
      const { path: dirPath } = input as unknown as ListDirectoryInput;
      const resolved = resolve(allowedRoot, dirPath);

      if (!resolved.startsWith(resolve(allowedRoot))) {
        throw new Error(`Path ${dirPath} is outside the allowed root ${allowedRoot}`);
      }

      const names = await readdir(resolved);
      const entries = await Promise.all(
        names.map(async (name) => {
          const entryPath = join(resolved, name);
          const entryStat = await stat(entryPath).catch(() => null);
          const type = entryStat?.isDirectory()
            ? 'directory'
            : entryStat?.isFile()
              ? 'file'
              : 'other';
          return { name, type } as const;
        }),
      );

      return {
        path: resolved,
        entries,
      } satisfies ListDirectoryOutput as unknown as ReturnType<ToolDefinition['execute']>;
    },
  };
}
