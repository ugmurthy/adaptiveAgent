import { copyFile, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

import type { ToolContext, ToolDefinition } from '../types.js';
import { buildWorkspacePathRecovery, PathOutsideRootError, resolvePathWithinRoot } from './path-utils.js';

export interface EditFileToolConfig {
  /** Restrict edits to paths under this root. Defaults to `process.cwd()`. */
  allowedRoot?: string;
  /** Create an adjacent backup before writing changed content. Defaults to `false`. */
  createBackup?: boolean;
  /** Maximum original and edited file size in bytes. Defaults to 10 MiB. */
  maxFileSizeBytes?: number;
}

type EditFileInput = {
  path: string;
  edits: EditOperationInput[];
  expectedSha256?: string;
};

type EditOperationInput =
  | {
      type: 'replace';
      oldText: string;
      newText: string;
      expectedMatches?: number;
    }
  | {
      type: 'insert_after';
      anchorText: string;
      text: string;
      expectedMatches?: number;
    }
  | {
      type: 'insert_before';
      anchorText: string;
      text: string;
      expectedMatches?: number;
    };

type NormalizedEditOperation =
  | {
      type: 'replace';
      oldText: string;
      newText: string;
      expectedMatches: number;
    }
  | {
      type: 'insert_after';
      anchorText: string;
      text: string;
      expectedMatches: number;
    }
  | {
      type: 'insert_before';
      anchorText: string;
      text: string;
      expectedMatches: number;
    };

interface NormalizedEditFileInput {
  path: string;
  edits: NormalizedEditOperation[];
  expectedSha256?: string;
}

interface EditFileOutput {
  path: string;
  changed: boolean;
  editCount: number;
  sizeBytes: number;
  sha256: string;
  backupPath?: string;
}

const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1_048_576; // 10 MiB
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export function createEditFileTool(config?: EditFileToolConfig): ToolDefinition {
  const allowedRoot = config?.allowedRoot ?? process.cwd();
  const createBackup = config?.createBackup ?? false;
  const maxFileSizeBytes = normalizePositiveIntegerConfig(
    config?.maxFileSizeBytes,
    DEFAULT_MAX_FILE_SIZE_BYTES,
    'maxFileSizeBytes',
  );

  return {
    name: 'edit_file',
    description:
      'Apply conservative text edits to an existing UTF-8 file. Supports exact replace and anchored insert operations. Requires approval.',
    inputSchema: {
      type: 'object',
      required: ['path', 'edits'],
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or relative path to an existing UTF-8 text file under the allowed root.',
        },
        edits: {
          type: 'array',
          minItems: 1,
          description: 'Ordered edit operations. Each operation must match its expected match count or no write occurs.',
          items: {
            oneOf: [
              {
                type: 'object',
                required: ['type', 'oldText', 'newText'],
                additionalProperties: false,
                properties: {
                  type: { type: 'string', enum: ['replace'] },
                  oldText: { type: 'string', description: 'Exact text to replace. Must be non-empty.' },
                  newText: { type: 'string', description: 'Replacement text. May be empty to delete oldText.' },
                  expectedMatches: {
                    type: 'number',
                    description: 'Expected non-overlapping match count. Defaults to 1.',
                  },
                },
              },
              {
                type: 'object',
                required: ['type', 'anchorText', 'text'],
                additionalProperties: false,
                properties: {
                  type: { type: 'string', enum: ['insert_after'] },
                  anchorText: { type: 'string', description: 'Exact anchor text to insert after. Must be non-empty.' },
                  text: { type: 'string', description: 'Text to insert. Must be non-empty.' },
                  expectedMatches: {
                    type: 'number',
                    description: 'Expected non-overlapping anchor count. Defaults to 1.',
                  },
                },
              },
              {
                type: 'object',
                required: ['type', 'anchorText', 'text'],
                additionalProperties: false,
                properties: {
                  type: { type: 'string', enum: ['insert_before'] },
                  anchorText: { type: 'string', description: 'Exact anchor text to insert before. Must be non-empty.' },
                  text: { type: 'string', description: 'Text to insert. Must be non-empty.' },
                  expectedMatches: {
                    type: 'number',
                    description: 'Expected non-overlapping anchor count. Defaults to 1.',
                  },
                },
              },
            ],
          },
        },
        expectedSha256: {
          type: 'string',
          description: 'Optional lowercase hex SHA-256 digest of the original file bytes for optimistic safety.',
        },
      },
    },
    requiresApproval: true,
    recoverError(error, input) {
      const filePath = extractInputPath(input);
      if (error instanceof PathOutsideRootError) {
        return buildWorkspacePathRecovery('edit_file', filePath, error);
      }

      return undefined;
    },
    async execute(rawInput, context: ToolContext) {
      const input = normalizeEditFileInput(rawInput);
      const resolved = resolvePathWithinRoot(allowedRoot, input.path);
      const fileStats = await lstat(resolved);
      if (fileStats.isSymbolicLink()) {
        throw new Error(`edit_file refuses to edit symbolic links: ${resolved}`);
      }
      if (!fileStats.isFile()) {
        throw new Error(`edit_file requires an existing file path: ${resolved}`);
      }
      if (fileStats.size > maxFileSizeBytes) {
        throw new Error(`File ${resolved} exceeds maximum size of ${maxFileSizeBytes} bytes`);
      }

      const originalBuffer = await readFile(resolved);
      if (originalBuffer.byteLength > maxFileSizeBytes) {
        throw new Error(`File ${resolved} exceeds maximum size of ${maxFileSizeBytes} bytes`);
      }

      const originalSha256 = sha256(originalBuffer);
      if (input.expectedSha256 !== undefined && input.expectedSha256 !== originalSha256) {
        throw new Error(`edit_file expectedSha256 mismatch for ${resolved}`);
      }

      const originalContent = decodeUtf8TextFile(originalBuffer, resolved);
      let editedContent = originalContent;
      for (const edit of input.edits) {
        context.signal.throwIfAborted();
        editedContent = applyEditOperation(editedContent, edit);
      }

      const changed = editedContent !== originalContent;
      if (!changed) {
        return {
          path: resolved,
          changed: false,
          editCount: input.edits.length,
          sizeBytes: originalBuffer.byteLength,
          sha256: originalSha256,
        } satisfies EditFileOutput as unknown as ReturnType<ToolDefinition['execute']>;
      }

      const editedBuffer = Buffer.from(editedContent, 'utf8');
      if (editedBuffer.byteLength > maxFileSizeBytes) {
        throw new Error(`Edited file ${resolved} exceeds maximum size of ${maxFileSizeBytes} bytes`);
      }

      const backupPath = createBackup ? await createBackupFile(resolved) : undefined;
      await writeFileAtomically(resolved, editedBuffer);

      return {
        path: resolved,
        changed: true,
        editCount: input.edits.length,
        sizeBytes: editedBuffer.byteLength,
        sha256: sha256(editedBuffer),
        ...(backupPath === undefined ? {} : { backupPath }),
      } satisfies EditFileOutput as unknown as ReturnType<ToolDefinition['execute']>;
    },
  };
}

function normalizeEditFileInput(rawInput: unknown): NormalizedEditFileInput {
  const input = parseObjectInput(rawInput, 'edit_file expects a JSON object');
  const { path: filePath, edits, expectedSha256 } = input as Partial<EditFileInput>;

  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('edit_file requires a non-empty "path" string');
  }
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error('edit_file requires a non-empty "edits" array');
  }
  if (expectedSha256 !== undefined) {
    validateExpectedSha256(expectedSha256);
  }

  return {
    path: filePath,
    edits: edits.map(normalizeEditOperation),
    ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
  };
}

function parseObjectInput(rawInput: unknown, message: string): Record<string, unknown> {
  let input: unknown;
  if (typeof rawInput === 'string') {
    try {
      input = JSON.parse(rawInput);
    } catch {
      throw new Error(message);
    }
  } else {
    input = rawInput;
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(message);
  }

  return input as Record<string, unknown>;
}

function normalizeEditOperation(value: unknown, index: number): NormalizedEditOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`edit_file edit ${index} must be an object`);
  }

  const edit = value as Record<string, unknown>;
  const expectedMatches = normalizeExpectedMatches(edit.expectedMatches, index);
  switch (edit.type) {
    case 'replace': {
      if (typeof edit.oldText !== 'string' || edit.oldText.length === 0) {
        throw new Error(`edit_file replace edit ${index} requires non-empty "oldText"`);
      }
      if (typeof edit.newText !== 'string') {
        throw new Error(`edit_file replace edit ${index} requires "newText" to be a string`);
      }
      return {
        type: 'replace',
        oldText: edit.oldText,
        newText: edit.newText,
        expectedMatches,
      };
    }
    case 'insert_after':
    case 'insert_before': {
      if (typeof edit.anchorText !== 'string' || edit.anchorText.length === 0) {
        throw new Error(`edit_file ${edit.type} edit ${index} requires non-empty "anchorText"`);
      }
      if (typeof edit.text !== 'string' || edit.text.length === 0) {
        throw new Error(`edit_file ${edit.type} edit ${index} requires non-empty "text"`);
      }
      return {
        type: edit.type,
        anchorText: edit.anchorText,
        text: edit.text,
        expectedMatches,
      };
    }
    default:
      throw new Error(`edit_file edit ${index} has unsupported type`);
  }
}

function normalizeExpectedMatches(value: unknown, index: number): number {
  if (value === undefined) {
    return 1;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`edit_file edit ${index} requires "expectedMatches" to be a non-negative integer when provided`);
  }
  return value;
}

function validateExpectedSha256(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error('edit_file "expectedSha256" must be a lowercase 64-character hex SHA-256 digest');
  }
}

function applyEditOperation(content: string, edit: NormalizedEditOperation): string {
  if (edit.type === 'replace') {
    const actualMatches = countOccurrences(content, edit.oldText);
    if (actualMatches !== edit.expectedMatches) {
      throw new Error(
        `edit_file replace expected ${edit.expectedMatches} matches for oldText but found ${actualMatches}`,
      );
    }
    return actualMatches === 0 ? content : content.split(edit.oldText).join(edit.newText);
  }

  const actualMatches = countOccurrences(content, edit.anchorText);
  if (actualMatches !== edit.expectedMatches) {
    throw new Error(
      `edit_file ${edit.type} expected ${edit.expectedMatches} matches for anchorText but found ${actualMatches}`,
    );
  }
  if (actualMatches === 0) {
    return content;
  }

  return edit.type === 'insert_after'
    ? content.split(edit.anchorText).join(`${edit.anchorText}${edit.text}`)
    : content.split(edit.anchorText).join(`${edit.text}${edit.anchorText}`);
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (index <= content.length) {
    const nextIndex = content.indexOf(needle, index);
    if (nextIndex === -1) {
      return count;
    }
    count += 1;
    index = nextIndex + needle.length;
  }
  return count;
}

function decodeUtf8TextFile(buffer: Buffer, filePath: string): string {
  if (buffer.includes(0)) {
    throw new Error(`edit_file only supports UTF-8 text files and rejects binary files: ${filePath}`);
  }

  try {
    return UTF8_DECODER.decode(buffer);
  } catch {
    throw new Error(`edit_file only supports UTF-8 text files: ${filePath}`);
  }
}

async function createBackupFile(filePath: string): Promise<string> {
  const backupPath = `${filePath}.bak-${Date.now()}-${randomUUID()}`;
  await copyFile(filePath, backupPath);
  return backupPath;
}

async function writeFileAtomically(filePath: string, content: Buffer): Promise<void> {
  const tempPath = join(dirname(filePath), `.${basename(filePath)}.edit-${Date.now()}-${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, content);
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function normalizePositiveIntegerConfig(value: number | undefined, fallback: number, fieldName: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`edit_file config "${fieldName}" must be a positive number`);
  }
  return Math.max(1, Math.floor(value));
}

function extractInputPath(input: unknown): string {
  const parsed = typeof input === 'string' ? tryParseJsonObject(input) : input;
  return parsed && typeof parsed === 'object' && 'path' in parsed && typeof parsed.path === 'string'
    ? parsed.path
    : '';
}

function tryParseJsonObject(input: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(input) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}
