import { readFile, stat } from 'node:fs/promises';

import type { ToolDefinition } from '../types.js';
import { extractPdfTextWithPdfJs } from './pdf-text.js';
import { buildWorkspacePathRecovery, PathOutsideRootError, resolvePathWithinRoot } from './path-utils.js';

export interface ReadFileToolConfig {
  /** Restrict reads to paths under this root. Defaults to `process.cwd()`. */
  allowedRoot?: string;
  /** Maximum file size in bytes. Defaults to 1 MiB. */
  maxSizeBytes?: number;
  /** Override PDF extraction for tests or custom runtimes. */
  extractPdfText?: (rawBuffer: ArrayBuffer) => Promise<{ title: string; text: string }>;
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
  const extractPdfText = config?.extractPdfText ?? extractPdfTextWithPdfJs;

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
    recoverError(error, input) {
      const filePath = typeof input === 'object' && input !== null && 'path' in input && typeof input.path === 'string'
        ? input.path
        : '';
      if (error instanceof PathOutsideRootError) {
        return buildWorkspacePathRecovery('read_file', filePath, error);
      }

      return undefined;
    },
    async execute(rawInput) {
      // Some models send tool input as a JSON string instead of an object — normalise.
      const input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
      const { path: filePath } = input as unknown as ReadFileInput;
      const resolved = resolvePathWithinRoot(allowedRoot, filePath);

      const fileStats = await stat(resolved);
      if (fileStats.size > maxSizeBytes) {
        throw new Error(`File ${resolved} exceeds maximum size of ${maxSizeBytes} bytes`);
      }

      const contentBuffer = await readFile(resolved);
      if (contentBuffer.byteLength > maxSizeBytes) {
        throw new Error(`File ${resolved} exceeds maximum size of ${maxSizeBytes} bytes`);
      }

      const content = isPdfBuffer(contentBuffer)
        ? (await extractPdfText(toArrayBuffer(contentBuffer))).text
        : contentBuffer.toString('utf-8');

      return {
        path: resolved,
        content,
        sizeBytes: contentBuffer.byteLength,
      } satisfies ReadFileOutput as unknown as ReturnType<ToolDefinition['execute']>;
    },
  };
}

function isPdfBuffer(contentBuffer: Buffer): boolean {
  return (
    contentBuffer.byteLength >= 4 &&
    contentBuffer[0] === 0x25 &&
    contentBuffer[1] === 0x50 &&
    contentBuffer[2] === 0x44 &&
    contentBuffer[3] === 0x46
  );
}

function toArrayBuffer(contentBuffer: Buffer): ArrayBuffer {
  return contentBuffer.buffer.slice(contentBuffer.byteOffset, contentBuffer.byteOffset + contentBuffer.byteLength);
}
