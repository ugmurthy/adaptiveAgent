# Parallel Web Providers Proposal

## Summary

Add Parallel as an optional provider for both built-in web research tools:

- `web_search`: use the Parallel Search API.
- `read_web_page`: use the Parallel Extract API.

Keep defaults unchanged. Existing users continue to get `duckduckgo` for search fallback and direct HTTP fetch for page reads unless they opt in.

References:

- Parallel Search: <https://docs.parallel.ai/search/search-quickstart>
- Search API reference: <https://docs.parallel.ai/api-reference/search/search>
- Parallel Extract: <https://docs.parallel.ai/extract/extract-quickstart>
- Extract API reference: <https://docs.parallel.ai/api-reference/extract/extract>
- Advanced Extract settings: <https://docs.parallel.ai/extract/advanced-extract-settings>

## Goals

- Add `parallel` as a provider option without changing tool names or model-visible schemas.
- Preserve the current core/Agent SDK boundary:
  - Core owns provider execution, normalization, retry, and recovery behavior.
  - Agent SDK owns env/config resolution and built-in tool construction.
- Avoid a new SDK dependency initially; use direct `fetch` like existing Brave and Serper implementations.
- Do not store raw `PARALLEL_API_KEY` values in config files; reference the key through environment variables.

## Non-goals

- Do not make Parallel the default provider.
- Do not replace the existing direct `read_web_page` implementation.
- Do not add Parallel Task, FindAll, Monitor, or new CLI commands/flags in this change.
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

Do not write the raw Parallel API key into `agent.settings.json`. The example above uses `${PARALLEL_API_KEY}` so expansion reads the secret from the process environment.

## Core: `web_search`

In `packages/core/src/tools/web-search.ts`, extend the provider union:

```ts
export type WebSearchProvider = 'brave' | 'duckduckgo' | 'serper' | 'parallel';
```

Add:

```ts
const PARALLEL_BASE_URL = 'https://api.parallel.ai/v1';
const DEFAULT_PARALLEL_SEARCH_MAX_CHARS_TOTAL = 8_000;
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
  "max_chars_total": 8000,
  "session_id": "<context.runId>",
  "advanced_settings": {
    "max_results": 5,
    "excerpt_settings": {
      "max_chars_per_result": 2000
    },
    "source_policy": {
      "exclude_domains": ["example-spam.com"]
    }
  }
}
```

Mapping:

- `query` plus quoted `exactPhrases` -> `search_queries[0]`
- `purpose`, `expectedUse`, `freshnessRequired`, `answerType`, and soft `domainHints` -> `objective`
- `maxResults` -> `advanced_settings.max_results`
- `excludeDomains` -> `advanced_settings.source_policy.exclude_domains`
- `context.runId` -> `session_id` exactly as provided by the core tool context
- default `max_chars_total` -> `8000`, with a per-result excerpt cap to keep search snippets bounded

Parallel source policy should be used carefully because hard domain filters can reduce recall. If `domainHints` are intended as soft preferences, they should remain in the `objective` rather than becoming a hard allow list.

Implementation detail: current non-Parallel providers use a single effective query string that adds `site:` and `-site:` operators. Parallel should not reuse that helper as-is. Use provider-specific query construction:

- Brave, Serper, and DuckDuckGo keep the existing effective query behavior.
- Parallel receives the raw `query`, quoted phrase hints, soft domain preferences in `objective`, and hard exclusions through source policy.

Do not hash, shorten, or expose the Parallel `session_id`; pass the complete core `runId` in requests so related Search and Extract calls in the same run can be correlated by Parallel without changing the tool output contract.

### Parallel Search response normalization

Normalize results to the existing output shape:

```ts
{
  title: result.title?.trim() || result.url,
  url: result.url,
  snippet: truncateParallelSnippet(result.excerpts.join('\n\n'))
}
```

Skip malformed provider entries that do not include a usable URL. Treat missing or null titles as non-fatal and fall back to the URL.

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
  "max_chars_total": 100000,
  "session_id": "<context.runId>",
  "advanced_settings": {
    "excerpt_settings": {
      "max_chars_per_result": 50000
    },
    "full_content": {
      "max_chars_per_result": 100000
    }
  }
}
```

Mapping:

- `url` -> single-item `urls`
- `objective` -> `objective`
- `context.runId` -> `session_id` exactly as provided by the core tool context
- `maxTextLength` or configured `maxTextLength` -> local output cap
- provider full-content cap -> request more than the local output cap when possible, for example `min(maxTextLength * 2, 100000)`, so core can apply existing local truncation semantics after extraction

### Parallel Extract response normalization

Normalize to the current `ReadWebPageOutput`:

- `result.url` -> `url`
- `result.title ?? ''` -> `title`
- Prefer `result.full_content` for `text`
- Otherwise join `result.excerpts` for `text`
- `result.excerpts` -> preferred `relevantExcerpts` when `objective` is present; fall back to existing local excerpt scoring when provider excerpts are absent
- `textLength` -> normalized text length
- `truncated` -> `true` if local `maxTextLength` truncates output, or best-effort `true` when returned `full_content` reaches the provider cap
- `bytesFetched` -> estimated from returned text bytes or `0`

The current direct implementation reports literal bytes fetched from the source URL. Parallel Extract is provider-mediated, so `bytesFetched` is not equivalent. The first implementation should document this as normalized provider output rather than literal source bytes.

Parallel Extract does not expose the total source text length when full content is provider-truncated. Preserve existing local truncation behavior when core has enough text to do so; otherwise mark provider-cap truncation as best-effort and keep `next` best-effort rather than promising exact continuation semantics.

### Error mapping

- HTTP non-2xx response from Parallel -> `http_error`
- Parallel per-URL `errors[]` -> `content_error`, or `http_error` when `http_status_code` is present
- No matching result and no per-URL error -> `content_error`
- Network failure -> `network_error`
- Timeout -> `timeout`

## Agent SDK changes

In `packages/agent-sdk/src/tool-registry.ts`, extend `resolveWebSearchProvider()`:

- `WEB_SEARCH_PROVIDER=parallel` plus `PARALLEL_API_KEY` -> `parallel`
- Missing `PARALLEL_API_KEY` -> `duckduckgo`

Export `ReadWebPageProvider` from `packages/core/src/tools/index.ts`, then import it in Agent SDK alongside `WebSearchProvider`.

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

Update every provider-reporting surface, not only the main dry-run path:

- `adaptive-agent config` pretty and JSON output
- run/chat dry-run pretty, JSON, and JSONL output
- swarm dry-run output and per-role summaries
- eval dry-run pretty, JSON, and JSONL output

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
- Sends `objective`, `search_queries`, `session_id`, `max_chars_total: 8000`, and `advanced_settings.max_results`.
- Passes the complete core `runId` as Parallel `session_id`.
- Maps title, URL, and excerpts to normalized results.
- Falls back to URL when Parallel returns `title: null`.
- Skips malformed provider results without usable URLs.
- Keeps `domainHints` soft for Parallel and does not convert them to `site:` filters.
- Maps `excludeDomains` to `advanced_settings.source_policy.exclude_domains` for Parallel.
- Applies `maxResults`.
- Converts non-2xx responses to recoverable provider errors.

### Core `read_web_page`

- Direct provider remains default.
- Parallel requires `apiKey`.
- Sends `POST /v1/extract` with `urls`, `objective`, `session_id`, and `max_chars_total`.
- Passes the complete core `runId` as Parallel `session_id`.
- Uses `full_content` when present.
- Falls back to joined `excerpts`.
- Maps per-URL extract errors.
- Maps missing result with no per-URL error to `content_error`.
- Preserves local truncation behavior.

### Agent SDK

- `WEB_SEARCH_PROVIDER=parallel` plus `PARALLEL_API_KEY` resolves to `parallel`.
- Missing `PARALLEL_API_KEY` falls back to `duckduckgo`.
- `WEB_READ_PAGE_PROVIDER=parallel` plus `PARALLEL_API_KEY` resolves to `parallel`.
- Missing `PARALLEL_API_KEY` falls back to `direct`.
- Pretty, JSON, and JSONL config/dry-run/eval/swarm output include both providers.

## Acceptance criteria

- No behavior changes without opt-in env.
- `web_search` supports `parallel` and returns the existing `{ title, url, snippet }` shape.
- `read_web_page` supports `parallel` and returns the existing `{ url, title, text }` shape.
- Parallel Search defaults to `max_chars_total: 8000`.
- Parallel Search uses provider-aware query construction rather than hard-coding `site:` filters from soft domain hints.
- Parallel Search and Extract pass the complete core `runId` as Parallel `session_id`.
- Agent config can select Parallel independently for search and page reads.
- No new runtime dependency is required.
- Core remains independent of Agent SDK.
