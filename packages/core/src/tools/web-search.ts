import type { ToolDefinition } from '../types.js';

export interface WebSearchToolConfig {
  /** API key for the search provider. */
  apiKey: string;
  /** Search provider. Defaults to `'brave'`. */
  provider?: 'brave';
  /** Maximum results to return. Defaults to `5`. */
  maxResults?: number;
  /** Base URL override for testing. */
  baseUrl?: string;
}

interface WebSearchInput {
  query: string;
  maxResults?: number;
}

interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface WebSearchOutput {
  query: string;
  results: WebSearchResult[];
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

const BRAVE_BASE_URL = 'https://api.search.brave.com/res/v1';

export function createWebSearchTool(config: WebSearchToolConfig): ToolDefinition {
  const maxResults = config.maxResults ?? 5;
  const baseUrl = config.baseUrl ?? BRAVE_BASE_URL;

  return {
    name: 'web_search',
    description:
      'Search the web for information. Returns a list of results with title, URL, and snippet.',
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
    async execute(input, context) {
      const { query, maxResults: perCallMax } = input as unknown as WebSearchInput;
      const count = perCallMax ?? maxResults;

      const url = new URL(`${baseUrl}/web/search`);
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(count));

      const response = await fetch(url.toString(), {
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': config.apiKey,
        },
        signal: context.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown error');
        throw new Error(`Brave Search API returned ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as BraveSearchResponse;
      const results: WebSearchResult[] = (data.web?.results ?? [])
        .slice(0, count)
        .map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.description,
        }));

      return {
        query,
        results,
      } satisfies WebSearchOutput as unknown as ReturnType<ToolDefinition['execute']>;
    },
  };
}
