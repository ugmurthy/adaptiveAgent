import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { ToolDefinition } from '../types.js';

export interface ReadFileToolConfig {
  /** Restrict reads to paths under this root. Defaults to `process.cwd()`. */
  allowedRoot?: string;
  /** Maximum file size in bytes. Defaults to 1 MiB. */
  maxSizeBytes?: number;
}

interface ReadFileInput {
  path: string;
}

interface ReadFileOutput {
  path: string;
  content: string;
  sizeBytes: number;
}

const DEFAULT_MAX_SIZE = 1_048_576; // 1 MiB

export function createReadFileTool(config?: ReadFileToolConfig): ToolDefinition {
  const allowedRoot = config?.allowedRoot ?? process.cwd();
  const maxSizeBytes = config?.maxSizeBytes ?? DEFAULT_MAX_SIZE;

  return {
    name: 'read_file',
    description:
      'Read the text content of a file at the given path. Returns the file content, resolved path, and size in bytes.',
    retryPolicy: {
      retryable: true,
      retryOn: ['timeout', 'network', 'not_found', 'unknown'],
    },
    inputSchema: {
      type: 'object',
      required: ['path'],
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Absolute or relative file path to read.' },
      },
    },
    async execute(rawInput) {
      // Some models send tool input as a JSON string instead of an object — normalise.
      const input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
      const { path: filePath } = input as unknown as ReadFileInput;
      const resolved = resolve(allowedRoot, filePath);

      if (!resolved.startsWith(resolve(allowedRoot))) {
        throw new Error(`Path ${filePath} is outside the allowed root ${allowedRoot}`);
      }

      const content = await readFile(resolved, 'utf-8');

      if (Buffer.byteLength(content, 'utf-8') > maxSizeBytes) {
        throw new Error(`File ${resolved} exceeds maximum size of ${maxSizeBytes} bytes`);
      }

      return {
        path: resolved,
        content,
        sizeBytes: Buffer.byteLength(content, 'utf-8'),
      } satisfies ReadFileOutput as unknown as ReturnType<ToolDefinition['execute']>;
    },
  };
}
