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
}

interface ReadFileOutput {
  path: string;
  content: string;
  sizeBytes: number;
}

const DEFAULT_MAX_SIZE = 10 * 1_048_576; // 10 MiB
const DEFAULT_PARQUET_MAX_ROWS = 50;
const DEFAULT_PARQUET_MAX_CELL_LENGTH = 500;
const DEFAULT_ZIP_MAX_ENTRIES = 100;
const DEFAULT_ZIP_MAX_ENTRY_SIZE = 1_048_576; // 1 MiB
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export interface ParquetExtractionOptions {
  maxRows: number;
  maxCellLength: number;
}

export interface ZipExtractionOptions {
  maxEntries: number;
  maxEntrySizeBytes: number;
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
      'Read the textual content of a file at the given path. Uses pandoc for supported document and spreadsheet formats.',
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
    async execute(rawInput, context) {
      // Some models send tool input as a JSON string instead of an object — normalise.
      const input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
      const { path: filePath } = input as unknown as ReadFileInput;
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

      return {
        path: zipPath ? `${resolved}#${zipPath.entryPath}` : resolved,
        content,
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
    const extracted = await extractPdfText(contentBuffer.buffer.slice(
      contentBuffer.byteOffset,
      contentBuffer.byteOffset + contentBuffer.byteLength,
    ));
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
  const args = ['--from', inputFormat, '--to', 'markdown', '--wrap=none', filePath];

  return new Promise<string>((resolve, reject) => {
    const child = spawn('pandoc', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    const abortHandler = () => {
      child.kill('SIGTERM');
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
