# AdaptiveAgent Trace Workbench

Trace Workbench is a Bun-hosted Svelte 5 application for inspecting persisted AdaptiveAgent runs and sessions from the Postgres runtime store. It reuses `@adaptive-agent/trace-session` data loading so the web UI stays aligned with the CLI trace reporter.

## What it shows

- searchable session/run selector backed by the database
- outcome narrative explaining why the run succeeded, failed, blocked, or remained unknown
- resource ledger for wall time, model time, tool time, tokens, and estimated cost
- ECharts visualizations for measured runtime split and slowest tools
- tool timeline with raw per-step payload inspection
- snapshot-backed LLM message context
- diagnostic findings and suggested next `trace-session` inspections
- markdown download and browser print-to-PDF export

## Run locally

```bash
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/adaptive_agent"
bun run trace-workbench:dev
```

The dev command starts the Bun API server on `TRACE_WORKBENCH_PORT`/`4767` and Vite on `5174`. Vite proxies `/api` to the Bun server.

## Production build

```bash
bun run trace-workbench:build
DATABASE_URL="postgres://..." bun run trace-workbench:start
```

The built Bun server serves both `/api/*` and the static Svelte client.
