import { copyFile, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

import type { JsonObject, ToolContext, ToolDefinition } from '../types.js';
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
      type?: undefined;
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

interface MatchLocation extends JsonObject {
  line: number;
  column: number;
  excerpt: string;
}

class EditMatchConflictError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly editIndex: number,
    public readonly operation: NormalizedEditOperation['type'],
    public readonly targetText: string,
    public readonly expectedMatches: number,
    public readonly actualMatches: number,
    public readonly fileSha256: string,
    public readonly candidateLocations: MatchLocation[],
    public readonly replacementAlreadyPresent: boolean,
    public readonly normalizedLineEndingMatches: number,
  ) {
    const targetName = operation === 'replace' ? 'oldText' : 'anchorText';
    super(
      `edit_file ${operation} edit ${editIndex} expected ${formatMatchCount(expectedMatches)} ` +
        `for ${targetName} but found ${actualMatches}`,
    );
    this.name = 'EditMatchConflictError';
  }
}

type EditFileConstraintKind =
  | 'file_not_found'
  | 'path_not_file'
  | 'symbolic_link'
  | 'file_too_large'
  | 'unsupported_text_file';

class EditFileConstraintError extends Error {
  constructor(
    public readonly recoveryKind: EditFileConstraintKind,
    public readonly filePath: string,
    message: string,
    public readonly correctiveAction: string,
  ) {
    super(message);
    this.name = 'EditFileConstraintError';
  }
}

class ExpectedSha256MismatchError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly expectedSha256: string,
    public readonly actualSha256: string,
  ) {
    super(`edit_file expectedSha256 mismatch for ${filePath}`);
    this.name = 'ExpectedSha256MismatchError';
  }
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
      'Apply conservative, atomic text edits to an existing UTF-8 text or code file. Exact target text must have the expected match count (default 1); include surrounding unchanged text to make a target unique, or set expectedMatches explicitly only when every occurrence should be edited. Recoverable conflicts return retry guidance without changing the file. Requires approval.',
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
          description:
            'Ordered edit operations. Each operation must match its expected match count or no write occurs. For an oldText/newText replacement, type defaults to replace.',
          items: {
            oneOf: [
              {
                type: 'object',
                required: ['type', 'oldText', 'newText'],
                additionalProperties: false,
                properties: {
                  type: { type: 'string', enum: ['replace'] },
                  oldText: { type: 'string', minLength: 1, description: 'Exact text to replace. Must be non-empty.' },
                  newText: { type: 'string', description: 'Replacement text. May be empty to delete oldText.' },
                  expectedMatches: {
                    type: 'integer',
                    minimum: 0,
                    description: 'Expected non-overlapping match count. Defaults to 1.',
                  },
                },
              },
              {
                type: 'object',
                required: ['oldText', 'newText'],
                additionalProperties: false,
                properties: {
                  oldText: { type: 'string', minLength: 1, description: 'Exact text to replace. Must be non-empty.' },
                  newText: { type: 'string', description: 'Replacement text. May be empty to delete oldText.' },
                  expectedMatches: {
                    type: 'integer',
                    minimum: 0,
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
                  anchorText: { type: 'string', minLength: 1, description: 'Exact anchor text to insert after. Must be non-empty.' },
                  text: { type: 'string', minLength: 1, description: 'Text to insert. Must be non-empty.' },
                  expectedMatches: {
                    type: 'integer',
                    minimum: 0,
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
                  anchorText: { type: 'string', minLength: 1, description: 'Exact anchor text to insert before. Must be non-empty.' },
                  text: { type: 'string', minLength: 1, description: 'Text to insert. Must be non-empty.' },
                  expectedMatches: {
                    type: 'integer',
                    minimum: 0,
                    description: 'Expected non-overlapping anchor count. Defaults to 1.',
                  },
                },
              },
            ],
          },
        },
        expectedSha256: {
          type: 'string',
          pattern: '^[a-f0-9]{64}$',
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
      if (error instanceof ExpectedSha256MismatchError) {
        return {
          ok: false,
          recoveryKind: 'stale_file',
          toolName: 'edit_file',
          path: error.filePath,
          expectedSha256: error.expectedSha256,
          actualSha256: error.actualSha256,
          message: error.message,
          correctiveAction:
            'Read the current file, revise the edit against that content, then retry using actualSha256 as expectedSha256 only if the file is still unchanged.',
        };
      }
      if (error instanceof EditMatchConflictError) {
        const conflictKind = error.actualMatches === 0
          ? 'no_match'
          : error.expectedMatches === 1 && error.actualMatches > 1
            ? 'ambiguous_match'
            : 'match_count_mismatch';
        return {
          ok: false,
          recoveryKind: 'edit_conflict',
          conflictKind,
          toolName: 'edit_file',
          path: error.filePath,
          editIndex: error.editIndex,
          operation: error.operation,
          targetText: truncateDiagnosticText(error.targetText),
          expectedMatches: error.expectedMatches,
          actualMatches: error.actualMatches,
          fileSha256: error.fileSha256,
          fileChanged: false,
          ...(error.candidateLocations.length === 0
            ? {}
            : { candidateLocations: error.candidateLocations }),
          ...(error.replacementAlreadyPresent ? { replacementAlreadyPresent: true } : {}),
          ...(error.normalizedLineEndingMatches === 0
            ? {}
            : { normalizedLineEndingMatches: error.normalizedLineEndingMatches }),
          message: error.message,
          correctiveAction: buildMatchConflictCorrectiveAction(error),
        };
      }
      if (error instanceof EditFileConstraintError) {
        return {
          ok: false,
          recoveryKind: error.recoveryKind,
          toolName: 'edit_file',
          path: error.filePath,
          fileChanged: false,
          message: error.message,
          correctiveAction: error.correctiveAction,
        };
      }

      return undefined;
    },
    async execute(rawInput, context: ToolContext) {
      const input = normalizeEditFileInput(rawInput);
      const resolved = resolvePathWithinRoot(allowedRoot, input.path);
      const fileStats = await lstat(resolved).catch((error: unknown) => {
        if (isNodeErrorWithCode(error, 'ENOENT')) {
          throw new EditFileConstraintError(
            'file_not_found',
            resolved,
            `edit_file requires an existing file, but ${resolved} was not found`,
            'Check the path or list the containing directory, then retry with an existing file.',
          );
        }
        throw error;
      });
      if (fileStats.isSymbolicLink()) {
        throw new EditFileConstraintError(
          'symbolic_link',
          resolved,
          `edit_file refuses to edit symbolic links: ${resolved}`,
          'Resolve the link and retry with the real target path under the allowed root.',
        );
      }
      if (!fileStats.isFile()) {
        throw new EditFileConstraintError(
          'path_not_file',
          resolved,
          `edit_file requires an existing file path: ${resolved}`,
          'Choose an existing file rather than a directory or special filesystem entry, then retry.',
        );
      }
      if (fileStats.size > maxFileSizeBytes) {
        throw fileTooLargeError(resolved, fileStats.size, maxFileSizeBytes);
      }

      const originalBuffer = await readFile(resolved);
      if (originalBuffer.byteLength > maxFileSizeBytes) {
        throw fileTooLargeError(resolved, originalBuffer.byteLength, maxFileSizeBytes);
      }

      const originalSha256 = sha256(originalBuffer);
      if (input.expectedSha256 !== undefined && input.expectedSha256 !== originalSha256) {
        throw new ExpectedSha256MismatchError(resolved, input.expectedSha256, originalSha256);
      }

      const originalContent = decodeUtf8TextFile(originalBuffer, resolved);
      let editedContent = originalContent;
      for (const [editIndex, edit] of input.edits.entries()) {
        context.signal.throwIfAborted();
        editedContent = applyEditOperation(editedContent, edit, {
          filePath: resolved,
          fileSha256: originalSha256,
          editIndex,
        });
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
        throw fileTooLargeError(resolved, editedBuffer.byteLength, maxFileSizeBytes);
      }

      const currentSha256 = sha256(await readFile(resolved));
      if (currentSha256 !== originalSha256) {
        throw new ExpectedSha256MismatchError(resolved, originalSha256, currentSha256);
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
  const editType = edit.type === undefined && 'oldText' in edit && 'newText' in edit
    ? 'replace'
    : edit.type;
  switch (editType) {
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
        type: editType,
        anchorText: edit.anchorText,
        text: edit.text,
        expectedMatches,
      };
    }
    default:
      throw new Error(
        `edit_file edit ${index} has unsupported type ${JSON.stringify(edit.type)}; supported types are "replace", "insert_after", and "insert_before"`,
      );
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

function applyEditOperation(
  content: string,
  edit: NormalizedEditOperation,
  context: { filePath: string; fileSha256: string; editIndex: number },
): string {
  const targetText = edit.type === 'replace' ? edit.oldText : edit.anchorText;
  const actualMatches = countOccurrences(content, targetText);
  if (actualMatches !== edit.expectedMatches) {
    const normalizedLineEndingMatches = actualMatches === 0 && targetText.includes('\n')
      ? countOccurrences(normalizeLineEndings(content), normalizeLineEndings(targetText))
      : 0;
    throw new EditMatchConflictError(
      context.filePath,
      context.editIndex,
      edit.type,
      targetText,
      edit.expectedMatches,
      actualMatches,
      context.fileSha256,
      actualMatches === 0 ? [] : findMatchLocations(content, targetText),
      edit.type === 'replace' && edit.newText.length > 0 && content.includes(edit.newText),
      normalizedLineEndingMatches,
    );
  }

  if (edit.type === 'replace') {
    return actualMatches === 0 ? content : content.split(edit.oldText).join(edit.newText);
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

function findMatchLocations(content: string, needle: string): MatchLocation[] {
  const locations: MatchLocation[] = [];
  let searchStart = 0;
  while (locations.length < 5) {
    const index = content.indexOf(needle, searchStart);
    if (index === -1) {
      break;
    }
    const lineStart = content.lastIndexOf('\n', index - 1) + 1;
    const lineEnd = content.indexOf('\n', index);
    const linePrefix = content.slice(0, index);
    locations.push({
      line: countOccurrences(linePrefix, '\n') + 1,
      column: index - lineStart + 1,
      excerpt: truncateDiagnosticText(content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd)),
    });
    searchStart = index + needle.length;
  }
  return locations;
}

function buildMatchConflictCorrectiveAction(error: EditMatchConflictError): string {
  if (error.actualMatches === 0) {
    const alreadyPresent = error.replacementAlreadyPresent
      ? ' The replacement text is already present, so first check whether the edit was already applied.'
      : '';
    const lineEndings = error.normalizedLineEndingMatches > 0
      ? ` The target would match ${formatMatchCount(error.normalizedLineEndingMatches)} after normalizing CRLF/LF line endings; copy the exact current line endings or use a smaller unique target.`
      : '';
    return `Read the current file and retry with target text copied exactly, including indentation, blank lines, comments, and line endings.${alreadyPresent}${lineEndings}`;
  }
  if (error.expectedMatches === 1 && error.actualMatches > 1) {
    return 'Add surrounding unchanged text so exactly one location matches. Set expectedMatches to the actual count only if every occurrence should receive the same edit.';
  }
  return 'Read the current file, confirm which occurrences should change, then revise the target text or expectedMatches and retry.';
}

function formatMatchCount(count: number): string {
  return `${count} ${count === 1 ? 'match' : 'matches'}`;
}

function truncateDiagnosticText(text: string): string {
  const maxLength = 500;
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function decodeUtf8TextFile(buffer: Buffer, filePath: string): string {
  if (buffer.includes(0)) {
    throw new EditFileConstraintError(
      'unsupported_text_file',
      filePath,
      `edit_file only supports UTF-8 text files and rejects binary files: ${filePath}`,
      'Use a tool designed for binary files, or choose a UTF-8 text file.',
    );
  }

  try {
    return UTF8_DECODER.decode(buffer);
  } catch {
    throw new EditFileConstraintError(
      'unsupported_text_file',
      filePath,
      `edit_file only supports UTF-8 text files: ${filePath}`,
      'Convert the file to UTF-8 or use a tool that supports its encoding, then retry.',
    );
  }
}

function fileTooLargeError(filePath: string, actualSizeBytes: number, maxFileSizeBytes: number): EditFileConstraintError {
  return new EditFileConstraintError(
    'file_too_large',
    filePath,
    `File ${filePath} is ${actualSizeBytes} bytes and exceeds the edit_file maximum of ${maxFileSizeBytes} bytes`,
    'Use a tool suitable for large files or reduce the file size before retrying.',
  );
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
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
