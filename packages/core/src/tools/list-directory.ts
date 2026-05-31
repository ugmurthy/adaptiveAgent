import { readdir } from 'node:fs/promises';

import type { ToolDefinition } from '../types.js';
import { buildWorkspacePathRecovery, PathOutsideRootError, resolvePathWithinRoot } from './path-utils.js';

export interface ListDirectoryToolConfig {
  /** Restrict listing to paths under this root. Defaults to `process.cwd()`. */
  allowedRoot?: string;
}

interface ListDirectoryInput {
  path: string;
  maxEntries?: number;
  cursor?: number;
  filter?: string;
}

interface ListDirectoryOutput {
  path: string;
  entries: Array<{ name: string; type: 'file' | 'directory' | 'other' }>;
  totalEntries?: number;
  cursor?: number;
  nextCursor?: number;
  truncated?: boolean;
}

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MODEL_RESULT_MAX_BYTES = 32 * 1024;

export function createListDirectoryTool(config?: ListDirectoryToolConfig): ToolDefinition {
  const allowedRoot = config?.allowedRoot ?? process.cwd();

  return {
    name: 'list_directory',
    description:
      'List entries in a directory. Supports pagination with maxEntries and cursor.',
    maxModelResultBytes: DEFAULT_MODEL_RESULT_MAX_BYTES,
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
        maxEntries: {
          type: 'number',
          description: 'Maximum entries to return. Defaults to 200.',
        },
        cursor: {
          type: 'number',
          description: 'Zero-based cursor offset for pagination.',
        },
        filter: {
          type: 'string',
          description: 'Optional case-insensitive substring filter for entry names.',
        },
      },
    },
    summarizeResult(output) {
      const result = output as ListDirectoryOutput;
      return {
        path: result.path,
        entryCount: result.entries.length,
        totalEntries: result.totalEntries ?? result.entries.length,
        truncated: result.truncated ?? false,
        nextCursor: result.nextCursor,
      };
    },
    recoverError(error, input) {
      const dirPath = typeof input === 'object' && input !== null && 'path' in input && typeof input.path === 'string'
        ? input.path
        : '';
      if (error instanceof PathOutsideRootError) {
        return buildWorkspacePathRecovery('list_directory', dirPath, error);
      }

      return undefined;
    },
    async execute(rawInput) {
      // Some models send tool input as a JSON string instead of an object — normalise.
      const input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
      const { path: dirPath, maxEntries, cursor, filter } = input as unknown as ListDirectoryInput;
      const resolved = resolvePathWithinRoot(allowedRoot, dirPath);

      const allEntries = (await readdir(resolved, { withFileTypes: true }))
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' as const : entry.isFile() ? 'file' as const : 'other' as const,
        }))
        .filter((entry) => !filter || entry.name.toLowerCase().includes(filter.toLowerCase()))
        .sort((left, right) => left.name.localeCompare(right.name));
      const start = normalizeNonNegativeInteger(cursor, 0);
      const limit = normalizePositiveInteger(maxEntries, DEFAULT_MAX_ENTRIES);
      const entries = allEntries.slice(start, start + limit);
      const nextCursor = start + entries.length < allEntries.length ? start + entries.length : undefined;

      return {
        path: resolved,
        entries,
        totalEntries: allEntries.length,
        cursor: start,
        ...(nextCursor === undefined ? { truncated: false } : { truncated: true, nextCursor }),
      } satisfies ListDirectoryOutput as unknown as ReturnType<ToolDefinition['execute']>;
    },
  };
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.floor(value));
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.floor(value));
}
