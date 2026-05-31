import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import JSZip from 'jszip';

import type { ToolDefinition } from '../types.js';
import { buildWorkspacePathRecovery, PathOutsideRootError, resolvePathWithinRoot } from './path-utils.js';
import { extractPdfTextWithPdfJs } from './pdf-text.js';

export interface ReadFileToolConfig {
  /** Restrict reads to paths under this root. Defaults to `process.cwd()`. */
  allowedRoot?: string;
  /** Maximum file size in bytes. Defaults to 10 MiB. */
  maxSizeBytes?: number;
  /** Maximum Parquet rows to include in extracted samples. Defaults to 50. */
  parquetMaxRows?: number;
  /** Maximum characters to include for a single Parquet cell. Defaults to 500. */
  parquetMaxCellLength?: number;
  /** Maximum ZIP entries to include in archive manifests. Defaults to 100. */
  zipMaxEntries?: number;
  /** Maximum uncompressed ZIP entry size to extract. Defaults to 1 MiB. */
  zipMaxEntrySizeBytes?: number;
  /** Override PDF extraction for tests or custom runtimes. */
  extractPdfText?: (rawBuffer: ArrayBuffer) => Promise<{ title: string; text: string }>;
  /** Override pandoc-based extraction for tests or custom runtimes. */
  extractWithPandoc?: (filePath: string, inputFormat: string, signal?: AbortSignal) => Promise<string>;
  /** Override Parquet extraction for tests or custom runtimes. */
  extractParquet?: (filePath: string, options: ParquetExtractionOptions, signal?: AbortSignal) => Promise<string>;
}

interface ReadFileInput {
  path: string;
  lineStart?: number;
  lineEnd?: number;
  offsetBytes?: number;
  maxBytes?: number;
}

interface ReadFileOutput {
  path: string;
  content: string;
  sizeBytes: number;
  truncated?: boolean;
  bytesReturned?: number;
  bytesAvailable?: number;
  lineStart?: number;
  lineEnd?: number;
  totalLines?: number;
  next?: Partial<ReadFileInput>;
}

const DEFAULT_MAX_SIZE = 10 * 1_048_576; // 10 MiB
const DEFAULT_PARQUET_MAX_ROWS = 50;
const DEFAULT_PARQUET_MAX_CELL_LENGTH = 500;
const DEFAULT_ZIP_MAX_ENTRIES = 100;
const DEFAULT_ZIP_MAX_ENTRY_SIZE = 1_048_576; // 1 MiB
const DEFAULT_MODEL_RESULT_MAX_BYTES = 32 * 1024;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export interface ParquetExtractionOptions {
  maxRows: number;
  maxCellLength: number;
}

export interface ZipExtractionOptions {
  maxEntries: number;
  maxEntrySizeBytes: number;
}

function summarizeReadFileOutput(output: ReadFileOutput): unknown {
  if (typeof output.content !== 'string') {
    return output;
  }

  return {
    path: output.path,
    sizeBytes: output.sizeBytes,
    contentBytes: Buffer.byteLength(output.content, 'utf8'),
    truncated: output.truncated ?? false,
    ...(output.bytesReturned === undefined ? {} : { bytesReturned: output.bytesReturned }),
    ...(output.bytesAvailable === undefined ? {} : { bytesAvailable: output.bytesAvailable }),
    ...(output.lineStart === undefined ? {} : { lineStart: output.lineStart }),
    ...(output.lineEnd === undefined ? {} : { lineEnd: output.lineEnd }),
    ...(output.totalLines === undefined ? {} : { totalLines: output.totalLines }),
    ...(output.next === undefined ? {} : { next: output.next }),
  };
}

function formatReadFileOutputForModel(output: ReadFileOutput, maxBytes: number): unknown {
  if (typeof output.content !== 'string') {
    return output;
  }

  const contentBytes = Buffer.byteLength(output.content, 'utf8');
  if (contentBytes <= maxBytes) {
    return output;
  }

  const capped = truncateUtf8(output.content, Math.max(0, maxBytes - 512));
  return {
    ...output,
    content: capped.text,
    truncated: true,
    bytesReturned: capped.bytes,
    bytesAvailable: output.bytesAvailable ?? contentBytes,
    next: output.next ?? {
      path: output.path,
      offsetBytes: capped.bytes,
      maxBytes,
    },
  };
}

function applyReadRange(content: string, input: ReadFileInput): Omit<ReadFileOutput, 'path' | 'sizeBytes'> {
  const fullBytes = Buffer.byteLength(content, 'utf8');
  const hasLineRange = input.lineStart !== undefined || input.lineEnd !== undefined;
  if (hasLineRange) {
    const lines = content.split(/\r?\n/);
    const lineStart = normalizePositiveInteger(input.lineStart, 1);
    const lineEnd = Math.min(
      normalizePositiveInteger(input.lineEnd, lines.length),
      lines.length,
    );
    if (lineStart > lineEnd) {
      return {
        content: '',
        truncated: lineEnd < lines.length,
        bytesReturned: 0,
        bytesAvailable: fullBytes,
        lineStart,
        lineEnd,
        totalLines: lines.length,
      };
    }

    const selected = lines.slice(lineStart - 1, lineEnd).join('\n');
    return {
      content: selected,
      truncated: lineStart > 1 || lineEnd < lines.length,
      bytesReturned: Buffer.byteLength(selected, 'utf8'),
      bytesAvailable: fullBytes,
      lineStart,
      lineEnd,
      totalLines: lines.length,
      ...(lineEnd < lines.length
        ? {
            next: {
              path: input.path,
              lineStart: lineEnd + 1,
              lineEnd: Math.min(lines.length, lineEnd + (lineEnd - lineStart + 1)),
            },
          }
        : {}),
    };
  }

  const offsetBytes = normalizeNonNegativeInteger(input.offsetBytes, 0);
  const maxBytes = input.maxBytes === undefined ? undefined : normalizePositiveInteger(input.maxBytes, fullBytes);
  if (offsetBytes === 0 && maxBytes === undefined) {
    return {
      content,
      bytesReturned: fullBytes,
      bytesAvailable: fullBytes,
      truncated: false,
    };
  }

  const source = Buffer.from(content, 'utf8');
  const start = Math.min(offsetBytes, source.byteLength);
  const end = maxBytes === undefined ? source.byteLength : Math.min(source.byteLength, start + maxBytes);
  const selected = source.subarray(adjustUtf8Start(source, start), adjustUtf8End(source, end));
  const selectedText = selected.toString('utf8');
  const truncated = start > 0 || end < source.byteLength;
  return {
    content: selectedText,
    truncated,
    bytesReturned: selected.byteLength,
    bytesAvailable: source.byteLength,
    ...(truncated && end < source.byteLength
      ? {
          next: {
            path: input.path,
            offsetBytes: end,
            ...(maxBytes === undefined ? {} : { maxBytes }),
          },
        }
      : {}),
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

function truncateUtf8(text: string, maxBytes: number): { text: string; bytes: number } {
  const source = Buffer.from(text, 'utf8');
  if (source.byteLength <= maxBytes) {
    return { text, bytes: source.byteLength };
  }

  const end = adjustUtf8End(source, Math.max(0, maxBytes));
  return {
    text: source.subarray(0, end).toString('utf8'),
    bytes: end,
  };
}

function adjustUtf8Start(buffer: Buffer, start: number): number {
  let index = Math.min(Math.max(0, start), buffer.byteLength);
  while (index < buffer.byteLength && (buffer[index] & 0b1100_0000) === 0b1000_0000) {
    index += 1;
  }
  return index;
}

function adjustUtf8End(buffer: Buffer, end: number): number {
  let index = Math.min(Math.max(0, end), buffer.byteLength);
  while (index > 0 && (buffer[index] & 0b1100_0000) === 0b1000_0000) {
    index -= 1;
  }
  return index;
}

const DIRECT_TEXT_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.css',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.htm',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.mjs',
  '.cjs',
  '.log',
  '.md',
  '.markdown',
  '.mdx',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.sql',
  '.svg',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

const PANDOC_INPUT_FORMAT_BY_EXTENSION: Record<string, string> = {
  '.adoc': 'asciidoc',
  '.asciidoc': 'asciidoc',
  '.csv': 'csv',
  '.docbook': 'docbook',
  '.docx': 'docx',
  '.epub': 'epub',
  '.ipynb': 'ipynb',
  '.odt': 'odt',
  '.opml': 'opml',
  '.org': 'org',
  '.pptx': 'pptx',
  '.rst': 'rst',
  '.rtf': 'rtf',
  '.tex': 'latex',
  '.tsv': 'tsv',
  '.xlsx': 'xlsx',
};

export function createReadFileTool(config?: ReadFileToolConfig): ToolDefinition {
  const allowedRoot = config?.allowedRoot ?? process.cwd();
  const maxSizeBytes = config?.maxSizeBytes ?? DEFAULT_MAX_SIZE;
  const parquetOptions = {
    maxRows: config?.parquetMaxRows ?? DEFAULT_PARQUET_MAX_ROWS,
    maxCellLength: config?.parquetMaxCellLength ?? DEFAULT_PARQUET_MAX_CELL_LENGTH,
  } satisfies ParquetExtractionOptions;
  const zipOptions = {
    maxEntries: config?.zipMaxEntries ?? DEFAULT_ZIP_MAX_ENTRIES,
    maxEntrySizeBytes: config?.zipMaxEntrySizeBytes ?? DEFAULT_ZIP_MAX_ENTRY_SIZE,
  } satisfies ZipExtractionOptions;
  const extractPdfText = config?.extractPdfText ?? extractPdfTextWithPdfJs;
  const extractWithPandoc = config?.extractWithPandoc ?? defaultExtractWithPandoc;
  const extractParquet = config?.extractParquet ?? defaultExtractParquet;

  return {
    name: 'read_file',
    description:
      'Read the textual content of a file at the given path. Supports optional line or byte ranges. Uses pandoc for supported document and spreadsheet formats.',
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
        path: { type: 'string', description: 'Absolute or relative file path to read.' },
        lineStart: {
          type: 'number',
          description: 'Optional 1-based first line to return for text content.',
        },
        lineEnd: {
          type: 'number',
          description: 'Optional 1-based last line to return for text content.',
        },
        offsetBytes: {
          type: 'number',
          description: 'Optional UTF-8 byte offset to start returning content from.',
        },
        maxBytes: {
          type: 'number',
          description: 'Optional maximum UTF-8 bytes of text content to return.',
        },
      },
    },
    summarizeResult(output) {
      return summarizeReadFileOutput(output as ReadFileOutput);
    },
    formatResultForModel(output, context) {
      return formatReadFileOutputForModel(output as ReadFileOutput, context.maxBytes);
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
    async execute(rawInput, context) {
      // Some models send tool input as a JSON string instead of an object — normalise.
      const input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
      const readInput = input as unknown as ReadFileInput;
      const { path: filePath } = readInput;
      const zipPath = parseZipMemberPath(filePath);
      const resolved = resolvePathWithinRoot(allowedRoot, zipPath?.archivePath ?? filePath);

      const fileStats = await stat(resolved);
      if (fileStats.size > maxSizeBytes) {
        throw new Error(`File ${resolved} exceeds maximum size of ${maxSizeBytes} bytes`);
      }

      const contentBuffer = await readFile(resolved);
      if (contentBuffer.byteLength > maxSizeBytes) {
        throw new Error(`File ${resolved} exceeds maximum size of ${maxSizeBytes} bytes`);
      }

      const content = await readContentAsText(
        resolved,
        contentBuffer,
        extractPdfText,
        extractWithPandoc,
        extractParquet,
        parquetOptions,
        zipOptions,
        context?.signal,
        zipPath?.entryPath,
      );
      const ranged = applyReadRange(content, readInput);

      return {
        path: zipPath ? `${resolved}#${zipPath.entryPath}` : resolved,
        ...ranged,
        sizeBytes: contentBuffer.byteLength,
      } satisfies ReadFileOutput as unknown as ReturnType<ToolDefinition['execute']>;
    },
  };
}

async function readContentAsText(
  resolvedPath: string,
  contentBuffer: Buffer,
  extractPdfText: (rawBuffer: ArrayBuffer) => Promise<{ title: string; text: string }>,
  extractWithPandoc: (filePath: string, inputFormat: string, signal?: AbortSignal) => Promise<string>,
  extractParquet: (filePath: string, options: ParquetExtractionOptions, signal?: AbortSignal) => Promise<string>,
  parquetOptions: ParquetExtractionOptions,
  zipOptions: ZipExtractionOptions,
  signal: AbortSignal | undefined,
  zipEntryPath?: string,
): Promise<string> {
  const extension = extname(resolvedPath).toLowerCase();
  const pandocInputFormat = PANDOC_INPUT_FORMAT_BY_EXTENSION[extension];

  if (extension === '.zip') {
    return readZipAsText(resolvedPath, contentBuffer, extractPdfText, extractWithPandoc, extractParquet, parquetOptions, zipOptions, signal, zipEntryPath);
  }

  if (extension === '.pdf') {
    signal?.throwIfAborted();
    const extracted = await extractPdfText(contentBuffer.buffer.slice(
      contentBuffer.byteOffset,
      contentBuffer.byteOffset + contentBuffer.byteLength,
    ));
    signal?.throwIfAborted();
    return extracted.text;
  }

  if (pandocInputFormat) {
    return extractWithPandoc(resolvedPath, pandocInputFormat, signal);
  }

  if (extension === '.parquet') {
    return extractParquet(resolvedPath, parquetOptions, signal);
  }

  if (DIRECT_TEXT_EXTENSIONS.has(extension) || isLikelyUtf8Text(contentBuffer)) {
    return UTF8_DECODER.decode(contentBuffer);
  }

  throw new Error(`Unsupported binary file format for read_file: ${extension || resolvedPath}`);
}

function parseZipMemberPath(filePath: string): { archivePath: string; entryPath: string } | undefined {
  const marker = '.zip#';
  const markerIndex = filePath.toLowerCase().indexOf(marker);
  if (markerIndex < 0) {
    return undefined;
  }

  const archivePath = filePath.slice(0, markerIndex + '.zip'.length);
  const entryPath = filePath.slice(markerIndex + marker.length);
  if (!entryPath) {
    throw new Error('ZIP member path must include an entry after #');
  }
  validateZipEntryPath(entryPath);
  return { archivePath, entryPath };
}

async function readZipAsText(
  resolvedPath: string,
  contentBuffer: Buffer,
  extractPdfText: (rawBuffer: ArrayBuffer) => Promise<{ title: string; text: string }>,
  extractWithPandoc: (filePath: string, inputFormat: string, signal?: AbortSignal) => Promise<string>,
  extractParquet: (filePath: string, options: ParquetExtractionOptions, signal?: AbortSignal) => Promise<string>,
  parquetOptions: ParquetExtractionOptions,
  zipOptions: ZipExtractionOptions,
  signal?: AbortSignal,
  entryPath?: string,
): Promise<string> {
  signal?.throwIfAborted();
  const zip = await JSZip.loadAsync(contentBuffer);
  signal?.throwIfAborted();

  if (!entryPath) {
    return JSON.stringify(buildZipManifest(resolvedPath, zip, zipOptions), null, 2);
  }

  validateZipEntryPath(entryPath);
  const entry = zip.file(entryPath);
  if (!entry) {
    throw new Error(`ZIP entry not found: ${entryPath}`);
  }

  const uncompressedSize = zipEntryUncompressedSize(entry);
  if (uncompressedSize !== undefined && uncompressedSize > zipOptions.maxEntrySizeBytes) {
    throw new Error(`ZIP entry ${entryPath} exceeds maximum size of ${zipOptions.maxEntrySizeBytes} bytes`);
  }

  const entryContent = Buffer.from(await entry.async('uint8array'));
  signal?.throwIfAborted();
  if (entryContent.byteLength > zipOptions.maxEntrySizeBytes) {
    throw new Error(`ZIP entry ${entryPath} exceeds maximum size of ${zipOptions.maxEntrySizeBytes} bytes`);
  }

  return readZipEntryContentAsText(
    resolvedPath,
    entryPath,
    entryContent,
    extractPdfText,
    extractWithPandoc,
    extractParquet,
    parquetOptions,
    zipOptions,
    signal,
  );
}

async function readZipEntryContentAsText(
  resolvedPath: string,
  entryPath: string,
  entryContent: Buffer,
  extractPdfText: (rawBuffer: ArrayBuffer) => Promise<{ title: string; text: string }>,
  extractWithPandoc: (filePath: string, inputFormat: string, signal?: AbortSignal) => Promise<string>,
  extractParquet: (filePath: string, options: ParquetExtractionOptions, signal?: AbortSignal) => Promise<string>,
  parquetOptions: ParquetExtractionOptions,
  zipOptions: ZipExtractionOptions,
  signal?: AbortSignal,
): Promise<string> {
  const virtualEntryPath = `${resolvedPath}/${entryPath}`;
  const extension = extname(entryPath).toLowerCase();

  if (!PANDOC_INPUT_FORMAT_BY_EXTENSION[extension]) {
    return readContentAsText(
      virtualEntryPath,
      entryContent,
      extractPdfText,
      extractWithPandoc,
      extractParquet,
      parquetOptions,
      zipOptions,
      signal,
    );
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'read-file-zip-entry-'));
  const tempPath = join(tempDir, basename(entryPath));
  try {
    await writeFile(tempPath, entryContent);
    return await readContentAsText(
      tempPath,
      entryContent,
      extractPdfText,
      extractWithPandoc,
      extractParquet,
      parquetOptions,
      zipOptions,
      signal,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function buildZipManifest(resolvedPath: string, zip: JSZip, options: ZipExtractionOptions): unknown {
  const entries = Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .sort((left, right) => left.name.localeCompare(right.name));
  const visibleEntries = entries.slice(0, options.maxEntries);

  return {
    format: 'zip',
    path: resolvedPath,
    entryCount: entries.length,
    entries: visibleEntries.map((entry) => ({
      path: entry.name,
      uncompressedSize: zipEntryUncompressedSize(entry),
      kind: classifyZipEntry(entry.name),
      readHint: `${resolvedPath}#${entry.name}`,
    })),
    truncated: entries.length > visibleEntries.length,
  };
}

function validateZipEntryPath(entryPath: string): void {
  const normalized = entryPath.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.split('/').some((part) => part === '..')) {
    throw new Error(`Unsafe ZIP entry path: ${entryPath}`);
  }
}

function classifyZipEntry(entryPath: string): 'text' | 'binary' | 'document' | 'parquet' | 'unknown' {
  const extension = extname(entryPath).toLowerCase();
  if (DIRECT_TEXT_EXTENSIONS.has(extension)) return 'text';
  if (PANDOC_INPUT_FORMAT_BY_EXTENSION[extension] || extension === '.pdf') return 'document';
  if (extension === '.parquet') return 'parquet';
  if (extension) return 'binary';
  return 'unknown';
}

function zipEntryUncompressedSize(entry: JSZip.JSZipObject): number | undefined {
  const internalEntry = entry as unknown as { _data?: { uncompressedSize?: unknown } };
  const size = internalEntry._data?.uncompressedSize;
  return typeof size === 'number' && Number.isFinite(size) ? size : undefined;
}

async function defaultExtractParquet(
  filePath: string,
  options: ParquetExtractionOptions,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects, parquetSchema } = await import('hyparquet');
  signal?.throwIfAborted();

  const file = await asyncBufferFromFile(filePath);
  const metadata = await parquetMetadataAsync(file);
  const schema = parquetSchema(metadata);
  const rowCount = Number(metadata.num_rows);
  const sampleRows = await parquetReadObjects({
    file,
    rowStart: 0,
    rowEnd: Math.min(options.maxRows, Number.isFinite(rowCount) ? rowCount : options.maxRows),
  });
  signal?.throwIfAborted();

  return JSON.stringify(
    {
      format: 'parquet',
      rowCount,
      columns: summarizeParquetSchema(schema),
      sampleRows: sampleRows.map((row) => normalizeParquetRow(row, options.maxCellLength)),
      truncated: rowCount > sampleRows.length,
    },
    null,
    2,
  );
}

function summarizeParquetSchema(schema: unknown): Array<{ name: string; type?: string }> {
  if (!schema || typeof schema !== 'object' || !('children' in schema) || !Array.isArray(schema.children)) {
    return [];
  }

  return schema.children.map((child: unknown) => {
    const element = child && typeof child === 'object' && 'element' in child ? child.element : undefined;
    const value = element && typeof element === 'object' ? element as Record<string, unknown> : {};
    return {
      name: typeof value.name === 'string' ? value.name : 'unknown',
      ...(typeof value.type === 'string' ? { type: value.type } : {}),
    };
  });
}

function normalizeParquetRow(row: Record<string, unknown>, maxCellLength: number): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[key] = normalizeParquetValue(value, maxCellLength);
  }
  return normalized;
}

function normalizeParquetValue(value: unknown, maxCellLength: number): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return `[binary ${value.byteLength} bytes]`;
  }
  if (typeof value === 'string') {
    return value.length > maxCellLength ? `${value.slice(0, maxCellLength)}[truncated]` : value;
  }
  if (Array.isArray(value) || (value && typeof value === 'object')) {
    const serialized = JSON.stringify(value, (_key, nestedValue) =>
      typeof nestedValue === 'bigint' ? nestedValue.toString() : nestedValue,
    );
    return serialized.length > maxCellLength ? `${serialized.slice(0, maxCellLength)}[truncated]` : JSON.parse(serialized);
  }
  return value;
}

function isLikelyUtf8Text(contentBuffer: Buffer): boolean {
  if (contentBuffer.includes(0)) {
    return false;
  }

  try {
    UTF8_DECODER.decode(contentBuffer);
    return true;
  } catch {
    return false;
  }
}

async function defaultExtractWithPandoc(
  filePath: string,
  inputFormat: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const args = ['--from', inputFormat, '--to', 'markdown', '--wrap=none', filePath];

  return new Promise<string>((resolve, reject) => {
    const child = spawn('pandoc', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    const abortHandler = () => {
      child.kill('SIGTERM');
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Operation aborted'));
    };

    signal?.addEventListener('abort', abortHandler, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      signal?.removeEventListener('abort', abortHandler);
      reject(new Error(`Failed to start pandoc: ${error.message}`));
    });

    child.on('close', (code, closeSignal) => {
      signal?.removeEventListener('abort', abortHandler);

      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      const reason = stderr.trim() || `pandoc exited with code ${code ?? 'null'} signal ${closeSignal ?? 'null'}`;
      reject(new Error(reason));
    });
  });
}
