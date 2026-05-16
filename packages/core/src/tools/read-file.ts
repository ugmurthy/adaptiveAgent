import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

import type { ToolDefinition } from '../types.js';
import { buildWorkspacePathRecovery, PathOutsideRootError, resolvePathWithinRoot } from './path-utils.js';

export interface ReadFileToolConfig {
  /** Restrict reads to paths under this root. Defaults to `process.cwd()`. */
  allowedRoot?: string;
  /** Maximum file size in bytes. Defaults to 1 MiB. */
  maxSizeBytes?: number;
  /** Override pandoc-based extraction for tests or custom runtimes. */
  extractWithPandoc?: (filePath: string, inputFormat: string, signal?: AbortSignal) => Promise<string>;
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
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

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
  '.pdf': 'pdf',
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
  const extractWithPandoc = config?.extractWithPandoc ?? defaultExtractWithPandoc;

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
      const resolved = resolvePathWithinRoot(allowedRoot, filePath);

      const fileStats = await stat(resolved);
      if (fileStats.size > maxSizeBytes) {
        throw new Error(`File ${resolved} exceeds maximum size of ${maxSizeBytes} bytes`);
      }

      const contentBuffer = await readFile(resolved);
      if (contentBuffer.byteLength > maxSizeBytes) {
        throw new Error(`File ${resolved} exceeds maximum size of ${maxSizeBytes} bytes`);
      }

      const content = await readContentAsText(resolved, contentBuffer, extractWithPandoc, context?.signal);

      return {
        path: resolved,
        content,
        sizeBytes: contentBuffer.byteLength,
      } satisfies ReadFileOutput as unknown as ReturnType<ToolDefinition['execute']>;
    },
  };
}

async function readContentAsText(
  resolvedPath: string,
  contentBuffer: Buffer,
  extractWithPandoc: (filePath: string, inputFormat: string, signal?: AbortSignal) => Promise<string>,
  signal: AbortSignal | undefined,
): Promise<string> {
  const extension = extname(resolvedPath).toLowerCase();
  const pandocInputFormat = PANDOC_INPUT_FORMAT_BY_EXTENSION[extension];

  if (pandocInputFormat) {
    return extractWithPandoc(resolvedPath, pandocInputFormat, signal);
  }

  if (DIRECT_TEXT_EXTENSIONS.has(extension) || isLikelyUtf8Text(contentBuffer)) {
    return UTF8_DECODER.decode(contentBuffer);
  }

  throw new Error(`Unsupported binary file format for read_file: ${extension || resolvedPath}`);
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
