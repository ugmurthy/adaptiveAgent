import type { ToolAccounting, ToolDefinition } from '../types.js';
import { extractPdfTextWithPdfJs } from './pdf-text.js';

export type ReadWebPageProvider = 'direct' | 'parallel';

export interface ReadWebPageToolConfig {
  /** Page read provider. Defaults to `'direct'`. */
  provider?: ReadWebPageProvider;
  /** API key for API-backed page read providers. Required for Parallel. */
  apiKey?: string;
  /** Base URL override for testing. */
  baseUrl?: string;
  /** Maximum response body size in bytes. Defaults to 512 KiB. */
  maxSizeBytes?: number;
  /** Maximum extracted text length in characters. Defaults to 50000. */
  maxTextLength?: number;
  /** Tool timeout in milliseconds. Defaults to `90000`. */
  timeoutMs?: number;
  /** Override PDF extraction for tests or custom runtimes. */
  extractPdfText?: (rawBuffer: ArrayBuffer) => Promise<{ title: string; text: string }>;
  /** Estimated cost for one provider page-read request. Defaults to 0 for direct reads, otherwise unpriced. */
  estimatedCostPerRequestUSD?: number;
}

type ReadWebPageInput = {
  url: string;
  objective?: string;
  maxTextLength?: number;
};

type ReadWebPageOutput = {
  url: string;
  title: string;
  text: string;
  relevantExcerpts?: string[];
  bytesFetched: number;
  truncated?: boolean;
  textLength?: number;
  maxTextLength?: number;
  next?: {
    url: string;
    maxTextLength: number;
  };
  error?: {
    kind: 'http_error' | 'network_error' | 'content_error' | 'timeout';
    message: string;
    status?: number;
  };
};

type ReadResponseBodyResult = {
  rawBuffer: ArrayBuffer;
  truncated: boolean;
};

interface ParallelExtractResponse {
  results?: Array<{
    url?: string | null;
    title?: string | null;
    excerpts?: string[] | null;
    full_content?: string | null;
  }>;
  errors?: Array<{
    url?: string | null;
    error_type?: string | null;
    http_status_code?: number | null;
    content?: string | null;
  }>;
}

const DEFAULT_MAX_SIZE = 524_288; // 512 KiB
const DEFAULT_MAX_TEXT_LENGTH = 50_000;
const DEFAULT_WEB_TOOL_TIMEOUT_MS = 90_000;
const DEFAULT_MODEL_RESULT_MAX_BYTES = 32 * 1024;
const PARALLEL_BASE_URL = 'https://api.parallel.ai/v1';
const MAX_PARALLEL_EXTRACT_CHARS_TOTAL = 100_000;
const MAX_PARALLEL_ERROR_BODY_BYTES = 524_288;
const PARTIAL_CONTENT_USEFUL_MIN_CHARS = 500;
const PARTIAL_CONTENT_USEFUL_MIN_WORDS = 80;
const PARTIAL_CONTENT_USEFUL_MIN_ALPHA_RATIO = 0.45;
const READ_WEB_PAGE_DIAGNOSTICS = Symbol('read_web_page.diagnostics');

interface ReadWebPageDiagnostics {
  provider: ReadWebPageProvider;
  cached?: boolean;
}

class RecoverableReadWebPageError extends Error {
  constructor(readonly output: ReadWebPageOutput) {
    super(output.error?.message ?? 'Web page read failed');
    this.name = 'RecoverableReadWebPageError';
  }
}

export function createReadWebPageTool(config?: ReadWebPageToolConfig): ToolDefinition<ReadWebPageInput, ReadWebPageOutput> {
  const provider = config?.provider ?? 'direct';
  if (provider === 'parallel' && !config?.apiKey) {
    throw new Error('createReadWebPageTool requires apiKey when provider is parallel');
  }

  const maxSizeBytes = config?.maxSizeBytes ?? DEFAULT_MAX_SIZE;
  const maxTextLength = config?.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
  const timeoutMs = config?.timeoutMs ?? DEFAULT_WEB_TOOL_TIMEOUT_MS;
  const baseUrl = config?.baseUrl ?? PARALLEL_BASE_URL;
  const extractPdfText = config?.extractPdfText ?? extractPdfTextWithPdfJs;
  const estimatedCostPerRequestUSD = config?.estimatedCostPerRequestUSD;
  const cache = new Map<string, ReadWebPageOutput>();

  return {
    name: 'read_web_page',
    budgetGroup: 'web_research.read',
    timeoutMs,
    maxModelResultBytes: DEFAULT_MODEL_RESULT_MAX_BYTES,
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
        objective: {
          type: 'string',
          description: 'Specific fact or question to extract relevant excerpts for.',
        },
        maxTextLength: {
          type: 'number',
          description: 'Optional per-call maximum extracted text length.',
        },
      },
    },
    summarizeResult(output) {
      return summarizeReadWebPageOutput(output);
    },
    formatResultForModel(output, context) {
      return formatReadWebPageOutputForModel(output, context.maxBytes);
    },
    async execute(rawInput, context) {
      // Some models send tool input as a JSON string instead of an object — normalise.
      const input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
      const { url, objective, maxTextLength: perCallMaxTextLength } = input as unknown as ReadWebPageInput;
      const effectiveMaxTextLength = perCallMaxTextLength ?? maxTextLength;
      const cacheKey = `${context.runId}:${provider}:${url}:${objective ?? ''}:${effectiveMaxTextLength}`;
      const cached = cache.get(cacheKey);
      if (cached) {
        return cloneReadWebPageOutputWithCachedDiagnostics(cached);
      }

      try {
        if (provider === 'parallel') {
          const output = await extractParallelWebPage({
            apiKey: config!.apiKey!,
            url,
            objective,
            maxTextLength: effectiveMaxTextLength,
            runId: context.runId,
            baseUrl,
            signal: context.signal,
          });
          const outputWithDiagnostics = attachReadWebPageDiagnostics(output, { provider: 'parallel' });
          cache.set(cacheKey, outputWithDiagnostics);
          return outputWithDiagnostics;
        }

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

        const partialContentSupported = isPartiallyReadableContentType(contentType);
        const contentLength = parseContentLength(response.headers.get('content-length'));
        if (contentLength !== undefined && contentLength > maxSizeBytes && !partialContentSupported) {
          throw createRecoverableReadWebPageError({
            url,
            kind: 'content_error',
            message: `Response from ${url} exceeds maximum size of ${maxSizeBytes} bytes`,
          });
        }

        const body = await readResponseBodyWithinLimit(response, maxSizeBytes, url, partialContentSupported, context.signal);
        const extracted = await extractReadableText(body.rawBuffer, contentType, extractPdfText);
        const output = buildReadWebPageOutput({
          url,
          objective,
          extracted,
          bytesFetched: body.rawBuffer.byteLength,
          maxTextLength: effectiveMaxTextLength,
          bodyTruncated: body.truncated || (contentLength !== undefined && contentLength > maxSizeBytes),
          maxSizeBytes,
        });

        if (body.truncated && !isUsefulPartialText(extracted.text)) {
          throw createRecoverableReadWebPageError({
            url,
            kind: 'content_error',
            message: `Response from ${url} exceeds maximum size of ${maxSizeBytes} bytes and no useful partial text could be extracted`,
          });
        }

        const outputWithDiagnostics = attachReadWebPageDiagnostics(output, { provider: 'direct' });
        cache.set(cacheKey, outputWithDiagnostics);
        return outputWithDiagnostics;
      } catch (error) {
        throw normalizeReadWebPageError(error, url);
      }
    },
    recoverError(error, input) {
      const { url } = input;
      return attachReadWebPageDiagnostics(normalizeReadWebPageError(error, url).output, { provider });
    },
    getAccounting(output) {
      return getReadWebPageAccounting(output, provider, estimatedCostPerRequestUSD);
    },
  };
}

function attachReadWebPageDiagnostics(
  output: ReadWebPageOutput,
  diagnostics: ReadWebPageDiagnostics,
): ReadWebPageOutput {
  Object.defineProperty(output, READ_WEB_PAGE_DIAGNOSTICS, {
    value: diagnostics,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return output;
}

function cloneReadWebPageOutputWithCachedDiagnostics(output: ReadWebPageOutput): ReadWebPageOutput {
  const diagnostics = getReadWebPageDiagnostics(output);
  if (!diagnostics) {
    return output;
  }
  return attachReadWebPageDiagnostics({ ...output }, { ...diagnostics, cached: true });
}

function getReadWebPageDiagnostics(output: ReadWebPageOutput): ReadWebPageDiagnostics | undefined {
  return (output as ReadWebPageOutput & { [READ_WEB_PAGE_DIAGNOSTICS]?: ReadWebPageDiagnostics })[
    READ_WEB_PAGE_DIAGNOSTICS
  ];
}

function getReadWebPageAccounting(
  output: ReadWebPageOutput,
  configuredProvider: ReadWebPageProvider,
  estimatedCostPerRequestUSD: number | undefined,
): ToolAccounting | undefined {
  if (typeof output.url !== 'string' || !output.url) {
    return undefined;
  }

  const diagnostics = getReadWebPageDiagnostics(output);
  const provider = diagnostics?.provider ?? configuredProvider;
  const cached = diagnostics?.cached === true;
  const requests = cached ? 0 : 1;
  const defaultCost = provider === 'direct' ? 0 : undefined;
  const perRequestCost = estimatedCostPerRequestUSD ?? defaultCost;

  return {
    provider,
    operation: 'read_web_page',
    billable: provider !== 'direct',
    ...(cached ? { cached } : {}),
    units: { requests },
    ...(perRequestCost === undefined ? {} : { estimatedCostUSD: requests * perRequestCost }),
    pricingSource:
      estimatedCostPerRequestUSD === undefined
        ? provider === 'direct' ? 'default_zero' : 'unpriced'
        : 'configured',
  };
}

function summarizeReadWebPageOutput(output: ReadWebPageOutput): unknown {
  if (typeof output.text !== 'string') {
    return output;
  }

  return {
    url: output.url,
    title: output.title,
    bytesFetched: output.bytesFetched,
    textBytes: Buffer.byteLength(output.text, 'utf8'),
    textLength: output.textLength ?? output.text.length,
    truncated: output.truncated ?? false,
    relevantExcerptCount: output.relevantExcerpts?.length ?? 0,
    ...(output.error === undefined
      ? {}
      : {
          error: {
            kind: output.error.kind,
            message: output.error.message,
            ...(output.error.status === undefined ? {} : { status: output.error.status }),
          },
        }),
    ...(output.next === undefined ? {} : { next: output.next }),
  };
}

function formatReadWebPageOutputForModel(output: ReadWebPageOutput, maxBytes: number): unknown {
  if (typeof output.text !== 'string') {
    return output;
  }

  if (output.relevantExcerpts && output.relevantExcerpts.length > 0) {
    return {
      ...output,
      text: output.relevantExcerpts.join('\n\n'),
      modelView: 'relevant_excerpts',
    };
  }

  const textBytes = Buffer.byteLength(output.text, 'utf8');
  if (textBytes <= maxBytes) {
    return output;
  }

  const capped = truncateUtf8(output.text, Math.max(0, maxBytes - 512));
  return {
    ...output,
    text: capped.text,
    truncated: true,
    bytesReturned: capped.bytes,
    bytesAvailable: textBytes,
    next: output.next ?? {
      url: output.url,
      maxTextLength: Math.min(output.textLength ?? output.text.length, (output.maxTextLength ?? output.text.length) * 2),
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

function isPartiallyReadableContentType(contentType: string): boolean {
  return (
    contentType.includes('text/') ||
    contentType.includes('html') ||
    contentType.includes('xml')
  );
}

function buildReadWebPageOutput({
  url,
  objective,
  extracted,
  bytesFetched,
  maxTextLength,
  bodyTruncated,
  maxSizeBytes,
  providerRelevantExcerpts,
  providerTruncated,
}: {
  url: string;
  objective?: string;
  extracted: { title: string; text: string };
  bytesFetched: number;
  maxTextLength: number;
  bodyTruncated: boolean;
  maxSizeBytes: number;
  providerRelevantExcerpts?: string[];
  providerTruncated?: boolean;
}): ReadWebPageOutput {
  const relevantExcerpts = providerRelevantExcerpts ?? (objective ? extractRelevantExcerpts(extracted.text, objective) : undefined);
  const textTruncated = extracted.text.length > maxTextLength;
  const truncated = bodyTruncated || textTruncated || Boolean(providerTruncated);
  const text = textTruncated ? `${extracted.text.slice(0, maxTextLength)}\n[truncated]` : extracted.text;

  return {
    url,
    title: extracted.title,
    text,
    ...(relevantExcerpts === undefined ? {} : { relevantExcerpts }),
    bytesFetched,
    textLength: extracted.text.length,
    maxTextLength,
    truncated,
    ...(textTruncated || providerTruncated ? { next: { url, maxTextLength: Math.min(extracted.text.length || maxTextLength * 2, maxTextLength * 2) } } : {}),
    ...(bodyTruncated
      ? {
          error: {
            kind: 'content_error',
            message: `Response from ${url} exceeds maximum size of ${maxSizeBytes} bytes; returned partial content`,
          },
        }
      : {}),
  };
}

async function extractParallelWebPage({
  apiKey,
  url,
  objective,
  maxTextLength,
  runId,
  baseUrl,
  signal,
}: {
  apiKey: string;
  url: string;
  objective?: string;
  maxTextLength: number;
  runId: string;
  baseUrl: string;
  signal: AbortSignal;
}): Promise<ReadWebPageOutput> {
  const endpoint = new URL(`${baseUrl.replace(/\/$/, '')}/extract`);
  const providerContentCap = Math.min(Math.max(maxTextLength * 2, maxTextLength), MAX_PARALLEL_EXTRACT_CHARS_TOTAL);
  const response = await fetch(endpoint.toString(), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      urls: [url],
      ...(objective === undefined ? {} : { objective }),
      max_chars_total: MAX_PARALLEL_EXTRACT_CHARS_TOTAL,
      session_id: runId,
      advanced_settings: {
        excerpt_settings: {
          max_chars_per_result: Math.min(maxTextLength, MAX_PARALLEL_EXTRACT_CHARS_TOTAL),
        },
        full_content: {
          max_chars_per_result: providerContentCap,
        },
      },
    }),
    signal,
  });

  if (!response.ok) {
    throw createRecoverableReadWebPageError({
      url,
      kind: 'http_error',
      message: `Parallel Extract API returned ${response.status}: ${await readResponseTextWithinLimit(response, MAX_PARALLEL_ERROR_BODY_BYTES, signal).catch(() => 'unknown error')}`,
      status: response.status,
    });
  }

  const data = (await response.json()) as ParallelExtractResponse;
  const result = (data.results ?? []).find((candidate) => candidate.url === url) ?? data.results?.[0];
  if (!result) {
    const providerError = (data.errors ?? []).find((candidate) => candidate.url === url) ?? data.errors?.[0];
    if (providerError) {
      throw createRecoverableReadWebPageError({
        url,
        kind: providerError.http_status_code === null || providerError.http_status_code === undefined ? 'content_error' : 'http_error',
        message: providerError.content || providerError.error_type || `Parallel Extract API could not extract ${url}`,
        ...(providerError.http_status_code === null || providerError.http_status_code === undefined ? {} : { status: providerError.http_status_code }),
      });
    }

    throw createRecoverableReadWebPageError({
      url,
      kind: 'content_error',
      message: `Parallel Extract API returned no result for ${url}`,
    });
  }

  const providerText = result.full_content?.trim() || (result.excerpts ?? []).join('\n\n').trim();
  const providerExcerpts = (result.excerpts ?? []).map((excerpt) => excerpt.trim()).filter(Boolean);
  const providerTruncated = Boolean(result.full_content && result.full_content.length >= providerContentCap);
  return buildReadWebPageOutput({
    url: result.url?.trim() || url,
    objective,
    extracted: {
      title: result.title?.trim() ?? '',
      text: providerText,
    },
    bytesFetched: Buffer.byteLength(providerText, 'utf8'),
    maxTextLength,
    bodyTruncated: false,
    maxSizeBytes: MAX_PARALLEL_EXTRACT_CHARS_TOTAL,
    ...(objective && providerExcerpts.length > 0 ? { providerRelevantExcerpts: providerExcerpts } : {}),
    providerTruncated,
  });
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

async function readResponseTextWithinLimit(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error(`Response body exceeds maximum size of ${maxBytes} bytes`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;

  while (true) {
    signal.throwIfAborted();
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error(`Response body exceeds maximum size of ${maxBytes} bytes`);
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join('');
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

async function readResponseBodyWithinLimit(
  response: Response,
  maxSizeBytes: number,
  url: string,
  allowPartial: boolean,
  signal?: AbortSignal,
): Promise<ReadResponseBodyResult> {
  signal?.throwIfAborted();
  if (!response.body) {
    const rawBuffer = await response.arrayBuffer();
    if (rawBuffer.byteLength > maxSizeBytes) {
      if (!allowPartial) {
        throw createRecoverableReadWebPageError({
          url,
          kind: 'content_error',
          message: `Response from ${url} exceeds maximum size of ${maxSizeBytes} bytes`,
        });
      }

      return { rawBuffer: rawBuffer.slice(0, maxSizeBytes), truncated: true };
    }

    return { rawBuffer, truncated: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let truncated = false;

  while (true) {
    signal?.throwIfAborted();
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    if (!value) {
      continue;
    }

    const nextTotalBytes = totalBytes + value.byteLength;
    if (nextTotalBytes > maxSizeBytes) {
      await reader.cancel();
      if (!allowPartial) {
        throw createRecoverableReadWebPageError({
          url,
          kind: 'content_error',
          message: `Response from ${url} exceeds maximum size of ${maxSizeBytes} bytes`,
        });
      }

      const remainingBytes = maxSizeBytes - totalBytes;
      if (remainingBytes > 0) {
        chunks.push(value.subarray(0, remainingBytes));
        totalBytes += remainingBytes;
      }

      truncated = true;
      break;
    }

    totalBytes = nextTotalBytes;
    chunks.push(value);
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { rawBuffer: merged.buffer, truncated };
}

function isUsefulPartialText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < PARTIAL_CONTENT_USEFUL_MIN_CHARS) {
    return false;
  }

  const words = trimmed.match(/[A-Za-z0-9]+/g) ?? [];
  if (words.length < PARTIAL_CONTENT_USEFUL_MIN_WORDS) {
    return false;
  }

  const alphaChars = trimmed.match(/[A-Za-z]/g)?.length ?? 0;
  return alphaChars / trimmed.length >= PARTIAL_CONTENT_USEFUL_MIN_ALPHA_RATIO;
}

function truncateUtf8(text: string, maxBytes: number): { text: string; bytes: number } {
  const source = Buffer.from(text, 'utf8');
  if (source.byteLength <= maxBytes) {
    return { text, bytes: source.byteLength };
  }

  let end = Math.max(0, maxBytes);
  while (end > 0 && (source[end] & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }

  return {
    text: source.subarray(0, end).toString('utf8'),
    bytes: end,
  };
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

function extractRelevantExcerpts(text: string, objective: string): string[] {
  const terms = tokenizeObjective(objective);
  if (terms.length === 0) {
    return [];
  }

  return text
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph, index) => ({ paragraph, index, score: scoreExcerpt(paragraph, terms) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 5)
    .map((candidate) => candidate.paragraph.length > 1_000 ? `${candidate.paragraph.slice(0, 1_000)}[truncated]` : candidate.paragraph);
}

function tokenizeObjective(objective: string): string[] {
  const stopWords = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'when', 'where', 'which', 'who', 'how', 'was', 'were', 'are', 'is', 'in', 'on', 'of', 'to', 'a', 'an']);
  return Array.from(new Set(objective.toLowerCase().match(/[a-z0-9]+/g) ?? []))
    .filter((term) => term.length > 2 && !stopWords.has(term));
}

function scoreExcerpt(paragraph: string, terms: string[]): number {
  const lower = paragraph.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (lower.includes(term)) {
      score += term.length > 5 ? 2 : 1;
    }
  }
  return score;
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
