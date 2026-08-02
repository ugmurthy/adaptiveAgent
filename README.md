# AdaptiveAgent

## What is AdaptiveAgent?

AdaptiveAgent is the operating layer for reliable AI agents.

It is a Bun + TypeScript runtime and CLI stack for running goal-oriented agents with typed tools, structured events, approvals, resumable runs, retries, child-run delegation, and multi-model support. It helps teams move from fragile agent demos to controlled, inspectable, recoverable production workflows.

> **[Read the changelog](CHANGELOG.md).** Since release `v0.1.36`, the repository has
> added decision-oriented trace reporting, an embedded SQLite runtime, and two
> host-facing JSON-RPC 2.0 sidecars: `desktop-bridge` for agent execution and
> `trace-session-sidecar` for read-only trace access. A Tauri desktop app uses
> the desktop sidecar, while the capability gateway and its shared protocol/client
> packages provide authenticated remote inference and tools. The legacy hosted
> service stack was removed; durable runtime semantics remain in core.

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

The default quickstart calls OpenRouter directly:

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

### Choose the right CLI command

Use `run` for a one-shot goal. The command accepts the goal directly or reads
it from a file:

```bash
adaptive-agent run "Summarize this repository and identify the main packages"
adaptive-agent run --file ./prompts/release-notes.md
```

Use `chat` for an interactive conversation, or provide the first message on
the command line:

```bash
adaptive-agent chat
adaptive-agent chat "Help me refine this implementation plan"
```

Use `spec` when the request is already described by an AdaptiveAgent JSON spec:

```bash
adaptive-agent spec ./task.json
```

Use `swarm-run` when a top-level objective should be decomposed into bounded
worker runs and synthesized into one result:

```bash
adaptive-agent swarm-run \
  --agent coordinator-agent \
  --worker-catalog researcher.json,writer.json \
  --max-workers 2 \
  "Research the market and produce a launch brief"
```

Use `ambient start` to run a foreground supervisor that turns configured
filesystem inbox or cron triggers into durable agent runs:

```bash
adaptive-agent ambient start --config ./ambient.config.json
```

For persisted runs, choose the control command based on what you need:

- `inspect <runId>`: show the current run state and a compact event summary.
- `replay <runId>`: render stored events without running the agent or its tools again.
- `interrupt <runId>`: request that an active run stop; use a durable runtime
  such as Postgres when controlling a run from another process.
- `resume <runId>`: continue an interrupted or waiting run in place.
- `retry --run-id <runId>`: make another attempt after a failed run.
- `continue <runId>`: create a new, auditable continuation linked to a failed
  source run while leaving that source run unchanged.
- `recover <runId>`: let the runtime choose the cheapest safe action among
  resume, retry, and continue. Add `--dry-run` to inspect the recovery plan first.

For example:

```bash
adaptive-agent inspect <runId>
adaptive-agent recover <runId> --dry-run
adaptive-agent recover <runId>
```

Use `agent-create` to generate an agent profile from a description. It previews
the generated profile and asks for confirmation before writing it:

```bash
adaptive-agent agent-create \
  --id release-notes-writer \
  "Create an agent that turns changelog entries into concise release notes"
```

Use `context` to create and manage project-scoped bundles of prior run and
session evidence:

```bash
adaptive-agent context create release-evidence \
  --ref run:550e8400-e29b-41d4-a716-446655440000 \
  --description "Evidence for the next release"
adaptive-agent context list
adaptive-agent context show release-evidence
```

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

The current workspace packages are:

- `@adaptive-agent/core` in `packages/core`: runtime semantics, durable stores, events, snapshots, tools, delegation, retry, and continuation.
- `@adaptive-agent/agent-sdk` in `packages/agent-sdk`: user-facing `adaptive-agent` CLI, config loading, built-in tool registration, install/update flows, and evaluation helpers.
- `@adaptive-agent/trace-session` in `packages/trace-session`: decision-oriented SQLite/Postgres trace reporter with a read-only NDJSON JSON-RPC 2.0 stdio sidecar for native and desktop trace consumers.
- `@adaptive-agent/trace-workbench` in `packages/trace-workbench`: Bun + Svelte trace workbench for choosing persisted sessions/runs, exploring timelines, resource spend, messages, diagnostics, and exporting markdown/PDF reports.
- `@adaptive-agent/gateway-protocol`, `@adaptive-agent/gateway-client`, and `@adaptive-agent/capability-gateway`: shared JSON-RPC contracts, client integration, and the authenticated capability/inference gateway.
- `@adaptive-agent/desktop-bridge`: the NDJSON JSON-RPC 2.0 stdio sidecar for runtime initialization, agent execution, run control, interactions, events, and safe CLI access.
- `@adaptive-agent/desktop-app`: the Tauri 2 + Svelte desktop client backed by `desktop-bridge`.

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

`trace-session` reads core SQLite or Postgres runtime tables directly; gateway
session tables are optional. Its default `summary` report separates runtime
reliability from answer quality, reports missing evidence as uncertainty, and
keeps model/tool output cost separate from external tool-provider cost. See
[`packages/trace-session/README.md`](packages/trace-session/README.md) for the
report model, investigation workflow, cache controls, and complete command
examples.
