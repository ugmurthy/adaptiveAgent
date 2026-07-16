# AdaptiveAgent

## What is AdaptiveAgent?

AdaptiveAgent is the operating layer for reliable AI agents.

It is a Bun + TypeScript runtime and CLI stack for running goal-oriented agents with typed tools, structured events, approvals, resumable runs, retries, child-run delegation, and multi-model support. It helps teams move from fragile agent demos to controlled, inspectable, recoverable production workflows.

## Getting Started in 60secs

### 1. Install

macOS:

```bash
curl -fsSL https://github.com/ugmurthy/adaptiveAgent/releases/latest/download/install.sh | sh
```

Linux:

```bash
curl -fsSL https://github.com/ugmurthy/adaptiveAgent/releases/latest/download/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://github.com/ugmurthy/adaptiveAgent/releases/latest/download/install.ps1 | iex
```

If the installer says `adaptive-agent` is not on your `PATH`, run the exact PATH command it prints.

### 2. Add an API key

The default hosted quickstart uses OpenRouter:

```bash
export OPENROUTER_API_KEY="<your-key>"
```

Windows PowerShell:

```powershell
$env:OPENROUTER_API_KEY = "<your-key>"
```

Other supported providers use their own keys:

- OpenRouter: `OPENROUTER_API_KEY`
- Mistral: `MISTRAL_API_KEY`
- Mesh: `MESH_API_KEY`
- Ollama: no API key, but Ollama must be running locally

Optional web tool providers are configured independently:

```bash
export PARALLEL_API_KEY="<your-key>"
export WEB_SEARCH_PROVIDER=parallel
export WEB_READ_PAGE_PROVIDER=parallel
```

`web_search` defaults to DuckDuckGo unless an API-backed provider is configured. `read_web_page` defaults to direct HTTP fetch unless `WEB_READ_PAGE_PROVIDER=parallel` is set with `PARALLEL_API_KEY`.

### 3. Init and run

```bash
adaptive-agent init
adaptive-agent doctor --provider-check
adaptive-agent run "Hello, confirm you are working"
```

That is it. You now have a configured local agent that can run goals, use tools, and produce inspectable runtime history.

### Reuse prior evidence with a named context bundle

Create a project-scoped bundle of existing run and session outputs, then reuse
it in direct run or chat requests:

```bash
adaptive-agent context create migration-research \
  --ref run:550e8400-e29b-41d4-a716-446655440000 \
  --ref session:session_456

adaptive-agent run \
  --context-bundle migration-research \
  "Draft the migration plan"
```

Bundles are stored under `.adaptiveAgent/context-bundles` in the selected
`--cwd`. Use `adaptive-agent context list`, `context show <name>`, and
`context delete <name>` to manage them. Bundle names, canonical digests, and the
exact expanded refs are persisted in consuming run metadata for inspection.
Values after `run:` must be complete run UUIDs; session IDs remain free-form
strings.

## Repository packages

This monorepo is intentionally small:

- `@adaptive-agent/core` in `packages/core`: runtime semantics, durable stores, events, snapshots, tools, delegation, retry, and continuation.
- `@adaptive-agent/agent-sdk` in `packages/agent-sdk`: user-facing `adaptive-agent` CLI, config loading, built-in tool registration, install/update flows, and evaluation helpers.
- `@adaptive-agent/trace-session` in `packages/trace-session`: decision-oriented Postgres trace reporter for core runtime runs and optional legacy gateway session tables. It provides reliability and causal findings, per-run operations analysis, exact-run comparisons, aggregate trends, and terminal, JSON, or self-contained HTML output.
- `@adaptive-agent/trace-workbench` in `packages/trace-workbench`: Bun + Svelte trace workbench for choosing persisted sessions/runs, exploring timelines, resource spend, messages, diagnostics, and exporting markdown/PDF reports.

Useful local commands:

```bash
bun run core:test
bun run agent:build
bun run trace-session list traces --limit 20
bun run trace-session view run <run-id>
bun run trace-session compare <baseline-run-id> <candidate-run-id>
bun run trace-session aggregate model --since 7d
bun run trace-workbench:dev
```

`trace-session` reads core runtime tables directly; gateway session tables are
optional. Its default `summary` report separates runtime reliability from
answer quality, reports missing evidence as uncertainty, and keeps model/tool
output cost separate from external tool-provider cost. See
[`packages/trace-session/README.md`](packages/trace-session/README.md) for the
report model, investigation workflow, cache controls, and complete command
examples.
