import type { ToolDefinition } from '../types.js';

export interface ReadWebPageToolConfig {
  /** Maximum response body size in bytes. Defaults to 512 KiB. */
  maxSizeBytes?: number;
  /** Maximum extracted text length in characters. Defaults to 50000. */
  maxTextLength?: number;
  /** Tool timeout in milliseconds. Defaults to `90000`. */
  timeoutMs?: number;
  /** Override PDF extraction for tests or custom runtimes. */
  extractPdfText?: (rawBuffer: ArrayBuffer) => Promise<{ title: string; text: string }>;
}

type ReadWebPageInput = {
  url: string;
};

type ReadWebPageOutput = {
  url: string;
  title: string;
  text: string;
  bytesFetched: number;
  error?: {
    kind: 'http_error' | 'network_error' | 'content_error' | 'timeout';
    message: string;
    status?: number;
  };
};

const DEFAULT_MAX_SIZE = 524_288; // 512 KiB
const DEFAULT_MAX_TEXT_LENGTH = 50_000;
const DEFAULT_WEB_TOOL_TIMEOUT_MS = 90_000;

class RecoverableReadWebPageError extends Error {
  constructor(readonly output: ReadWebPageOutput) {
    super(output.error?.message ?? 'Web page read failed');
    this.name = 'RecoverableReadWebPageError';
  }
}

export function createReadWebPageTool(config?: ReadWebPageToolConfig): ToolDefinition<ReadWebPageInput, ReadWebPageOutput> {
  const maxSizeBytes = config?.maxSizeBytes ?? DEFAULT_MAX_SIZE;
  const maxTextLength = config?.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
  const timeoutMs = config?.timeoutMs ?? DEFAULT_WEB_TOOL_TIMEOUT_MS;
  const extractPdfText = config?.extractPdfText ?? extractPdfTextWithPdfJs;

  return {
    name: 'read_web_page',
    budgetGroup: 'web_research.read',
    timeoutMs,
    description:
      'Fetch a web page and extract its text content. Returns the URL, page title, and extracted text.',
    retryPolicy: {
      retryable: true,
      retryOn: ['timeout', 'network', 'rate_limit', 'provider_error'],
    },
    inputSchema: {
      type: 'object',
      required: ['url'],
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'The URL of the web page to read.' },
      },
    },
    async execute(rawInput, context) {
      // Some models send tool input as a JSON string instead of an object — normalise.
      const input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
      const { url } = input as unknown as ReadWebPageInput;

      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'AdaptiveAgent/1.0 (compatible; bot)',
            Accept: 'text/html,application/xhtml+xml,text/plain,application/pdf',
          },
          signal: context.signal,
        });

        if (!response.ok) {
          throw createRecoverableReadWebPageError({
            url,
            kind: 'http_error',
            message: `HTTP ${response.status} fetching ${url}`,
            status: response.status,
          });
        }

        const contentType = response.headers.get('content-type') ?? '';
        if (!isSupportedContentType(contentType)) {
          throw createRecoverableReadWebPageError({
            url,
            kind: 'content_error',
            message: `Unsupported content type ${contentType} for ${url}`,
          });
        }

        const contentLength = parseContentLength(response.headers.get('content-length'));
        if (contentLength !== undefined && contentLength > maxSizeBytes) {
          throw createRecoverableReadWebPageError({
            url,
            kind: 'content_error',
            message: `Response from ${url} exceeds maximum size of ${maxSizeBytes} bytes`,
          });
        }

        const rawBuffer = await readResponseBodyWithinLimit(response, maxSizeBytes, url);
        const { title, text } = await extractReadableText(rawBuffer, contentType, extractPdfText);
        let normalizedText = text;

        if (normalizedText.length > maxTextLength) {
          normalizedText = normalizedText.slice(0, maxTextLength) + '\n[truncated]';
        }

        return {
          url,
          title,
          text: normalizedText,
          bytesFetched: rawBuffer.byteLength,
        } satisfies ReadWebPageOutput;
      } catch (error) {
        throw normalizeReadWebPageError(error, url);
      }
    },
    recoverError(error, input) {
      const { url } = input;
      return normalizeReadWebPageError(error, url).output;
    },
  };
}

function isSupportedContentType(contentType: string): boolean {
  return (
    contentType.includes('text/') ||
    contentType.includes('html') ||
    contentType.includes('xml') ||
    contentType.includes('application/pdf')
  );
}

async function extractReadableText(
  rawBuffer: ArrayBuffer,
  contentType: string,
  extractPdfText: (rawBuffer: ArrayBuffer) => Promise<{ title: string; text: string }>,
): Promise<{ title: string; text: string }> {
  if (contentType.includes('application/pdf')) {
    return extractPdfText(rawBuffer);
  }

  const html = new TextDecoder().decode(rawBuffer);
  return {
    title: extractTitle(html),
    text: stripHtmlToText(html),
  };
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

async function readResponseBodyWithinLimit(response: Response, maxSizeBytes: number, url: string): Promise<ArrayBuffer> {
  if (!response.body) {
    const rawBuffer = await response.arrayBuffer();
    if (rawBuffer.byteLength > maxSizeBytes) {
      throw createRecoverableReadWebPageError({
        url,
        kind: 'content_error',
        message: `Response from ${url} exceeds maximum size of ${maxSizeBytes} bytes`,
      });
    }

    return rawBuffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    if (!value) {
      continue;
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxSizeBytes) {
      await reader.cancel();
      throw createRecoverableReadWebPageError({
        url,
        kind: 'content_error',
        message: `Response from ${url} exceeds maximum size of ${maxSizeBytes} bytes`,
      });
    }

    chunks.push(value);
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return merged.buffer;
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtmlEntities(match[1].trim()) : '';
}

function stripHtmlToText(html: string): string {
  let text = html;

  // Remove script and style blocks
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');

  // Replace block-level tags with newlines
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|br|blockquote|section|article|header|footer|nav)[\s>]/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  text = decodeHtmlEntities(text);

  // Collapse whitespace
  text = text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');

  return text.trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

async function extractPdfTextWithPdfJs(rawBuffer: ArrayBuffer): Promise<{ title: string; text: string }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({
    data: new Uint8Array(rawBuffer),
    useWorkerFetch: false,
    isEvalSupported: false,
  }).promise;

  try {
    const metadata = await document.getMetadata().catch(() => null);
    const title = normalizePdfTitle(metadata?.info?.Title);
    const pageTexts: string[] = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (lines) {
        pageTexts.push(lines);
      }
    }

    return {
      title,
      text: pageTexts.join('\n\n').trim(),
    };
  } finally {
    await document.destroy();
  }
}

function normalizePdfTitle(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeReadWebPageError(error: unknown, url: string): RecoverableReadWebPageError {
  if (error instanceof RecoverableReadWebPageError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return createRecoverableReadWebPageError({
    url,
    kind: isTimeoutError(error) ? 'timeout' : 'network_error',
    message,
  });
}

function createRecoverableReadWebPageError({
  url,
  kind,
  message,
  status,
}: {
  url: string;
  kind: 'http_error' | 'network_error' | 'content_error' | 'timeout';
  message: string;
  status?: number;
}): RecoverableReadWebPageError {
  return new RecoverableReadWebPageError({
    url,
    title: '',
    text: '',
    bytesFetched: 0,
    error: {
      kind,
      message,
      status,
    },
  });
}

function isTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^Timed out after \d+ms$/.test(message);
}
