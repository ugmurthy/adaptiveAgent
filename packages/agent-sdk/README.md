# @adaptive-agent/agent-sdk

`@adaptive-agent/agent-sdk` is the CLI-facing package for running configured agents from the shell. It resolves `agent.json` and `agent.settings.json`, wires built-in tools, chooses a runtime store, and calls `@adaptive-agent/core` with CLI-friendly defaults.

Use this package when you want an executable command such as `adaptive-agent run`, `adaptive-agent chat`, `adaptive-agent swarm-run`, `adaptive-agent retry`, or `adaptive-agent eval`. Use `@adaptive-agent/core` directly when you are embedding the runtime in an application and want to provide stores, tools, model adapters, and event handling yourself.

## CLI API at a glance

```bash
adaptive-agent init [options]
adaptive-agent doctor [options]
adaptive-agent config [options]
adaptive-agent run [options] <goal...>
adaptive-agent chat [options] [message...]
adaptive-agent spec <path> [options]
adaptive-agent catalog [options]
adaptive-agent swarm-run --agent <agent> --worker-catalog <agents> [options] <task...>
adaptive-agent retry --run-id <runId> [options]
adaptive-agent retry --agent <agent> --worker-catalog <agents> [options] <sessionId>
adaptive-agent eval cases --input <path> --out <path> [options]
adaptive-agent eval gaia --input <path> --out <path> [options]
adaptive-agent update [options]
adaptive-agent --version
```

Common options:

| Option | Purpose |
| --- | --- |
| `--agent <path-or-name>` | Use a specific `agent.json`, or a named file found in `settings.agents.dirs`. |
| `--settings <path>` | Use a specific `agent.settings.json`. |
| `--cwd <path>` | Change config lookup and workspace resolution root. |
| `--runtime memory\|postgres` | Override runtime store mode. |
| `--provider openrouter\|ollama\|mistral\|mesh` | Override the model provider. |
| `--model <name>` | Override the model name. |
| `--approval auto\|manual\|reject` | Decide how approval-gated tools are handled. |
| `--clarification interactive\|fail` | Decide how clarification requests are handled. |
| `--output pretty\|json\|jsonl` | Choose terminal or machine-readable output. |
| `--progress` | Print assistant progress summaries while the run executes. |
| `--events` | Print lifecycle events while the run executes. |
| `--inspect` | Print a compact run/event summary after completion. |
| `--dry-run` | Resolve config, request, tools, and delegates without executing. |

Use `adaptive-agent catalog` to print a human-readable inventory of the active agent, every agent found in `settings.agents.dirs`, every registered tool, and delegate skills found in `settings.skills.dirs`. Add `--output json` or `--output jsonl` for scripts.

## Init install options

`adaptive-agent init` creates `~/.adaptiveAgent`, writes the default agent, and installs the built-in `core` bundle unless `--minimal` is used. Bundled assets are regular agent JSON files and skill directories copied into the configured home folders:

```text
~/.adaptiveAgent/agents/
~/.adaptiveAgent/skills/
```

Useful init variants:

```bash
adaptive-agent init --yes
adaptive-agent init --minimal --yes
adaptive-agent init --bundle coding --bundle research --yes
adaptive-agent init --install-agent ./agents --install-skill ./skills --yes
adaptive-agent init --install-manifest ./adaptive-agent.install.json --yes
```

Install manifests are JSON files with paths relative to the manifest file:

```json
{
  "version": 1,
  "bundles": ["research"],
  "agents": ["./agents/reviewer.json"],
  "skills": ["./skills/code-review"]
}
```

## Configuration API

The CLI has two config files:

- `agent.json`: the agent profile to run.
- `agent.settings.json`: local defaults for runtime, logging, interaction, config lookup, and skills.

Lookup order:

1. explicit `--settings` or `ADAPTIVE_AGENT_SETTINGS`
2. `./agent.settings.json`
3. `$ADAPTIVE_AGENT_HOME/agent.settings.json` or `~/.adaptiveAgent/agent.settings.json`
4. explicit `--agent` or `ADAPTIVE_AGENT_CONFIG`
5. `./agent.json`
6. `$ADAPTIVE_AGENT_HOME/agents/default-agent.json`

When `--agent` or `ADAPTIVE_AGENT_CONFIG` is a bare name such as `reviewer`, the CLI also searches `settings.agents.dirs` for `reviewer` or `reviewer.json`.

Minimal `agent.json`:

```json
{
  "version": 1,
  "id": "default-agent",
  "name": "Default Agent",
  "invocationModes": ["run", "chat"],
  "defaultInvocationMode": "run",
  "model": {
    "provider": "openrouter",
    "model": "qwen/qwen3.5-27b",
    "apiKeyEnv": "OPENROUTER_API_KEY"
  },
  "workspaceRoot": ".",
  "systemInstructions": "You are a concise local assistant.",
  "tools": ["read_file", "list_directory", "web_search", "read_web_page"],
  "defaults": {
    "maxSteps": 30,
    "capture": "summary"
  }
}
```

Minimal `agent.settings.json`:

```json
{
  "version": 1,
  "agents": {
    "dirs": ["./agents"]
  },
  "skills": {
    "dirs": ["./skills"]
  },
  "runtime": {
    "mode": "memory"
  },
  "interaction": {
    "approvalMode": "manual",
    "clarificationMode": "interactive"
  }
}
```

Built-in tool names available to `agent.json` are:

- `read_file`
- `list_directory`
- `write_file`
- `shell_exec`
- `web_search`
- `read_web_page`

Web providers are opt-in through env. `web_search` defaults to DuckDuckGo unless `WEB_SEARCH_PROVIDER=brave`, `serper`, or `parallel` is set with the matching API key. `read_web_page` defaults to direct HTTP fetch unless `WEB_READ_PAGE_PROVIDER=parallel` is set with `PARALLEL_API_KEY`.

```bash
export PARALLEL_API_KEY="<your-key>"
export WEB_SEARCH_PROVIDER=parallel
export WEB_READ_PAGE_PROVIDER=parallel
```

`write_file` and `shell_exec` are approval-gated tools. Use `--approval manual` when you want the CLI to prompt before executing them, `--approval auto` for unattended runs, and `--approval reject` when a run must not perform gated actions.

## Simple use case: first local run

Create a safe read-only config, validate it, and run one goal.

```bash
adaptive-agent init \
  --provider ollama \
  --model llama3.2 \
  --profile safe \
  --yes

adaptive-agent doctor --runtime memory

adaptive-agent run \
  --runtime memory \
  --output pretty \
  "Summarize this repository in five bullets."
```

What this exercises:

- config generation under `~/.adaptiveAgent`
- memory runtime stores
- the generated default agent
- read-only built-in tools
- human-readable output

## Medium use case: project agent with attachments and JSON output

Create project-local config for a code review assistant.

```bash
mkdir -p .adaptive-agent
```

`.adaptive-agent/reviewer.agent.json`:

```json
{
  "version": 1,
  "id": "code-reviewer",
  "name": "Code Reviewer",
  "invocationModes": ["run"],
  "defaultInvocationMode": "run",
  "workspace": {
    "root": ".",
    "shellCwd": "."
  },
  "model": {
    "provider": "openrouter",
    "model": "qwen/qwen3.5-27b",
    "apiKeyEnv": "OPENROUTER_API_KEY"
  },
  "systemInstructions": "Review changes like a senior TypeScript maintainer. Prefer precise findings over broad advice.",
  "tools": ["read_file", "list_directory", "web_search", "read_web_page"],
  "defaults": {
    "maxSteps": 40,
    "capture": "summary"
  },
  "capabilities": {
    "modalitiesSupported": ["text", "image", "file"],
    "subjectsPreferred": ["typescript", "code review"]
  }
}
```

`.adaptive-agent/settings.json`:

```json
{
  "version": 1,
  "runtime": {
    "mode": "memory"
  },
  "interaction": {
    "approvalMode": "manual",
    "clarificationMode": "fail"
  },
  "events": {
    "printLifecycle": true
  }
}
```

Run it with structured input and an attachment:

```bash
export OPENROUTER_API_KEY="..."

adaptive-agent run \
  --agent .adaptive-agent/reviewer.agent.json \
  --settings .adaptive-agent/settings.json \
  --input-json '{"base":"main","focus":["runtime safety","tests"]}' \
  --file-attachment ./bun.lock \
  --output json \
  --inspect \
  "Review the dependency and package-level implications of the current changes."
```

Use `--dry-run` with the same command to inspect the resolved model, workspace, tool list, delegate list, and request payload before spending model tokens.

What this exercises:

- explicit project config paths
- model override and API key resolution
- structured run input through `--input-json`
- file attachment normalization
- machine-readable output for scripts
- post-run inspection

## Complex use case: orchestrated specialist run with retry

Use `swarm-run` when one top-level objective should be decomposed into worker runs, quality checked, and synthesized into a final answer. The coordinator and every worker are normal agent configs; the CLI translates them into strict core run requests.

Example file layout:

```text
agents/
|- coordinator.json
|- market.json
|- pricing.json
|- regulatory.json
|- quality.json
`- synthesizer.json
```

The coordinator config must be able to decompose work. Worker configs should specialize by `id`, `systemInstructions`, and optional `capabilities.subjectsPreferred`.

`agents/market.json`:

```json
{
  "version": 1,
  "id": "market-research",
  "name": "Market Research",
  "invocationModes": ["run"],
  "defaultInvocationMode": "run",
  "model": {
    "provider": "mesh",
    "model": "qwen/qwen3.5-27b",
    "apiKeyEnv": "MESH_API_KEY"
  },
  "systemInstructions": "Produce concise market research findings with assumptions and evidence gaps.",
  "tools": ["web_search", "read_web_page"],
  "capabilities": {
    "subjectsPreferred": ["market sizing", "customer segments", "competition"]
  },
  "defaults": {
    "maxSteps": 30,
    "researchPolicy": "standard",
    "capture": "summary"
  }
}
```

Run the session with durable Postgres storage:

```bash
export MESH_API_KEY="..."
export DATABASE_URL="postgres://localhost:5432/adaptive_agent"

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

If a worker fails with a retryable runtime failure, retry the whole swarm session after fixing the provider, network, or tool issue:

```bash
adaptive-agent retry \
  --runtime postgres \
  --agent agents/coordinator.json \
  --worker-catalog agents/market.json,agents/pricing.json,agents/regulatory.json \
  --quality-agent agents/quality.json \
  --synthesizer-agent agents/synthesizer.json \
  --max-workers 3 \
  ev-market-entry-2027
```

Or retry one failed run directly:

```bash
adaptive-agent retry \
  --runtime postgres \
  --agent agents/market.json \
  --run-id <failed-run-id> \
  --output json
```

What this exercises:

- coordinator, worker, quality, and synthesizer agent profiles
- `sessionId` as the grouping key for the whole swarm
- durable runtime tables, events, snapshots, and retry metadata
- bounded worker concurrency through `--max-workers`
- session-level and run-level retry commands

## Other CLI API surfaces

- `config` prints the resolved agent, settings, workspace, runtime mode, and model selection.
- `spec` runs an explicit JSON request file instead of an inline command-line goal.
- `chat` sends one chat turn and reads stdin when no message argument is provided.
- `eval cases` and `eval gaia` run JSON/JSONL datasets and write JSONL result records.
- `doctor` validates installation, local config, runtime settings, and optional provider reachability.
- `update` checks for or applies GitHub Release updates.

The package also exports `createAgentSdk()`, `loadAgentSdkConfig()`, and `inspectAgentSdkResolution()` for hosts that want the same config resolution behavior without spawning the CLI, but the command line remains the primary API documented here.
