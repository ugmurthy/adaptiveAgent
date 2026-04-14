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
}

type WebSearchInput = {
  query: string;
  maxResults?: number;
};

type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

type WebSearchOutput = {
  query: string;
  results: WebSearchResult[];
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

  return {
    name: 'web_search',
    timeoutMs,
    description:
      'Search the web for information. Returns a list of results with title, URL, and snippet.',
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
      },
    },
    async execute(rawInput, context) {
      // Some models send tool input as a JSON string instead of an object — normalise.
      const input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
      const { query, maxResults: perCallMax } = input as unknown as WebSearchInput;
      const count = perCallMax ?? maxResults;
      try {
        const execution =
          provider === 'brave'
            ? await searchBrave({
                apiKey: config.apiKey!,
                query,
                count,
                baseUrl,
                signal: context.signal,
              })
            : await searchDuckDuckGo({
                query,
                count,
                baseUrl,
                signal: context.signal,
              });

        const output = attachWebSearchDiagnostics(
          {
            query,
            results: execution.results,
          },
          execution.diagnostics,
        );

        return output;
      } catch (error) {
        throw normalizeWebSearchError(error, query, provider);
      }
    },
    recoverError(error, input) {
      const { query } = input;
      return normalizeWebSearchError(error, query, provider).output;
    },
    summarizeResult(output) {
      return summarizeWebSearchOutput(output);
    },
  };
}

async function searchBrave({
  apiKey,
  query,
  count,
  baseUrl,
  signal,
}: {
  apiKey: string;
  query: string;
  count: number;
  baseUrl: string;
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
    const errorText = await response.text().catch(() => 'unknown error');
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
  signal,
}: {
  query: string;
  count: number;
  baseUrl: string;
  signal: AbortSignal;
}): Promise<WebSearchExecutionResult> {
  const searchPageUrl = new URL(baseUrl);
  searchPageUrl.searchParams.set('q', query);
  searchPageUrl.searchParams.set('ia', 'web');

  const searchPageResponse = await fetch(searchPageUrl.toString(), {
    headers: DUCKDUCKGO_HEADERS,
    signal,
  });
  const searchPageHtml = await searchPageResponse.text();

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
    const deepResponseText = await deepResponse.text();

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
  const fallbackHtml = await fallbackResponse.text();

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
  if (output.error) {
    return {
      query: output.query,
      resultCount: output.results.length,
      provider: output.error.provider,
      error: {
        kind: output.error.kind,
        status: output.error.status,
        message: output.error.message,
      },
    };
  }

  const diagnostics = getWebSearchDiagnostics(output);

  return {
    query: output.query,
    resultCount: output.results.length,
    provider: diagnostics?.provider ?? 'unknown',
    providerPath: diagnostics?.providerPath ?? 'unknown',
    topResults: output.results.slice(0, 3).map((result) => ({
      title: result.title,
      url: result.url,
    })),
  };
}

function getWebSearchDiagnostics(output: WebSearchOutput): WebSearchDiagnostics | undefined {
  return (output as WebSearchOutput & { [WEB_SEARCH_DIAGNOSTICS]?: WebSearchDiagnostics })[
    WEB_SEARCH_DIAGNOSTICS
  ];
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
