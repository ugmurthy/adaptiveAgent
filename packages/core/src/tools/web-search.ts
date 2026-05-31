import type { JsonValue, ToolDefinition } from '../types.js';

export interface WebSearchToolConfig {
  /** Search provider. Defaults to `'brave'`. */
  provider?: 'brave' | 'duckduckgo';
  /** API key for Brave Search. Required when `provider` is `'brave'`. */
  apiKey?: string;
  /** Maximum results to return. Defaults to `5`. */
  maxResults?: number;
  /** Base URL override for testing. */
  baseUrl?: string;
  /** Tool timeout in milliseconds. Defaults to `90000`. */
  timeoutMs?: number;
  /** Maximum provider HTML/error body size in bytes. Defaults to 512 KiB. */
  maxResponseBodyBytes?: number;
}

type WebSearchInput = {
  query: string;
  maxResults?: number;
  purpose?: string;
  expectedUse?: 'verify' | 'discover' | 'compare' | 'current_status';
  freshnessRequired?: boolean;
  domainHints?: string[];
  excludeDomains?: string[];
  exactPhrases?: string[];
  answerType?: 'date' | 'number' | 'name' | 'place' | 'organization' | 'file' | 'other';
};

type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

type WebSearchOutput = {
  query: string;
  results: WebSearchResult[];
  purpose?: string;
  expectedUse?: 'verify' | 'discover' | 'compare' | 'current_status';
  freshnessRequired?: boolean;
  domainHints?: string[];
  excludeDomains?: string[];
  exactPhrases?: string[];
  answerType?: 'date' | 'number' | 'name' | 'place' | 'organization' | 'file' | 'other';
  researchStatus?: {
    status: 'complete' | 'partial';
    reason?: 'budget_exhausted' | 'timeout' | 'provider_error';
    unresolvedQuestions?: string[];
  };
  error?: {
    kind: 'http_error' | 'network_error' | 'challenge' | 'timeout';
    message: string;
    status?: number;
    provider: 'brave' | 'duckduckgo';
  };
};

interface WebSearchDiagnostics {
  provider: 'brave' | 'duckduckgo';
  providerPath: 'api' | 'deep' | 'html-fallback';
  deduplicatedResults?: number;
}

interface WebSearchExecutionResult {
  results: WebSearchResult[];
  diagnostics: WebSearchDiagnostics;
}

interface BraveSearchResponse {
  web?: {
    results?: Array<{
      title: string;
      url: string;
      description: string;
    }>;
  };
}

interface DuckDuckGoDeepResult {
  a?: string;
  t?: string;
  u?: string;
}

const BRAVE_BASE_URL = 'https://api.search.brave.com/res/v1';
const DUCKDUCKGO_BASE_URL = 'https://duckduckgo.com/';
const DUCKDUCKGO_HTML_BASE_URL = 'https://html.duckduckgo.com/html/';
const DUCKDUCKGO_ORIGIN = 'https://duckduckgo.com';
const DUCKDUCKGO_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const DUCKDUCKGO_HEADERS = {
  Accept: 'text/html,application/xhtml+xml',
  'Sec-CH-UA': '"Not=A?Brand";v="8", "Chromium";v="129"',
  'Sec-CH-UA-Mobile': '?0',
  'Sec-CH-UA-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'User-Agent': DUCKDUCKGO_USER_AGENT,
};
const WEB_SEARCH_DIAGNOSTICS = Symbol('web_search.diagnostics');
const DEFAULT_WEB_TOOL_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_RESPONSE_BODY_BYTES = 524_288;
const DEFAULT_MODEL_RESULT_MAX_BYTES = 32 * 1024;

class RecoverableWebSearchError extends Error {
  constructor(readonly output: WebSearchOutput) {
    super(output.error?.message ?? 'Web search failed');
    this.name = 'RecoverableWebSearchError';
  }
}

export function createWebSearchTool(config: WebSearchToolConfig): ToolDefinition<WebSearchInput, WebSearchOutput> {
  const provider = config.provider ?? 'brave';
  if (provider === 'brave' && !config.apiKey) {
    throw new Error('createWebSearchTool requires apiKey when provider is brave');
  }

  const maxResults = config.maxResults ?? 5;
  const baseUrl = config.baseUrl ?? (provider === 'brave' ? BRAVE_BASE_URL : DUCKDUCKGO_BASE_URL);
  const timeoutMs = config.timeoutMs ?? DEFAULT_WEB_TOOL_TIMEOUT_MS;
  const maxResponseBodyBytes = config.maxResponseBodyBytes ?? DEFAULT_MAX_RESPONSE_BODY_BYTES;
  const cache = new Map<string, WebSearchOutput>();

  return {
    name: 'web_search',
    budgetGroup: 'web_research.search',
    timeoutMs,
    maxModelResultBytes: DEFAULT_MODEL_RESULT_MAX_BYTES,
    description:
      'Search the web for current or unknown information. Include a short purpose when possible so the search stays goal-directed. Returns results with title, URL, and snippet.',
    retryPolicy: {
      retryable: true,
      retryOn: ['timeout', 'network', 'rate_limit', 'provider_error'],
    },
    inputSchema: {
      type: 'object',
      required: ['query'],
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'The search query.' },
        maxResults: {
          type: 'number',
          description: 'Maximum number of results to return.',
        },
        purpose: {
          type: 'string',
          description: 'Why this search is needed for the current goal.',
        },
        expectedUse: {
          type: 'string',
          enum: ['verify', 'discover', 'compare', 'current_status'],
          description: 'How the result will be used.',
        },
        freshnessRequired: {
          type: 'boolean',
          description: 'Whether the answer depends on current information.',
        },
        domainHints: {
          type: 'array',
          items: { type: 'string' },
          description: 'Preferred domains to search, expressed as hostnames for site: filters.',
        },
        excludeDomains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Domains to exclude from the search results.',
        },
        exactPhrases: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact phrases to quote in the search query.',
        },
        answerType: {
          type: 'string',
          enum: ['date', 'number', 'name', 'place', 'organization', 'file', 'other'],
          description: 'Expected answer type for downstream evidence review.',
        },
      },
    },
    async execute(rawInput, context) {
      // Some models send tool input as a JSON string instead of an object — normalise.
      const input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
      const {
        query,
        maxResults: perCallMax,
        purpose,
        expectedUse,
        freshnessRequired,
        domainHints,
        excludeDomains,
        exactPhrases,
        answerType,
      } = input as unknown as WebSearchInput;
      const count = perCallMax ?? maxResults;
      const effectiveQuery = buildEffectiveSearchQuery(query, { domainHints, excludeDomains, exactPhrases });
      const cacheKey = JSON.stringify({
        runId: context.runId,
        provider,
        effectiveQuery,
        count,
        purpose,
        expectedUse,
        freshnessRequired,
        domainHints,
        excludeDomains,
        exactPhrases,
        answerType,
      });
      const cached = cache.get(cacheKey);
      if (cached) {
        return cached;
      }

      try {
        const execution =
          provider === 'brave'
            ? await searchBrave({
                apiKey: config.apiKey!,
                query: effectiveQuery,
                count,
                baseUrl,
                maxResponseBodyBytes,
                signal: context.signal,
              })
            : await searchDuckDuckGo({
                query: effectiveQuery,
                count,
                baseUrl,
                maxResponseBodyBytes,
                signal: context.signal,
              });
        const deduplicatedResults = deduplicateSearchResults(execution.results, count);

        const output = attachWebSearchDiagnostics(
          {
            query,
            results: deduplicatedResults.results,
            ...(purpose === undefined ? {} : { purpose }),
            ...(expectedUse === undefined ? {} : { expectedUse }),
            ...(freshnessRequired === undefined ? {} : { freshnessRequired }),
            ...(domainHints === undefined ? {} : { domainHints }),
            ...(excludeDomains === undefined ? {} : { excludeDomains }),
            ...(exactPhrases === undefined ? {} : { exactPhrases }),
            ...(answerType === undefined ? {} : { answerType }),
            researchStatus: {
              status: 'complete',
            },
          },
          { ...execution.diagnostics, deduplicatedResults: deduplicatedResults.removed },
        );

        cache.set(cacheKey, output);
        return output;
      } catch (error) {
        throw normalizeWebSearchError(error, query, provider);
      }
    },
    recoverError(error, input) {
      const { query } = input;
      const recovered = normalizeWebSearchError(error, query, provider).output;
      recovered.purpose = input.purpose;
      recovered.expectedUse = input.expectedUse;
      recovered.freshnessRequired = input.freshnessRequired;
      recovered.domainHints = input.domainHints;
      recovered.excludeDomains = input.excludeDomains;
      recovered.exactPhrases = input.exactPhrases;
      recovered.answerType = input.answerType;
      recovered.researchStatus = {
        status: 'partial',
        reason: recovered.error?.kind === 'timeout' ? 'timeout' : 'provider_error',
        unresolvedQuestions: [],
      };
      return recovered;
    },
    summarizeResult(output) {
      return summarizeWebSearchOutput(output);
    },
    formatResultForModel(output) {
      return formatWebSearchOutputForModel(output);
    },
  };
}

function buildEffectiveSearchQuery(
  query: string,
  hints: Pick<WebSearchInput, 'domainHints' | 'excludeDomains' | 'exactPhrases'>,
): string {
  const terms = [query.trim()];
  for (const phrase of hints.exactPhrases ?? []) {
    const trimmed = phrase.trim();
    if (trimmed) {
      terms.push(`"${trimmed.replace(/"/g, '')}"`);
    }
  }
  for (const domain of hints.domainHints ?? []) {
    const normalized = normalizeDomainHint(domain);
    if (normalized) {
      terms.push(`site:${normalized}`);
    }
  }
  for (const domain of hints.excludeDomains ?? []) {
    const normalized = normalizeDomainHint(domain);
    if (normalized) {
      terms.push(`-site:${normalized}`);
    }
  }
  return terms.filter(Boolean).join(' ');
}

function normalizeDomainHint(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const url = trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return trimmed.toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9.-]/g, '') || undefined;
  }
}

function deduplicateSearchResults(
  results: WebSearchResult[],
  count: number,
): { results: WebSearchResult[]; removed: number } {
  const seen = new Set<string>();
  const deduplicated: WebSearchResult[] = [];
  for (const result of results) {
    const key = canonicalSearchResultKey(result.url) ?? `${result.title}\n${result.snippet}`.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduplicated.push({ ...result, url: normalizeResultUrl(result.url) ?? result.url });
    if (deduplicated.length >= count) {
      break;
    }
  }
  return { results: deduplicated, removed: results.length - deduplicated.length };
}

function canonicalSearchResultKey(rawUrl: string): string | undefined {
  const normalized = normalizeResultUrl(rawUrl);
  if (!normalized) {
    return undefined;
  }
  try {
    const url = new URL(normalized);
    url.hash = '';
    return `${url.hostname}${url.pathname}${url.search}`.toLowerCase().replace(/\/$/, '');
  } catch {
    return normalized.toLowerCase();
  }
}

function normalizeResultUrl(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    url.hostname = url.hostname.toLowerCase();
    url.hash = '';
    for (const param of Array.from(url.searchParams.keys())) {
      if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(param)) {
        url.searchParams.delete(param);
      }
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

async function searchBrave({
  apiKey,
  query,
  count,
  baseUrl,
  maxResponseBodyBytes,
  signal,
}: {
  apiKey: string;
  query: string;
  count: number;
  baseUrl: string;
  maxResponseBodyBytes: number;
  signal: AbortSignal;
}): Promise<WebSearchExecutionResult> {
  const url = new URL(`${baseUrl}/web/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(count));

  const response = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
    signal,
  });

  if (!response.ok) {
    const errorText = await readResponseTextWithinLimit(response, maxResponseBodyBytes, signal).catch(() => 'unknown error');
    throw createRecoverableWebSearchError({
      query,
      provider: 'brave',
      kind: 'http_error',
      message: `Brave Search API returned ${response.status}: ${errorText}`,
      status: response.status,
    });
  }

  const data = (await response.json()) as BraveSearchResponse;
  return {
    results: (data.web?.results ?? []).slice(0, count).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
    })),
    diagnostics: {
      provider: 'brave',
      providerPath: 'api',
    },
  };
}

async function searchDuckDuckGo({
  query,
  count,
  baseUrl,
  maxResponseBodyBytes,
  signal,
}: {
  query: string;
  count: number;
  baseUrl: string;
  maxResponseBodyBytes: number;
  signal: AbortSignal;
}): Promise<WebSearchExecutionResult> {
  const searchPageUrl = new URL(baseUrl);
  searchPageUrl.searchParams.set('q', query);
  searchPageUrl.searchParams.set('ia', 'web');

  const searchPageResponse = await fetch(searchPageUrl.toString(), {
    headers: DUCKDUCKGO_HEADERS,
    signal,
  });
  const searchPageHtml = await readResponseTextWithinLimit(searchPageResponse, maxResponseBodyBytes, signal);

  if (isDuckDuckGoChallengeResponse(searchPageHtml)) {
    throw createRecoverableWebSearchError({
      query,
      provider: 'duckduckgo',
      kind: 'challenge',
      message: `DuckDuckGo search returned ${searchPageResponse.status}: anomaly challenge page`,
      status: searchPageResponse.status,
    });
  }

  if (searchPageResponse.status !== 200) {
    throw createRecoverableWebSearchError({
      query,
      provider: 'duckduckgo',
      kind: 'http_error',
      message: `DuckDuckGo search returned ${searchPageResponse.status}`,
      status: searchPageResponse.status,
    });
  }

  let deferredError: RecoverableWebSearchError | null = null;
  const deepSearchUrl = extractDuckDuckGoDeepSearchUrl(searchPageHtml);
  if (deepSearchUrl) {
    const deepResponse = await fetch(new URL(deepSearchUrl, DUCKDUCKGO_ORIGIN).toString(), {
      headers: {
        ...DUCKDUCKGO_HEADERS,
        Referer: searchPageUrl.toString(),
      },
      signal,
    });
    const deepResponseText = await readResponseTextWithinLimit(deepResponse, maxResponseBodyBytes, signal);

    if (isDuckDuckGoChallengeResponse(deepResponseText)) {
      deferredError = createRecoverableWebSearchError({
        query,
        provider: 'duckduckgo',
        kind: 'challenge',
        message: `DuckDuckGo search returned ${deepResponse.status}: anomaly challenge page`,
        status: deepResponse.status,
      });
    } else if (deepResponse.status === 200) {
      const deepResults = extractDuckDuckGoDeepResults(deepResponseText, count);
      if (deepResults.length > 0) {
        return {
          results: deepResults,
          diagnostics: {
            provider: 'duckduckgo',
            providerPath: 'deep',
          },
        };
      }
    } else {
      deferredError = createRecoverableWebSearchError({
        query,
        provider: 'duckduckgo',
        kind: 'http_error',
        message: `DuckDuckGo search returned ${deepResponse.status}`,
        status: deepResponse.status,
      });
    }
  }

  const fallbackHtmlUrl = createDuckDuckGoHtmlUrl(baseUrl);
  fallbackHtmlUrl.searchParams.set('q', query);

  const fallbackResponse = await fetch(fallbackHtmlUrl.toString(), {
    headers: {
      ...DUCKDUCKGO_HEADERS,
      Referer: searchPageUrl.toString(),
    },
    signal,
  });
  const fallbackHtml = await readResponseTextWithinLimit(fallbackResponse, maxResponseBodyBytes, signal);

  if (isDuckDuckGoChallengeResponse(fallbackHtml)) {
    throw (
      deferredError ??
      createRecoverableWebSearchError({
        query,
        provider: 'duckduckgo',
        kind: 'challenge',
        message: `DuckDuckGo search returned ${fallbackResponse.status}: anomaly challenge page`,
        status: fallbackResponse.status,
      })
    );
  }

  if (fallbackResponse.status !== 200) {
    throw (
      deferredError ??
      createRecoverableWebSearchError({
        query,
        provider: 'duckduckgo',
        kind: 'http_error',
        message: `DuckDuckGo search returned ${fallbackResponse.status}`,
        status: fallbackResponse.status,
      })
    );
  }

  const fallbackResults = extractDuckDuckGoResults(fallbackHtml, count);
  if (fallbackResults.length > 0) {
    return {
      results: fallbackResults,
      diagnostics: {
        provider: 'duckduckgo',
        providerPath: 'html-fallback',
      },
    };
  }

  if (deferredError) {
    throw deferredError;
  }

  return {
    results: [],
    diagnostics: {
      provider: 'duckduckgo',
      providerPath: 'html-fallback',
    },
  };
}

function attachWebSearchDiagnostics(output: WebSearchOutput, diagnostics: WebSearchDiagnostics): WebSearchOutput {
  Object.defineProperty(output, WEB_SEARCH_DIAGNOSTICS, {
    value: diagnostics,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return output;
}

function summarizeWebSearchOutput(output: WebSearchOutput): JsonValue {
  if (!Array.isArray(output.results)) {
    return output as unknown as JsonValue;
  }

  if (output.error) {
    return {
      query: output.query,
      resultCount: output.results.length,
      provider: output.error.provider,
      error: {
        kind: output.error.kind,
        message: output.error.message,
        ...(output.error.status === undefined ? {} : { status: output.error.status }),
      },
    };
  }

  const diagnostics = getWebSearchDiagnostics(output);

  return {
    query: output.query,
    resultCount: output.results.length,
    provider: diagnostics?.provider ?? 'unknown',
    providerPath: diagnostics?.providerPath ?? 'unknown',
    deduplicatedResults: diagnostics?.deduplicatedResults ?? 0,
    topResults: output.results.slice(0, 3).map((result) => ({
      title: result.title,
      url: result.url,
    })),
  };
}

function formatWebSearchOutputForModel(output: WebSearchOutput): JsonValue {
  if (!Array.isArray(output.results)) {
    return output as unknown as JsonValue;
  }

  if (output.error) {
    return summarizeWebSearchOutput(output);
  }

  return {
    query: output.query,
    results: output.results.map((result) => ({
      title: result.title,
      url: result.url,
      snippet: result.snippet,
    })),
    ...(output.purpose === undefined ? {} : { purpose: output.purpose }),
    ...(output.expectedUse === undefined ? {} : { expectedUse: output.expectedUse }),
    ...(output.freshnessRequired === undefined ? {} : { freshnessRequired: output.freshnessRequired }),
    ...(output.researchStatus === undefined ? {} : { researchStatus: output.researchStatus }),
  };
}

function getWebSearchDiagnostics(output: WebSearchOutput): WebSearchDiagnostics | undefined {
  return (output as WebSearchOutput & { [WEB_SEARCH_DIAGNOSTICS]?: WebSearchDiagnostics })[
    WEB_SEARCH_DIAGNOSTICS
  ];
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

function normalizeWebSearchError(
  error: unknown,
  query: string,
  provider: 'brave' | 'duckduckgo',
): RecoverableWebSearchError {
  if (error instanceof RecoverableWebSearchError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return createRecoverableWebSearchError({
    query,
    provider,
    kind: isTimeoutError(error) ? 'timeout' : 'network_error',
    message,
  });
}

function createRecoverableWebSearchError({
  query,
  provider,
  kind,
  message,
  status,
}: {
  query: string;
  provider: 'brave' | 'duckduckgo';
  kind: 'http_error' | 'network_error' | 'challenge' | 'timeout';
  message: string;
  status?: number;
}): RecoverableWebSearchError {
  return new RecoverableWebSearchError({
    query,
    results: [],
    error: {
      kind,
      message,
      status,
      provider,
    },
  });
}

function isTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^Timed out after \d+ms$/.test(message);
}

function extractDuckDuckGoResults(html: string, count: number): WebSearchResult[] {
  const liteResults = extractDuckDuckGoLiteResults(html, count);
  if (liteResults.length > 0) {
    return liteResults;
  }

  return extractDuckDuckGoHtmlResults(html, count);
}

function extractDuckDuckGoLiteResults(html: string, count: number): WebSearchResult[] {
  const matches = extractAnchorsByClass(html, 'result-link');
  const results: WebSearchResult[] = [];

  for (const [index, match] of matches.entries()) {
    const nextIndex = matches[index + 1]?.index ?? html.length;
    const section = html.slice(match.index + match.length, nextIndex);
    const title = cleanHtmlFragment(match.innerHtml);
    const url = unwrapDuckDuckGoResultUrl(match.href);
    if (!title || !url) {
      continue;
    }

    const snippetMatch = section.match(/<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i);

    results.push({
      title,
      url,
      snippet: cleanHtmlFragment(snippetMatch?.[1] ?? ''),
    });

    if (results.length >= count) {
      break;
    }
  }

  return results;
}

function extractDuckDuckGoHtmlResults(html: string, count: number): WebSearchResult[] {
  const matches = extractAnchorsByClass(html, 'result__a');
  const results: WebSearchResult[] = [];

  for (const [index, match] of matches.entries()) {
    const nextIndex = matches[index + 1]?.index ?? html.length;
    const section = html.slice(match.index + match.length, nextIndex);
    const title = cleanHtmlFragment(match.innerHtml);
    const url = unwrapDuckDuckGoResultUrl(match.href);
    if (!title || !url) {
      continue;
    }

    const snippetMatch =
      section.match(/<a[^>]*class=['"]result__snippet['"][^>]*>([\s\S]*?)<\/a>/i) ??
      section.match(/<div[^>]*class=['"]result__snippet['"][^>]*>([\s\S]*?)<\/div>/i);

    results.push({
      title,
      url,
      snippet: cleanHtmlFragment(snippetMatch?.[1] ?? ''),
    });

    if (results.length >= count) {
      break;
    }
  }

  return results;
}

function extractDuckDuckGoDeepSearchUrl(html: string): string | null {
  return html.match(/DDG\.deep\.initialize\('([^']+)'/)?.[1] ?? null;
}

function extractDuckDuckGoDeepResults(script: string, count: number): WebSearchResult[] {
  const payload = extractJsonArrayAfterMarker(script, "DDG.pageLayout.load('d',");
  if (!payload) {
    return [];
  }

  try {
    const results = JSON.parse(payload) as DuckDuckGoDeepResult[];
    return results
      .flatMap((result) => {
        const title = cleanHtmlFragment(result.t ?? '');
        const url = result.u?.trim();
        if (!title || !url) {
          return [];
        }

        return [
          {
            title,
            url,
            snippet: cleanHtmlFragment(result.a ?? ''),
          },
        ];
      })
      .slice(0, count);
  } catch {
    return [];
  }
}

function extractJsonArrayAfterMarker(text: string, marker: string): string | null {
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  const startIndex = text.indexOf('[', markerIndex + marker.length);
  if (startIndex === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (char === '\\') {
        isEscaped = true;
      } else if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '[') {
      depth += 1;
      continue;
    }

    if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function createDuckDuckGoHtmlUrl(baseUrl: string): URL {
  const parsedBaseUrl = new URL(baseUrl);
  if (parsedBaseUrl.hostname === 'duckduckgo.com') {
    return new URL(DUCKDUCKGO_HTML_BASE_URL);
  }

  return new URL('/html/', parsedBaseUrl);
}

function isDuckDuckGoChallengeResponse(body: string): boolean {
  return /anomaly\.js|anomalyDetectionBlock/i.test(body);
}

function extractAnchorsByClass(
  html: string,
  className: string,
): Array<{ href: string; innerHtml: string; index: number; length: number }> {
  const matches = html.matchAll(
    new RegExp(
      `<a\\b([^>]*\\bclass=['"][^'"]*\\b${escapeRegExp(className)}\\b[^'"]*['"][^>]*)>([\\s\\S]*?)<\\/a>`,
      'gi',
    ),
  );

  return Array.from(matches, (match) => {
    const hrefMatch = match[1].match(/\bhref=(['"])(.*?)\1/i);
    if (!hrefMatch || match.index === undefined) {
      return null;
    }

    return {
      href: hrefMatch[2],
      innerHtml: match[2],
      index: match.index,
      length: match[0].length,
    };
  }).filter((match): match is { href: string; innerHtml: string; index: number; length: number } => match !== null);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unwrapDuckDuckGoResultUrl(href: string): string {
  const decodedHref = decodeHtmlEntities(href);
  const absoluteHref = decodedHref.startsWith('//') ? `https:${decodedHref}` : decodedHref;

  try {
    const url = new URL(absoluteHref, DUCKDUCKGO_ORIGIN);
    return url.searchParams.get('uddg') ?? url.toString();
  } catch {
    return absoluteHref;
  }
}

function cleanHtmlFragment(fragment: string): string {
  return decodeHtmlEntities(fragment.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
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
