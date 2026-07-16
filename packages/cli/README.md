> Explore the AdaptiveAgent Showcase: https://ugmurthy.github.io/showcase.html

# Adaptive Agent CLI

Installable command-line tools for running Adaptive Agent profiles and inspecting their durable execution traces.

This npm package installs two binaries:

- `adaptive-agent` - initialize, configure, run, chat with, evaluate, retry, and orchestrate agents.
- `trace-session` - inspect Postgres-backed sessions, runs, messages, timelines, usage, and trace reports created by Adaptive Agent.

The package is a small JavaScript wrapper around platform-specific native binaries. It installs the right binary package for macOS, Linux, or Windows through optional dependencies.

## Install

```bash
npm install -g @adaptive-agent/cli

adaptive-agent --version
adaptive-agent --help
trace-session --help
```

You can also run with `npx`:

```bash
npx -p @adaptive-agent/cli adaptive-agent --help
npx -p @adaptive-agent/cli trace-session --help
```

## Quick start: initialize, check, run

Create a default home config, verify it, inspect the resolved catalog, then run one goal.

```bash
adaptive-agent init --yes

# Confirm the active agent, model, runtime, workspace, tools, and delegates.
adaptive-agent config

# List available agents, tools, and delegate skills.
adaptive-agent catalog

# Validate install, config lookup, model provider setup, and runtime settings.
adaptive-agent doctor --runtime memory

adaptive-agent run --runtime memory \
  "Summarize this repository in five bullets."
```

Use `--output json` or `--output jsonl` with `config`, `catalog`, `doctor`, and run commands when wiring the CLI into scripts.

## API keys and provider setup

At least one model provider is required. Ollama works locally without an API key; hosted providers use environment variables referenced by your `agent.json` model config.

Common model keys:

```bash
# OpenRouter
export OPENROUTER_API_KEY="<your-openrouter-key>"

# Mistral
export MISTRAL_API_KEY="<your-mistral-key>"

# Mesh
export MESH_API_KEY="<your-mesh-key>"
```

Optional web-tool keys:

```bash
# Use Parallel for both search and page extraction.
export PARALLEL_API_KEY="<your-parallel-key>"
export WEB_SEARCH_PROVIDER=parallel
export WEB_READ_PAGE_PROVIDER=parallel

# Or use another search provider.
export BRAVE_SEARCH_API_KEY="<your-brave-key>"
export SERPER_API_KEY="<your-serper-key>"
```

Check what the CLI resolved before spending model tokens:

```bash
adaptive-agent config --output json
adaptive-agent catalog
adaptive-agent doctor --provider-check
```

For durable sessions, retries, and trace inspection, point both commands at the same Postgres database:

```bash
export DATABASE_URL="postgres://localhost:5432/adaptive_agent"

adaptive-agent doctor --runtime postgres
```

## Running agents

Run a one-shot goal with the active agent:

```bash
adaptive-agent run \
  --provider openrouter \
  --model qwen/qwen3.5-27b \
  --runtime memory \
  --output pretty \
  "Draft a migration checklist for this TypeScript package."
```

Chat with the same profile:

```bash
adaptive-agent chat "What files should I inspect first?"
```

Use explicit project-local config files:

```bash
adaptive-agent run \
  --agent .adaptive-agent/reviewer.agent.json \
  --settings .adaptive-agent/settings.json \
  --input-json '{"focus":["runtime safety","tests"]}' \
  --file-attachment ./bun.lock \
  --inspect \
  "Review the current changes."
```

Inspect the request without executing it:

```bash
adaptive-agent run --dry-run "Summarize the repo architecture."
```

## Orchestrated runs and retry

Use `swarm-run` when one top-level objective should be decomposed into worker runs, quality checked, and synthesized into one result.

```bash
export DATABASE_URL="postgres://localhost:5432/adaptive_agent"
export MESH_API_KEY="<your-mesh-key>"

adaptive-agent swarm-run \
  --runtime postgres \
  --agent agents/coordinator.json \
  --worker-catalog agents/market.json,agents/pricing.json,agents/regulatory.json \
  --quality-agent agents/quality.json \
  --synthesizer-agent agents/synthesizer.json \
  --max-workers 3 \
  --session-id ev-market-entry-2027 \
  --events \
  --output json \
  "Create an India market-entry strategy for a premium electric two-wheeler startup launching in 2027."
```

Retry a durable session after fixing a provider, network, or tool issue:

```bash
adaptive-agent retry \
  --runtime postgres \
  --agent agents/coordinator.json \
  --worker-catalog agents/market.json,agents/pricing.json,agents/regulatory.json \
  ev-market-entry-2027
```

Or retry one failed run directly:

```bash
adaptive-agent retry --runtime postgres --agent agents/market.json --run-id <failed-run-id>
```

## Trace sessions

`trace-session` reads the same Postgres runtime store used by
`adaptive-agent --runtime postgres`. It reads core runtime tables directly;
legacy gateway session tables are optional. Use it to discover traces, assess
runtime reliability, investigate causal findings, inspect operations and model
context, compare exact runs, or aggregate trends. Reports can be rendered for
the terminal, as JSON, or as self-contained HTML.

Discover recent traces and copy a complete run ID:

```bash
trace-session list traces --limit 20
trace-session list sessions --since 24h
trace-session list sessionless-runs
```

The default report is a decision-oriented summary. Targets can be a session, a
root run, or any child run:

```bash
trace-session view session ev-market-entry-2027
trace-session view root-run <root-run-id>
trace-session view run <run-id>
```

Use focused reports to explain reliability, follow the primary cause and
recovery evidence, inspect operations, or load snapshot-backed model context:

```bash
trace-session view run <run-id> --report reliability
trace-session view run <run-id> --report investigate
trace-session view run <run-id> --report operations
trace-session view run <run-id> --report timeline --include-plans
trace-session view run <run-id> --report messages --messages-view delta
trace-session usage session ev-market-entry-2027
```

Runtime reliability and answer quality are separate: without a persisted
evaluator result, the report says that output quality was not evaluated.
Missing evidence lowers data confidence rather than being guessed. Cost output
also keeps model/tool-output cost and external tool-provider cost separate.

Write a portable HTML report or consume the same structured diagnostics as
JSON:

```bash
trace-session view session ev-market-entry-2027 \
  --report all \
  --messages \
  --html artifacts/ev-market-entry-2027.html

trace-session view run <run-id> --json
```

Compare the operational analysis of two exact runs, or group root-trace trends
by model, terminal status, or UTC start day:

```bash
trace-session compare <baseline-run-id> <candidate-run-id>
trace-session compare <baseline-run-id> <candidate-run-id> \
  --html artifacts/comparison.html

trace-session aggregate model --since 7d
trace-session aggregate status --since 24h --json
trace-session aggregate day --since 30d --html artifacts/trends.html
```

Comparison deltas are candidate minus baseline. Aggregate duration
distributions include p50, p90, and p95; missing usage, cost, or context values
remain missing instead of becoming zero.

If your trace database is not in `DATABASE_URL`, pass it explicitly:

```bash
trace-session list traces \
  --database-url "postgres://localhost:5432/adaptive_agent"

cat > trace-session.json <<'JSON'
{
  "urlEnv": "TRACE_DATABASE_URL",
  "ssl": false
}
JSON

export TRACE_DATABASE_URL="postgres://localhost:5432/adaptive_agent"
trace-session list traces --config trace-session.json
```

Terminal trace and usage reports are cached for five minutes by default.
Bypass or disable the persistent cache when inspecting changing data:

```bash
trace-session view run <run-id> --fresh
trace-session view run <run-id> --no-cache
trace-session view run <run-id> --cache-ttl 30s
```

## Common commands

```bash
adaptive-agent init --yes
adaptive-agent config [--output pretty|json|jsonl]
adaptive-agent catalog [--output pretty|json|jsonl]
adaptive-agent doctor [--runtime memory|postgres] [--provider-check]
adaptive-agent run [options] <goal...>
adaptive-agent chat [options] [message...]
adaptive-agent swarm-run --agent <agent> --worker-catalog <agents> <objective...>
adaptive-agent retry --run-id <runId>

trace-session list sessions
trace-session list traces
trace-session list sessionless-runs
trace-session view session <sessionId> [--report <name>]
trace-session view root-run <rootRunId> [--report <name>]
trace-session view run <runId> [--report <name>]
trace-session usage session <sessionId>
trace-session usage root-run <rootRunId>
trace-session usage run <runId>
trace-session compare <baselineRunId> <candidateRunId>
trace-session aggregate model [--since <time>] [--until <time>]
trace-session aggregate status [--since <time>] [--until <time>]
trace-session aggregate day [--since <time>] [--until <time>]
```

## Links

- Source: https://github.com/ugmurthy/adaptiveAgent
- Changelog: https://github.com/ugmurthy/adaptiveAgent/blob/main/CHANGELOG.md
- Issues: https://github.com/ugmurthy/adaptiveAgent/issues
- License: MIT
