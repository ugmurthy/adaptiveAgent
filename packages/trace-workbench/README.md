# AdaptiveAgent Trace Workbench

Trace Workbench is a Bun-hosted Svelte 5 application for inspecting persisted AdaptiveAgent runs and sessions from the Postgres runtime store. It reuses `@adaptive-agent/trace-session` data loading so the web UI stays aligned with the CLI trace reporter.

## What it shows

- searchable session/run selector backed by the database
- outcome narrative explaining why the run succeeded, failed, blocked, or remained unknown
- resource ledger for wall time, model time, tool time, tokens, and estimated cost
- canonical per-run efficiency, retry, tool-output, context-growth, and evidence-coverage diagnostics from `report.diagnostics.analysis`
- ECharts visualizations for measured runtime split and slowest tools
- tool timeline with raw per-step payload inspection
- snapshot-backed LLM message context
- diagnostic findings and suggested next `trace-session` inspections
- markdown download and browser print-to-PDF export using the same attached diagnostics as the UI

The Workbench is a presentation consumer of `@adaptive-agent/trace-session`.
It does not derive a second set of analytics in the browser or API server:
session/run endpoints return the canonical `TraceReport`, and the diagnostic
tables and exports read `report.diagnostics.analysis.runs` directly.

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
