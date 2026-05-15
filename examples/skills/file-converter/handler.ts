import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';

import type { JsonValue, ToolContext } from '../../../packages/core/src/types.js';

export const name = 'convert_document_with_pandoc';
export const description =
  'Convert a local document with pandoc. Defaults to Markdown output unless another target format is requested.';
export const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sourcePath'],
  properties: {
    sourcePath: {
      type: 'string',
      description: 'Path to the source document to convert.',
    },
    outputPath: {
      type: 'string',
      description: 'Optional destination path. When omitted, a sibling output file is created automatically.',
    },
    from: {
      type: 'string',
      description: 'Optional pandoc input format. Leave unset when pandoc or the file extension can infer it.',
    },
    to: {
      type: 'string',
      description: 'Optional pandoc output format. Defaults to markdown.',
    },
    standalone: {
      type: 'boolean',
      description: 'Whether to ask pandoc for a standalone document when the target format supports it.',
    },
    overwrite: {
      type: 'boolean',
      description: 'Whether to overwrite an existing output file. Defaults to true.',
    },
  },
} as const;
export const outputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sourcePath', 'outputPath', 'to', 'command'],
  properties: {
    sourcePath: { type: 'string' },
    outputPath: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    command: {
      type: 'array',
      items: { type: 'string' },
    },
    stderr: { type: 'string' },
  },
} as const;

interface ConvertInput {
  sourcePath: string;
  outputPath?: string;
  from?: string;
  to?: string;
  standalone?: boolean;
  overwrite?: boolean;
}

interface ConvertOutput {
  sourcePath: string;
  outputPath: string;
  from?: string;
  to: string;
  command: string[];
  stderr?: string;
}

const MARKDOWN_FORMATS = new Set(['markdown', 'gfm', 'commonmark', 'commonmark_x', 'markdown_strict']);

const INPUT_FORMAT_BY_EXTENSION: Record<string, string> = {
  '.adoc': 'asciidoc',
  '.asciidoc': 'asciidoc',
  '.docbook': 'docbook',
  '.docx': 'docx',
  '.epub': 'epub',
  '.htm': 'html',
  '.html': 'html',
  '.ipynb': 'ipynb',
  '.latex': 'latex',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.mdown': 'markdown',
  '.odt': 'odt',
  '.org': 'org',
  '.rst': 'rst',
  '.rtf': 'rtf',
  '.tex': 'latex',
  '.textile': 'textile',
};

const OUTPUT_EXTENSION_BY_FORMAT: Record<string, string> = {
  asciidoc: '.adoc',
  commonmark: '.md',
  commonmark_x: '.md',
  docbook: '.xml',
  docx: '.docx',
  epub: '.epub',
  epub3: '.epub',
  gfm: '.md',
  html: '.html',
  html4: '.html',
  html5: '.html',
  ipynb: '.ipynb',
  latex: '.tex',
  markdown: '.md',
  markdown_strict: '.md',
  odt: '.odt',
  org: '.org',
  pdf: '.pdf',
  plain: '.txt',
  rst: '.rst',
  rtf: '.rtf',
  textile: '.textile',
};

export async function execute(rawInput: JsonValue, context: ToolContext): Promise<ConvertOutput> {
  const input = normalizeInput(rawInput);
  const to = input.to?.trim() || 'markdown';
  const sourcePath = resolve(input.sourcePath);
  const from = input.from?.trim() || inferInputFormat(sourcePath);
  const outputPath = resolve(input.outputPath ?? buildDefaultOutputPath(sourcePath, to));
  const overwrite = input.overwrite ?? true;

  await access(sourcePath, constants.R_OK);

  if (outputPath === sourcePath) {
    throw new Error('Output path must differ from the source path');
  }

  if (!overwrite) {
    await assertOutputDoesNotExist(outputPath);
  }

  await mkdir(dirname(outputPath), { recursive: true });

  const args = buildPandocArgs({
    sourcePath,
    outputPath,
    from,
    to,
    standalone: input.standalone ?? false,
  });

  const stderr = await runPandoc(args, context);

  return {
    sourcePath,
    outputPath,
    ...(from ? { from } : {}),
    to,
    command: ['pandoc', ...args],
    ...(stderr ? { stderr } : {}),
  };
}

function normalizeInput(rawInput: JsonValue): ConvertInput {
  const input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('convert_document_with_pandoc expects an object input');
  }

  const candidate = input as Record<string, unknown>;

  if (typeof candidate.sourcePath !== 'string' || candidate.sourcePath.trim().length === 0) {
    throw new Error('convert_document_with_pandoc requires a non-empty sourcePath');
  }

  return {
    sourcePath: candidate.sourcePath,
    outputPath: typeof candidate.outputPath === 'string' ? candidate.outputPath : undefined,
    from: typeof candidate.from === 'string' ? candidate.from : undefined,
    to: typeof candidate.to === 'string' ? candidate.to : undefined,
    standalone: typeof candidate.standalone === 'boolean' ? candidate.standalone : undefined,
    overwrite: typeof candidate.overwrite === 'boolean' ? candidate.overwrite : undefined,
  };
}

function inferInputFormat(sourcePath: string): string | undefined {
  return INPUT_FORMAT_BY_EXTENSION[extname(sourcePath).toLowerCase()];
}

function buildDefaultOutputPath(sourcePath: string, to: string): string {
  const sourceDir = dirname(sourcePath);
  const sourceExt = extname(sourcePath);
  const baseName = basename(sourcePath, sourceExt);
  const outputExt = extensionForOutputFormat(to);

  let candidate = join(sourceDir, `${baseName}${outputExt}`);
  if (candidate === sourcePath) {
    candidate = join(sourceDir, `${baseName}.converted${outputExt}`);
  }

  return candidate;
}

function extensionForOutputFormat(format: string): string {
  const normalized = normalizeFormatName(format);
  return OUTPUT_EXTENSION_BY_FORMAT[normalized] ?? `.${normalized}`;
}

function normalizeFormatName(format: string): string {
  return format.trim().toLowerCase().split(/[+-]/, 1)[0] || 'markdown';
}

async function assertOutputDoesNotExist(outputPath: string): Promise<void> {
  try {
    await access(outputPath, constants.F_OK);
    throw new Error(`Output file already exists: ${outputPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }

    throw error;
  }
}

function buildPandocArgs(options: {
  sourcePath: string;
  outputPath: string;
  from?: string;
  to: string;
  standalone: boolean;
}): string[] {
  const args: string[] = [];

  if (options.from) {
    args.push('--from', options.from);
  }

  args.push('--to', options.to);

  if (MARKDOWN_FORMATS.has(normalizeFormatName(options.to))) {
    args.push('--wrap=none');
  }

  if (options.standalone) {
    args.push('--standalone');
  }

  args.push('--output', options.outputPath, options.sourcePath);

  return args;
}

async function runPandoc(args: string[], context: ToolContext): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn('pandoc', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';

    const abortHandler = () => {
      child.kill('SIGTERM');
    };

    context.signal.addEventListener('abort', abortHandler, { once: true });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      context.signal.removeEventListener('abort', abortHandler);
      reject(new Error(`Failed to start pandoc: ${error.message}`));
    });

    child.on('close', (code, signal) => {
      context.signal.removeEventListener('abort', abortHandler);

      if (code === 0) {
        resolvePromise(stderr.trim());
        return;
      }

      const reason = stderr.trim() || `pandoc exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`;
      reject(new Error(reason));
    });
  });
}
