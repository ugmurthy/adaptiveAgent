import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, relative, resolve, sep } from 'node:path';

import type { JsonValue, ToolDefinition } from '../types.js';
import { buildWorkspacePathRecovery, PathOutsideRootError, resolvePathWithinRoot } from './path-utils.js';

export interface SearchFilesToolConfig {
  /** Restrict searches to paths under this root. Defaults to `process.cwd()`. */
  allowedRoot?: string;
  /** Maximum file size in bytes to inspect. Defaults to 1 MiB. */
  maxFileSizeBytes?: number;
  /** Maximum text files to inspect. Defaults to 1000. */
  maxFiles?: number;
  /** Maximum matches to return before truncating. Defaults to 100. */
  maxMatches?: number;
  /** Default content context lines before and after each match. Defaults to 0. */
  defaultContextLines?: number;
  /** Maximum model-facing result bytes. Defaults to 32 KiB. */
  maxModelResultBytes?: number;
}

interface SearchFilesInput {
  path?: string;
  query?: string;
  filename?: string;
  mode?: 'literal' | 'regex';
  caseSensitive?: boolean;
  includeGlobs?: string[];
  excludeGlobs?: string[];
  maxFiles?: number;
  maxMatches?: number;
  contextLines?: number;
}

type SearchFilesMatch =
  | {
      matchKind: 'filename';
      path: string;
    }
  | {
      matchKind: 'content';
      path: string;
      lineNumber: number;
      lineText: string;
      before?: string[];
      after?: string[];
    };

interface SearchFilesSkippedCounts {
  largeFiles: number;
  binaryFiles: number;
  symlinks: number;
  unreadableFiles: number;
  otherEntries: number;
}

type SearchFilesTruncationReason = 'max_files' | 'max_matches' | 'max_model_result_bytes';

interface SearchFilesOutput {
  path: string;
  matches: SearchFilesMatch[];
  matchCount: number;
  filesSearched: number;
  filesMatched: number;
  filesSkipped: number;
  skipped: SearchFilesSkippedCounts;
  truncated: boolean;
  truncationReasons?: SearchFilesTruncationReason[];
}

interface NormalizedSearchInput {
  path: string;
  query?: string;
  filename?: string;
  mode: 'literal' | 'regex';
  caseSensitive: boolean;
  includeGlobs: CompiledGlob[];
  excludeGlobs: CompiledGlob[];
  maxFiles: number;
  maxMatches: number;
  contextLines: number;
}

interface CompiledGlob {
  pattern: string;
  regex: RegExp;
}

interface SearchMatcher {
  matches(value: string): boolean;
}

interface FileInspection {
  kind: 'text' | 'large' | 'binary' | 'unreadable';
  content?: string;
}

interface FileCollection {
  files: string[];
  skipped: SearchFilesSkippedCounts;
  truncated: boolean;
}

const DEFAULT_MAX_FILE_SIZE_BYTES = 1_048_576; // 1 MiB
const DEFAULT_MAX_FILES = 1000;
const DEFAULT_MAX_MATCHES = 100;
const DEFAULT_CONTEXT_LINES = 0;
const DEFAULT_MODEL_RESULT_MAX_BYTES = 32 * 1024;
const MAX_CONTEXT_LINES = 20;
const MAX_LINE_BYTES = 4096;
const DEFAULT_EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules']);
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export function createSearchFilesTool(config?: SearchFilesToolConfig): ToolDefinition {
  const allowedRoot = config?.allowedRoot ?? process.cwd();
  const resolvedAllowedRoot = resolve(allowedRoot);
  const maxFileSizeBytes = normalizePositiveIntegerConfig(
    config?.maxFileSizeBytes,
    DEFAULT_MAX_FILE_SIZE_BYTES,
    'maxFileSizeBytes',
  );
  const defaultMaxFiles = normalizePositiveIntegerConfig(config?.maxFiles, DEFAULT_MAX_FILES, 'maxFiles');
  const defaultMaxMatches = normalizePositiveIntegerConfig(config?.maxMatches, DEFAULT_MAX_MATCHES, 'maxMatches');
  const defaultContextLines = normalizeContextLinesConfig(config?.defaultContextLines, DEFAULT_CONTEXT_LINES);
  const maxModelResultBytes = normalizePositiveIntegerConfig(
    config?.maxModelResultBytes,
    DEFAULT_MODEL_RESULT_MAX_BYTES,
    'maxModelResultBytes',
  );

  return {
    name: 'search_files',
    description:
      'Search text files under a workspace path by file content and/or filename. Returns deterministic workspace-relative results and skips binary or oversized files.',
    maxModelResultBytes,
    retryPolicy: {
      retryable: true,
      retryOn: ['timeout', 'not_found', 'unknown'],
    },
    inputSchema: {
      type: 'object',
      required: [],
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          description: 'Optional workspace-relative or absolute path to search. Defaults to the workspace root.',
        },
        query: {
          type: 'string',
          description: 'Optional content query. At least one of query or filename is required.',
        },
        filename: {
          type: 'string',
          description: 'Optional filename substring or regex matched against the basename. At least one of query or filename is required.',
        },
        mode: {
          type: 'string',
          enum: ['literal', 'regex'],
          description: 'Whether query and filename are interpreted literally or as regular expressions. Defaults to literal.',
        },
        caseSensitive: {
          type: 'boolean',
          description: 'Whether matching is case-sensitive. Defaults to false.',
        },
        includeGlobs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional include globs over workspace-relative POSIX paths. Supports *, ?, and **.',
        },
        excludeGlobs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional exclude globs over workspace-relative POSIX paths. Excludes win over includes.',
        },
        maxFiles: {
          type: 'number',
          description: 'Optional maximum number of text files to inspect.',
        },
        maxMatches: {
          type: 'number',
          description: 'Optional maximum number of matches to return.',
        },
        contextLines: {
          type: 'number',
          description: 'Optional number of lines before and after each content match. Defaults to the factory default.',
        },
      },
    },
    summarizeResult(output) {
      if (!isSearchFilesOutput(output)) {
        return output;
      }

      return {
        path: output.path,
        matchCount: output.matchCount,
        filesSearched: output.filesSearched,
        filesMatched: output.filesMatched,
        filesSkipped: output.filesSkipped,
        truncated: output.truncated,
        ...(output.truncationReasons === undefined ? {} : { truncationReasons: output.truncationReasons }),
      } as unknown as JsonValue;
    },
    formatResultForModel(output, context) {
      if (!isSearchFilesOutput(output)) {
        return output;
      }

      return fitSearchOutputToBytes(output, context.maxBytes) as unknown as JsonValue;
    },
    recoverError(error, input) {
      const filePath = extractInputPath(input);
      if (error instanceof PathOutsideRootError) {
        return buildWorkspacePathRecovery('search_files', filePath, error);
      }

      return undefined;
    },
    async execute(rawInput, context) {
      const input = normalizeSearchInput(
        rawInput,
        defaultMaxFiles,
        defaultMaxMatches,
        defaultContextLines,
      );
      const resolvedSearchPath = resolvePathWithinRoot(allowedRoot, input.path);
      const rootRelativeSearchPath = toWorkspaceRelativePath(resolvedAllowedRoot, resolvedSearchPath);
      const contentMatcher = input.query === undefined
        ? undefined
        : createMatcher(input.query, input.mode, input.caseSensitive, 'query');
      const filenameMatcher = input.filename === undefined
        ? undefined
        : createMatcher(input.filename, input.mode, input.caseSensitive, 'filename');
      const collection = await collectSearchFiles({
        resolvedAllowedRoot,
        resolvedSearchPath,
        includeGlobs: input.includeGlobs,
        excludeGlobs: input.excludeGlobs,
        maxFiles: input.maxFiles,
        signal: context.signal,
      });

      const matches: SearchFilesMatch[] = [];
      const matchedFiles = new Set<string>();
      const skipped = { ...collection.skipped };
      const truncationReasons = new Set<SearchFilesTruncationReason>();
      if (collection.truncated) {
        truncationReasons.add('max_files');
      }

      let filesSearched = 0;

      for (const filePath of collection.files) {
        context.signal.throwIfAborted();
        const relativePath = toWorkspaceRelativePath(resolvedAllowedRoot, filePath);
        const inspection = await inspectTextFile(filePath, maxFileSizeBytes);

        if (inspection.kind === 'large') {
          skipped.largeFiles += 1;
          continue;
        }
        if (inspection.kind === 'binary') {
          skipped.binaryFiles += 1;
          continue;
        }
        if (inspection.kind === 'unreadable') {
          skipped.unreadableFiles += 1;
          continue;
        }

        filesSearched += 1;
        const filenameMatches = filenameMatcher?.matches(basename(relativePath)) ?? true;
        if (!filenameMatches) {
          continue;
        }

        if (!contentMatcher) {
          matches.push({ matchKind: 'filename', path: relativePath });
          matchedFiles.add(relativePath);
        } else {
          for (const match of findContentMatches(
            relativePath,
            inspection.content ?? '',
            contentMatcher,
            input.contextLines,
          )) {
            matches.push(match);
            matchedFiles.add(relativePath);
            if (matches.length >= input.maxMatches) {
              truncationReasons.add('max_matches');
              break;
            }
          }
        }

        if (matches.length >= input.maxMatches) {
          truncationReasons.add('max_matches');
          break;
        }
      }

      const output: SearchFilesOutput = {
        path: rootRelativeSearchPath,
        matches,
        matchCount: matches.length,
        filesSearched,
        filesMatched: matchedFiles.size,
        filesSkipped: totalSkipped(skipped),
        skipped,
        truncated: truncationReasons.size > 0,
        ...(truncationReasons.size === 0 ? {} : { truncationReasons: [...truncationReasons] }),
      };

      return fitSearchOutputToBytes(output, maxModelResultBytes) as unknown as ReturnType<ToolDefinition['execute']>;
    },
  };
}

function normalizeSearchInput(
  rawInput: unknown,
  defaultMaxFiles: number,
  defaultMaxMatches: number,
  defaultContextLines: number,
): NormalizedSearchInput {
  const input = parseObjectInput(rawInput, 'search_files expects a JSON object');
  const searchPath = input.path === undefined ? '.' : input.path;
  if (typeof searchPath !== 'string' || !searchPath.trim()) {
    throw new Error('search_files requires "path" to be a non-empty string when provided');
  }

  const query = normalizeOptionalSearchString(input.query, 'query');
  const filename = normalizeOptionalSearchString(input.filename, 'filename');
  if (query === undefined && filename === undefined) {
    throw new Error('search_files requires at least one of "query" or "filename"');
  }

  const mode = input.mode === undefined ? 'literal' : input.mode;
  if (mode !== 'literal' && mode !== 'regex') {
    throw new Error('search_files "mode" must be "literal" or "regex"');
  }

  const caseSensitive = input.caseSensitive ?? false;
  if (typeof caseSensitive !== 'boolean') {
    throw new Error('search_files "caseSensitive" must be a boolean when provided');
  }

  return {
    path: searchPath,
    query,
    filename,
    mode,
    caseSensitive,
    includeGlobs: normalizeGlobArray(input.includeGlobs, 'includeGlobs'),
    excludeGlobs: normalizeGlobArray(input.excludeGlobs, 'excludeGlobs'),
    maxFiles: normalizePositiveIntegerInput(input.maxFiles, defaultMaxFiles, 'maxFiles'),
    maxMatches: normalizePositiveIntegerInput(input.maxMatches, defaultMaxMatches, 'maxMatches'),
    contextLines: normalizeContextLinesInput(input.contextLines, defaultContextLines),
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

function normalizeOptionalSearchString(value: unknown, fieldName: 'query' | 'filename'): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`search_files "${fieldName}" must be a non-empty string when provided`);
  }
  return value;
}

function normalizeGlobArray(value: unknown, fieldName: 'includeGlobs' | 'excludeGlobs'): CompiledGlob[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`search_files "${fieldName}" must be an array of strings when provided`);
  }

  return value.map((glob, index) => {
    if (typeof glob !== 'string' || !glob.trim()) {
      throw new Error(`search_files "${fieldName}" entry ${index} must be a non-empty string`);
    }
    return compileGlob(glob);
  });
}

function normalizePositiveIntegerConfig(value: number | undefined, fallback: number, fieldName: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`search_files config "${fieldName}" must be a positive number`);
  }
  return Math.max(1, Math.floor(value));
}

function normalizePositiveIntegerInput(value: unknown, fallback: number, fieldName: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`search_files "${fieldName}" must be a positive number when provided`);
  }
  return Math.max(1, Math.floor(value));
}

function normalizeContextLinesConfig(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('search_files config "defaultContextLines" must be a non-negative number');
  }
  return Math.min(MAX_CONTEXT_LINES, Math.floor(value));
}

function normalizeContextLinesInput(value: unknown, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('search_files "contextLines" must be a non-negative number when provided');
  }
  return Math.min(MAX_CONTEXT_LINES, Math.floor(value));
}

function createMatcher(
  pattern: string,
  mode: 'literal' | 'regex',
  caseSensitive: boolean,
  fieldName: 'query' | 'filename',
): SearchMatcher {
  if (mode === 'literal') {
    const needle = caseSensitive ? pattern : pattern.toLowerCase();
    return {
      matches(value: string) {
        const haystack = caseSensitive ? value : value.toLowerCase();
        return haystack.includes(needle);
      },
    };
  }

  try {
    const regex = new RegExp(pattern, caseSensitive ? '' : 'i');
    if (regex.test('')) {
      throw new Error('must not match empty strings');
    }
    return {
      matches(value: string) {
        regex.lastIndex = 0;
        return regex.test(value);
      },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid search_files ${fieldName} regex: ${reason}`);
  }
}

function compileGlob(pattern: string): CompiledGlob {
  const normalized = toPosixPath(pattern.trim()).replace(/^\.\//, '');
  return {
    pattern: normalized,
    regex: new RegExp(`^${globToRegexSource(normalized)}$`),
  };
}

function globToRegexSource(pattern: string): string {
  let source = '';
  for (let index = 0; index < pattern.length;) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 3;
      } else {
        source += '.*';
        index += 2;
      }
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      index += 1;
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }

    source += escapeRegexChar(char);
    index += 1;
  }

  return source;
}

function escapeRegexChar(char: string): string {
  return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
}

async function collectSearchFiles(options: {
  resolvedAllowedRoot: string;
  resolvedSearchPath: string;
  includeGlobs: CompiledGlob[];
  excludeGlobs: CompiledGlob[];
  maxFiles: number;
  signal: AbortSignal;
}): Promise<FileCollection> {
  const files: string[] = [];
  const skipped = emptySkippedCounts();
  let truncated = false;

  const visit = async (absolutePath: string): Promise<void> => {
    if (truncated) {
      return;
    }
    options.signal.throwIfAborted();

    const entryStats = await lstat(absolutePath);
    const relativePath = toWorkspaceRelativePath(options.resolvedAllowedRoot, absolutePath);

    if (entryStats.isSymbolicLink()) {
      skipped.symlinks += 1;
      return;
    }

    if (entryStats.isDirectory()) {
      const entries = (await readdir(absolutePath, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name));

      for (const entry of entries) {
        if (truncated) {
          return;
        }

        const childPath = `${absolutePath}${sep}${entry.name}`;
        const childRelativePath = toWorkspaceRelativePath(options.resolvedAllowedRoot, childPath);

        if (entry.isSymbolicLink()) {
          skipped.symlinks += 1;
          continue;
        }

        if (entry.isDirectory()) {
          if (shouldSkipDefaultDirectory(childRelativePath, entry.name, options.includeGlobs)) {
            continue;
          }
          await visit(childPath);
          continue;
        }

        if (!entry.isFile()) {
          skipped.otherEntries += 1;
          continue;
        }

        if (!isAllowedByGlobs(childRelativePath, options.includeGlobs, options.excludeGlobs)) {
          continue;
        }

        if (files.length >= options.maxFiles) {
          truncated = true;
          return;
        }

        files.push(childPath);
      }
      return;
    }

    if (!entryStats.isFile()) {
      skipped.otherEntries += 1;
      return;
    }

    if (!isAllowedByGlobs(relativePath, options.includeGlobs, options.excludeGlobs)) {
      return;
    }

    if (files.length >= options.maxFiles) {
      truncated = true;
      return;
    }

    files.push(absolutePath);
  };

  await visit(options.resolvedSearchPath);
  files.sort((left, right) =>
    toWorkspaceRelativePath(options.resolvedAllowedRoot, left)
      .localeCompare(toWorkspaceRelativePath(options.resolvedAllowedRoot, right)),
  );

  return { files, skipped, truncated };
}

function shouldSkipDefaultDirectory(
  relativePath: string,
  directoryName: string,
  includeGlobs: CompiledGlob[],
): boolean {
  if (!DEFAULT_EXCLUDED_DIRECTORIES.has(directoryName)) {
    return false;
  }

  const pathSegments = relativePath.split('/');
  return !includeGlobs.some((glob) => {
    const globSegments = glob.pattern.split('/');
    return globSegments.some((segment) => pathSegments.includes(segment));
  });
}

function isAllowedByGlobs(relativePath: string, includeGlobs: CompiledGlob[], excludeGlobs: CompiledGlob[]): boolean {
  if (matchesAnyGlob(relativePath, excludeGlobs)) {
    return false;
  }
  if (includeGlobs.length === 0) {
    return true;
  }
  return matchesAnyGlob(relativePath, includeGlobs);
}

function matchesAnyGlob(relativePath: string, globs: CompiledGlob[]): boolean {
  return globs.some((glob) => glob.regex.test(relativePath));
}

async function inspectTextFile(filePath: string, maxFileSizeBytes: number): Promise<FileInspection> {
  try {
    const fileStats = await lstat(filePath);
    if (!fileStats.isFile()) {
      return { kind: 'unreadable' };
    }
    if (fileStats.size > maxFileSizeBytes) {
      return { kind: 'large' };
    }

    const buffer = await readFile(filePath);
    if (buffer.byteLength > maxFileSizeBytes) {
      return { kind: 'large' };
    }
    if (buffer.includes(0)) {
      return { kind: 'binary' };
    }

    try {
      return { kind: 'text', content: UTF8_DECODER.decode(buffer) };
    } catch {
      return { kind: 'binary' };
    }
  } catch {
    return { kind: 'unreadable' };
  }
}

function* findContentMatches(
  relativePath: string,
  content: string,
  matcher: SearchMatcher,
  contextLines: number,
): Iterable<SearchFilesMatch> {
  const lines = content.split(/\r\n|\n|\r/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!matcher.matches(line)) {
      continue;
    }

    const before = contextLines > 0
      ? lines.slice(Math.max(0, index - contextLines), index).map(capLineForResult)
      : undefined;
    const after = contextLines > 0
      ? lines.slice(index + 1, Math.min(lines.length, index + contextLines + 1)).map(capLineForResult)
      : undefined;

    yield {
      matchKind: 'content',
      path: relativePath,
      lineNumber: index + 1,
      lineText: capLineForResult(line),
      ...(before && before.length > 0 ? { before } : {}),
      ...(after && after.length > 0 ? { after } : {}),
    };
  }
}

function capLineForResult(line: string): string {
  const capped = truncateUtf8(line, MAX_LINE_BYTES);
  return capped.truncated ? `${capped.text}[truncated]` : capped.text;
}

function fitSearchOutputToBytes(output: SearchFilesOutput, maxBytes: number): SearchFilesOutput {
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') <= maxBytes) {
    return output;
  }

  const matches = [...output.matches];
  const truncationReasons = new Set(output.truncationReasons ?? []);
  truncationReasons.add('max_model_result_bytes');
  let candidate: SearchFilesOutput = {
    ...output,
    matches,
    matchCount: matches.length,
    truncated: true,
    truncationReasons: [...truncationReasons],
  };

  while (matches.length > 0 && Buffer.byteLength(JSON.stringify(candidate), 'utf8') > maxBytes) {
    matches.pop();
    candidate = {
      ...candidate,
      matches,
      matchCount: matches.length,
    };
  }

  return candidate;
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const source = Buffer.from(text, 'utf8');
  if (source.byteLength <= maxBytes) {
    return { text, truncated: false };
  }

  let end = Math.max(0, maxBytes);
  while (end > 0 && (source[end] & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return {
    text: source.subarray(0, end).toString('utf8'),
    truncated: true,
  };
}

function totalSkipped(skipped: SearchFilesSkippedCounts): number {
  return skipped.largeFiles + skipped.binaryFiles + skipped.symlinks + skipped.unreadableFiles + skipped.otherEntries;
}

function emptySkippedCounts(): SearchFilesSkippedCounts {
  return {
    largeFiles: 0,
    binaryFiles: 0,
    symlinks: 0,
    unreadableFiles: 0,
    otherEntries: 0,
  };
}

function isSearchFilesOutput(output: unknown): output is SearchFilesOutput {
  return Boolean(
    output &&
      typeof output === 'object' &&
      'matches' in output &&
      Array.isArray((output as { matches?: unknown }).matches) &&
      'filesSearched' in output,
  );
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

function toWorkspaceRelativePath(resolvedAllowedRoot: string, absolutePath: string): string {
  const relativePath = relative(resolvedAllowedRoot, absolutePath) || '.';
  return toPosixPath(relativePath);
}

function toPosixPath(path: string): string {
  return path.split(sep).join('/');
}
