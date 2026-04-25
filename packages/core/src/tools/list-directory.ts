import { readdir } from 'node:fs/promises';

import type { ToolDefinition } from '../types.js';
import { resolvePathWithinRoot } from './path-utils.js';

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
      const resolved = resolvePathWithinRoot(allowedRoot, dirPath);

      const entries = (await readdir(resolved, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      }));

      return {
        path: resolved,
        entries,
      } satisfies ListDirectoryOutput as unknown as ReturnType<ToolDefinition['execute']>;
    },
  };
}
