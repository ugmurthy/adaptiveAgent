import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ToolContext, ToolDefinition } from '../types.js';
import { buildWorkspacePathRecovery, PathOutsideRootError, resolvePathWithinRoot } from './path-utils.js';

export interface WriteFileToolConfig {
  /** Restrict writes to paths under this root. Defaults to `process.cwd()`. */
  allowedRoot?: string;
  /** Create parent directories if they don't exist. Defaults to `true`. */
  createDirectories?: boolean;
  /** Override pandoc-based conversion for tests or custom runtimes. */
  convertWithPandoc?: (options: PandocConversionOptions, signal?: AbortSignal) => Promise<string | undefined>;
}

interface WriteFileInput {
  path: string;
  content: string;
  inputFormat?: string;
  outputFormat?: string;
  keepIntermediate?: boolean;
}

interface WriteFileOutput {
  path: string;
  sizeBytes: number;
  inputFormat?: string;
  outputFormat?: string;
  intermediatePath?: string;
  stderr?: string;
}

export interface PandocConversionOptions {
  sourcePath: string;
  outputPath: string;
  inputFormat: string;
  outputFormat: SupportedPandocOutputFormat;
}

export type SupportedPandocOutputFormat = 'docx' | 'pptx' | 'latex';

const DEFAULT_INPUT_FORMAT = 'markdown';
const INTERMEDIATE_DIR = 'tmp/write-file-conversions';
const RAW_TEXT_OUTPUT_FORMATS = new Set(['txt', 'plain', 'md', 'markdown']);
const SUPPORTED_PANDOC_OUTPUT_FORMATS = new Set<SupportedPandocOutputFormat>(['docx', 'pptx', 'latex']);
const DEFERRED_OUTPUT_FORMATS = new Set(['pdf', 'xlsx']);
const INTERMEDIATE_EXTENSION_BY_INPUT_FORMAT: Record<string, string> = {
  commonmark: '.md',
  commonmark_x: '.md',
  csv: '.csv',
  gfm: '.md',
  html: '.html',
  json: '.json',
  latex: '.tex',
  markdown: '.md',
  markdown_strict: '.md',
  plain: '.txt',
  rst: '.rst',
  tsv: '.tsv',
};

export function createWriteFileTool(config?: WriteFileToolConfig): ToolDefinition {
  const allowedRoot = config?.allowedRoot ?? process.cwd();
  const createDirectories = config?.createDirectories ?? true;
  const convertWithPandoc = config?.convertWithPandoc ?? defaultConvertWithPandoc;

  return {
    name: 'write_file',
    description:
      'Write UTF-8 text content to a file at the given path. For plain text or Markdown, omit outputFormat; txt, plain, md, and markdown are accepted aliases that write content unchanged. Optionally converts content to docx, pptx, or latex with pandoc. Creates parent directories if needed. Requires approval.',
    inputSchema: {
      type: 'object',
      required: ['path', 'content'],
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Absolute or relative file path to write.' },
        content: { type: 'string', description: 'Text content to write to the file.' },
        inputFormat: {
          type: 'string',
          description: 'Optional pandoc input format used for docx, pptx, or latex conversion. Defaults to markdown.',
        },
        outputFormat: {
          type: 'string',
          enum: ['txt', 'plain', 'md', 'markdown', 'docx', 'pptx', 'latex'],
          description: 'Optional output format. Omit for normal UTF-8 writes. txt, plain, md, and markdown write content unchanged; docx, pptx, and latex convert with pandoc.',
        },
        keepIntermediate: {
          type: 'boolean',
          description: 'For pandoc conversion, whether to keep the temporary source file under tmp/write-file-conversions. Defaults to true.',
        },
      },
    },
    requiresApproval: true,
    recoverError(error, input) {
      const filePath = typeof input === 'object' && input !== null && 'path' in input && typeof input.path === 'string'
        ? input.path
        : '';
      if (error instanceof PathOutsideRootError) {
        return buildWorkspacePathRecovery('write_file', filePath, error);
      }

      return undefined;
    },
    async execute(rawInput, context: ToolContext) {
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

      const { path: filePath, content, inputFormat, outputFormat, keepIntermediate } = input as unknown as WriteFileInput;

      if (typeof filePath !== 'string' || !filePath.trim()) {
        throw new Error('write_file requires a non-empty "path" string');
      }
      if (typeof content !== 'string') {
        throw new Error('write_file requires a "content" string');
      }

      const resolved = resolvePathWithinRoot(allowedRoot, filePath);
      const normalizedOutputFormat = typeof outputFormat === 'string'
        ? outputFormat.trim().toLowerCase()
        : '';

      if (normalizedOutputFormat && !RAW_TEXT_OUTPUT_FORMATS.has(normalizedOutputFormat)) {
        const conversion = await writeConvertedFile({
          allowedRoot,
          resolvedOutputPath: resolved,
          content,
          inputFormat: normalizeInputFormat(inputFormat),
          outputFormat: normalizeOutputFormat(outputFormat),
          keepIntermediate: keepIntermediate ?? true,
          createDirectories,
          convertWithPandoc,
          signal: context.signal,
        });

        return conversion satisfies WriteFileOutput as unknown as ReturnType<ToolDefinition['execute']>;
      }

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

async function writeConvertedFile(options: {
  allowedRoot: string;
  resolvedOutputPath: string;
  content: string;
  inputFormat: string;
  outputFormat: SupportedPandocOutputFormat;
  keepIntermediate: boolean;
  createDirectories: boolean;
  convertWithPandoc: (options: PandocConversionOptions, signal?: AbortSignal) => Promise<string | undefined>;
  signal?: AbortSignal;
}): Promise<WriteFileOutput> {
  if (options.createDirectories) {
    await mkdir(dirname(options.resolvedOutputPath), { recursive: true });
  }

  const intermediateDir = resolvePathWithinRoot(options.allowedRoot, INTERMEDIATE_DIR);
  await mkdir(intermediateDir, { recursive: true });

  const sourcePath = join(
    intermediateDir,
    `write-file-${Date.now()}-${randomUUID()}${extensionForInputFormat(options.inputFormat)}`,
  );

  await writeFile(sourcePath, options.content, 'utf-8');

  try {
    const stderr = await options.convertWithPandoc(
      {
        sourcePath,
        outputPath: options.resolvedOutputPath,
        inputFormat: options.inputFormat,
        outputFormat: options.outputFormat,
      },
      options.signal,
    );

    const outputStats = await stat(options.resolvedOutputPath);

    return {
      path: options.resolvedOutputPath,
      sizeBytes: outputStats.size,
      inputFormat: options.inputFormat,
      outputFormat: options.outputFormat,
      ...(options.keepIntermediate ? { intermediatePath: sourcePath } : {}),
      ...(stderr ? { stderr } : {}),
    };
  } finally {
    if (!options.keepIntermediate) {
      await rm(sourcePath, { force: true });
    }
  }
}

function normalizeInputFormat(inputFormat: string | undefined): string {
  return inputFormat?.trim() || DEFAULT_INPUT_FORMAT;
}

function normalizeOutputFormat(outputFormat: string): SupportedPandocOutputFormat {
  const normalized = outputFormat.trim().toLowerCase();

  if (SUPPORTED_PANDOC_OUTPUT_FORMATS.has(normalized as SupportedPandocOutputFormat)) {
    return normalized as SupportedPandocOutputFormat;
  }

  if (DEFERRED_OUTPUT_FORMATS.has(normalized)) {
    throw new Error(`write_file outputFormat "${normalized}" is deferred; currently supported conversions are docx, pptx, and latex`);
  }

  throw new Error(`Unsupported write_file outputFormat "${outputFormat}". Supported conversions are docx, pptx, and latex`);
}

function extensionForInputFormat(inputFormat: string): string {
  const normalized = inputFormat.trim().toLowerCase().split(/[+-]/, 1)[0] || DEFAULT_INPUT_FORMAT;
  return INTERMEDIATE_EXTENSION_BY_INPUT_FORMAT[normalized] ?? `.${normalized}`;
}

async function defaultConvertWithPandoc(
  options: PandocConversionOptions,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const args = [
    '--from',
    options.inputFormat,
    '--to',
    options.outputFormat,
    '--output',
    options.outputPath,
    options.sourcePath,
  ];

  return new Promise<string | undefined>((resolve, reject) => {
    const child = spawn('pandoc', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';

    const abortHandler = () => {
      child.kill('SIGTERM');
    };

    signal?.addEventListener('abort', abortHandler, { once: true });

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
        resolve(stderr.trim() || undefined);
        return;
      }

      const reason = stderr.trim() || `pandoc exited with code ${code ?? 'null'} signal ${closeSignal ?? 'null'}`;
      reject(new Error(reason));
    });
  });
}
