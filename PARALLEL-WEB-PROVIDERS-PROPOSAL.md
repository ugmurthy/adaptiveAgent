# Parallel Web Providers Proposal

## Summary

Add Parallel as an optional provider for both built-in web research tools:

- `web_search`: use the Parallel Search API.
- `read_web_page`: use the Parallel Extract API.

Keep defaults unchanged. Existing users continue to get `duckduckgo` for search fallback and direct HTTP fetch for page reads unless they opt in.

References:

- Parallel Search: <https://docs.parallel.ai/search/search-quickstart>
- Parallel Extract: <https://docs.parallel.ai/extract/extract-quickstart>
- Extract API reference: <https://docs.parallel.ai/api-reference/extract/extract>
- Advanced Extract settings: <https://docs.parallel.ai/extract/advanced-extract-settings>

## Goals

- Add `parallel` as a provider option without changing tool names or model-visible schemas.
- Preserve the current core/Agent SDK boundary:
  - Core owns provider execution, normalization, retry, and recovery behavior.
  - Agent SDK owns env/config resolution and built-in tool construction.
- Avoid a new SDK dependency initially; use direct `fetch` like existing Brave and Serper implementations.
- Keep `PARALLEL_API_KEY` out of config files and reference it only through environment variables.

## Non-goals

- Do not make Parallel the default provider.
- Do not replace the existing direct `read_web_page` implementation.
- Do not add Parallel Task, FindAll, Monitor, or CLI integration in this change.
- Do not change the model-visible input schema for `web_search` or `read_web_page`.

## Configuration

Use separate provider settings for search and page reads:

```bash
WEB_SEARCH_PROVIDER=parallel
WEB_READ_PAGE_PROVIDER=parallel
PARALLEL_API_KEY=...
```

Search and page extraction are related but distinct. A user may want Brave, Serper, or DuckDuckGo for search while using Parallel only for robust page extraction, especially for JavaScript-heavy pages and PDFs.

Current `agent.settings.json` can carry this through `env`:

```json
{
  "env": {
    "WEB_SEARCH_PROVIDER": "parallel",
    "WEB_READ_PAGE_PROVIDER": "parallel",
    "PARALLEL_API_KEY": "${PARALLEL_API_KEY}",
    "WEB_TOOL_TIMEOUT_MS": "90000"
  }
}
```

A later typed config such as `settings.web.searchProvider` and `settings.web.readPageProvider` can be considered, but env-based configuration is the least disruptive first step.

## Core: `web_search`

In `packages/core/src/tools/web-search.ts`, extend the provider union:

```ts
export type WebSearchProvider = 'brave' | 'duckduckgo' | 'serper' | 'parallel';
```

Add:

```ts
const PARALLEL_BASE_URL = 'https://api.parallel.ai/v1';
```

Require `apiKey` for `parallel`, as with Brave and Serper.

### Parallel Search request

```txt
POST https://api.parallel.ai/v1/search
Content-Type: application/json
x-api-key: $PARALLEL_API_KEY
```

Suggested body:

```json
{
  "objective": "Search objective derived from purpose/query",
  "search_queries": ["query plus exact phrase hints"],
  "max_chars_total": 50000,
  "advanced_settings": {
    "max_results": 5
  }
}
```

Mapping:

- `query` -> `search_queries[0]`
- `purpose`, `expectedUse`, `freshnessRequired`, and `answerType` -> `objective`
- `maxResults` -> `advanced_settings.max_results`
- `exactPhrases` -> append to query
- `excludeDomains` -> use Parallel source policy if available
- `domainHints` -> preferably include in `objective` unless hard filtering is desired

Parallel source policy should be used carefully because hard domain filters can reduce recall. If `domainHints` are intended as soft preferences, they should remain in the `objective` rather than becoming a hard allow list.

### Parallel Search response normalization

Normalize results to the existing output shape:

```ts
{
  title: result.title,
  url: result.url,
  snippet: result.excerpts.join('\n\n')
}
```

Diagnostics:

```ts
{
  provider: 'parallel',
  providerPath: 'api'
}
```

Keep provider-specific fields such as search IDs, session IDs, warnings, and usage out of the public output in the first implementation to avoid expanding the tool contract.

## Core: `read_web_page`

In `packages/core/src/tools/read-web-page.ts`, add provider support while preserving direct fetch as the default:

```ts
export type ReadWebPageProvider = 'direct' | 'parallel';

export interface ReadWebPageToolConfig {
  provider?: ReadWebPageProvider;
  apiKey?: string;
  baseUrl?: string;
  maxSizeBytes?: number;
  maxTextLength?: number;
  timeoutMs?: number;
  extractPdfText?: (rawBuffer: ArrayBuffer) => Promise<{ title: string; text: string }>;
}
```

Default behavior:

```ts
const provider = config?.provider ?? 'direct';
```

Require `apiKey` when `provider === 'parallel'`.

### Parallel Extract request

```txt
POST https://api.parallel.ai/v1/extract
Content-Type: application/json
x-api-key: $PARALLEL_API_KEY
```

Suggested body:

```json
{
  "urls": ["https://example.com/page"],
  "objective": "optional read_web_page objective",
  "max_chars_total": 50000,
  "advanced_settings": {
    "excerpt_settings": {
      "max_chars_per_result": 50000
    },
    "full_content": {
      "max_chars_per_result": 50000
    }
  }
}
```

Mapping:

- `url` -> single-item `urls`
- `objective` -> `objective`
- `maxTextLength` or configured `maxTextLength` -> `max_chars_total` and `full_content.max_chars_per_result`

### Parallel Extract response normalization

Normalize to the current `ReadWebPageOutput`:

- `result.url` -> `url`
- `result.title ?? ''` -> `title`
- Prefer `result.full_content` for `text`
- Otherwise join `result.excerpts` for `text`
- `result.excerpts` -> `relevantExcerpts` when `objective` is present
- `textLength` -> normalized text length
- `truncated` -> `true` if local `maxTextLength` truncates output
- `bytesFetched` -> estimated from returned text bytes or `0`

The current direct implementation reports literal bytes fetched from the source URL. Parallel Extract is provider-mediated, so `bytesFetched` is not equivalent. The first implementation should document this as normalized provider output rather than literal source bytes.

### Error mapping

- HTTP non-2xx response from Parallel -> `http_error`
- Parallel per-URL `errors[]` -> `content_error`, or `http_error` when `http_status_code` is present
- Network failure -> `network_error`
- Timeout -> `timeout`

## Agent SDK changes

In `packages/agent-sdk/src/tool-registry.ts`, extend `resolveWebSearchProvider()`:

- `WEB_SEARCH_PROVIDER=parallel` plus `PARALLEL_API_KEY` -> `parallel`
- Missing `PARALLEL_API_KEY` -> `duckduckgo`

Add a read-page provider resolver:

```ts
export function resolveReadWebPageProvider(env: NodeJS.ProcessEnv): ReadWebPageProvider {
  if (env.WEB_READ_PAGE_PROVIDER === 'parallel' && env.PARALLEL_API_KEY) return 'parallel';
  return 'direct';
}
```

Construct `web_search`:

```ts
if (webSearchProvider === 'parallel') {
  tools.set('web_search', createWebSearchTool({
    provider: 'parallel',
    apiKey: env.PARALLEL_API_KEY!,
    timeoutMs,
  }));
}
```

Construct `read_web_page`:

```ts
const readWebPageProvider = resolveReadWebPageProvider(env);
tools.set(
  'read_web_page',
  createReadWebPageTool(
    readWebPageProvider === 'parallel'
      ? { provider: 'parallel', apiKey: env.PARALLEL_API_KEY!, timeoutMs }
      : { provider: 'direct', timeoutMs },
  ),
);
```

## Rendering and inspection

Extend config and dry-run output to show both resolved providers.

Pretty output:

```txt
webSearchProvider: parallel
readWebPageProvider: parallel
```

JSON output:

```json
{
  "webSearch": { "provider": "parallel" },
  "readWebPage": { "provider": "parallel" }
}
```

## Documentation updates

Update:

- `.env.example`
- `README.md`
- `CORE_CLI.md`
- `AGENT-SDK.md`
- `packages/agent-sdk/README.md`, if it documents web tools

Example:

```bash
export PARALLEL_API_KEY="<your-key>"
export WEB_SEARCH_PROVIDER=parallel
export WEB_READ_PAGE_PROVIDER=parallel
```

## Tests

### Core `web_search`

- Parallel requires `apiKey`.
- Sends `POST /v1/search` with `x-api-key`.
- Sends `objective`, `search_queries`, and `advanced_settings.max_results`.
- Maps title, URL, and excerpts to normalized results.
- Applies `maxResults`.
- Converts non-2xx responses to recoverable provider errors.

### Core `read_web_page`

- Direct provider remains default.
- Parallel requires `apiKey`.
- Sends `POST /v1/extract` with `urls`, `objective`, and `max_chars_total`.
- Uses `full_content` when present.
- Falls back to joined `excerpts`.
- Maps per-URL extract errors.
- Preserves local truncation behavior.

### Agent SDK

- `WEB_SEARCH_PROVIDER=parallel` plus `PARALLEL_API_KEY` resolves to `parallel`.
- Missing `PARALLEL_API_KEY` falls back to `duckduckgo`.
- `WEB_READ_PAGE_PROVIDER=parallel` plus `PARALLEL_API_KEY` resolves to `parallel`.
- Missing `PARALLEL_API_KEY` falls back to `direct`.
- Pretty and JSON config/dry-run output include both providers.

## Acceptance criteria

- No behavior changes without opt-in env.
- `web_search` supports `parallel` and returns the existing `{ title, url, snippet }` shape.
- `read_web_page` supports `parallel` and returns the existing `{ url, title, text }` shape.
- Agent config can select Parallel independently for search and page reads.
- No new runtime dependency is required.
- Core remains independent of Agent SDK.
