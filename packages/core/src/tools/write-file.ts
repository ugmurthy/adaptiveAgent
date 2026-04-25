import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { ToolDefinition } from '../types.js';
import { resolvePathWithinRoot } from './path-utils.js';

export interface WriteFileToolConfig {
  /** Restrict writes to paths under this root. Defaults to `process.cwd()`. */
  allowedRoot?: string;
  /** Create parent directories if they don't exist. Defaults to `true`. */
  createDirectories?: boolean;
}

interface WriteFileInput {
  path: string;
  content: string;
}

interface WriteFileOutput {
  path: string;
  sizeBytes: number;
}

export function createWriteFileTool(config?: WriteFileToolConfig): ToolDefinition {
  const allowedRoot = config?.allowedRoot ?? process.cwd();
  const createDirectories = config?.createDirectories ?? true;

  return {
    name: 'write_file',
    description:
      'Write text content to a file at the given path. Creates parent directories if needed. Requires approval.',
    inputSchema: {
      type: 'object',
      required: ['path', 'content'],
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Absolute or relative file path to write.' },
        content: { type: 'string', description: 'Text content to write to the file.' },
      },
    },
    requiresApproval: true,
    async execute(rawInput) {
      // Some models send tool input as a JSON string instead of an object — normalise.
      let input: unknown;
      if (typeof rawInput === 'string') {
        try {
          input = JSON.parse(rawInput);
        } catch {
          throw new Error('write_file expects a JSON object with { "path": string, "content": string } and only supports UTF-8 text');
        }
      } else {
        input = rawInput;
      }

      const { path: filePath, content } = input as unknown as WriteFileInput;

      if (typeof filePath !== 'string' || !filePath.trim()) {
        throw new Error('write_file requires a non-empty "path" string');
      }
      if (typeof content !== 'string') {
        throw new Error('write_file requires a "content" string');
      }

      const resolved = resolvePathWithinRoot(allowedRoot, filePath);

      if (createDirectories) {
        await mkdir(dirname(resolved), { recursive: true });
      }

      await writeFile(resolved, content, 'utf-8');
      const sizeBytes = Buffer.byteLength(content, 'utf-8');

      return {
        path: resolved,
        sizeBytes,
      } satisfies WriteFileOutput as unknown as ReturnType<ToolDefinition['execute']>;
    },
  };
}
