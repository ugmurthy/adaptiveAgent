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

`trace-session` reads the same Postgres runtime store used by `adaptive-agent --runtime postgres`. Use it to inspect what happened after a run: session list, run tree, message snapshots, tool timeline, usage, costs, and HTML reports.

List recent sessions:

```bash
trace-session --ls
trace-session --lsp
```

Inspect one session:

```bash
trace-session ev-market-entry-2027 --view overview
trace-session ev-market-entry-2027 --view timeline --include-plans
trace-session ev-market-entry-2027 --messages --messages-view delta
trace-session ev-market-entry-2027 --usage
```

Inspect by run id instead of session id:

```bash
trace-session --run <run-id> --view investigate
trace-session --root-run <root-run-id> --view performance
```

Write a portable HTML trace report:

```bash
trace-session ev-market-entry-2027 --view all --html artifacts/ev-market-entry-2027.html
```

If your trace database is not in `DATABASE_URL`, pass it explicitly:

```bash
trace-session --ls --database-url "postgres://localhost:5432/adaptive_agent"

cat > trace-session.json <<'JSON'
{
  "urlEnv": "TRACE_DATABASE_URL",
  "ssl": false
}
JSON

export TRACE_DATABASE_URL="postgres://localhost:5432/adaptive_agent"
trace-session --ls --config trace-session.json
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

trace-session --ls
trace-session <sessionId> --view overview|timeline|messages|performance|all
trace-session <sessionId> --usage
trace-session --run <runId> --view investigate
trace-session <sessionId> --html <path>
```

## Links

- Source: https://github.com/ugmurthy/adaptiveAgent
- Issues: https://github.com/ugmurthy/adaptiveAgent/issues
- License: MIT
