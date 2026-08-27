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

## Four CLI demonstrations

These examples progress from a single default-agent run to scoped delegation
and capability-based specialist routing. Run them from the repository or
project that you want the agents to inspect.

### 1. Run one useful goal

Ask the default agent to inspect the current repository while showing progress
and a compact post-run summary:

```bash
adaptive-agent run \
  --progress \
  --inspect \
  "Explain this repository to a new contributor in five bullets."
```

This exercises default agent resolution, one-shot goal execution, local tools,
progress updates, and persisted run inspection. Add `--events` to display the
full lifecycle event stream.

### 2. Refine an idea through chat

Start an interactive conversation:

```bash
adaptive-agent chat
```

For example, develop a release plan over several turns:

```text
You: Help me plan the next release of this project.
You: Adapt the plan for a small open-source team with one maintainer.
You: Turn it into a checklist ordered by release risk.
```

You can also provide the first message directly or pipe it from a file:

```bash
adaptive-agent chat "Help me review this implementation plan."
cat implementation-plan.md | adaptive-agent chat
```

Use `chat` while shaping a goal through conversation. Use `run` when the desired
outcome is already clear enough to execute as one objective.

### 3. Delegate focused research to a skill

The default `core` bundle includes a `planner` agent and a scoped `research`
skill. Give the planner a goal that combines local repository evidence with
external research:

```bash
adaptive-agent run \
  --agent planner \
  --events \
  --inspect \
  "Compare this project's retry and recovery model with current agent-runtime practices. Produce a concise plan for communicating three meaningful differentiators, cite the external sources used, and identify claims that still need verification."
```

The planner owns the top-level objective and can delegate the research portion
to a skill-backed child run. The delegate receives focused instructions and a
scoped tool set, then returns its findings to the parent for synthesis. The
event stream makes the parent and child-run boundaries visible.

### 4. Route a request to a specialist

Orchestration routes work using agent catalog metadata instead of asking a
model to choose arbitrary profiles. The installed `reviewer` profile declares
`code review` as a preferred subject, so it can handle the specialist stage
before the requested default agent synthesizes the final response:

```bash
adaptive-agent run \
  --agent default-agent \
  --orchestrate \
  --catalog reviewer \
  --events \
  --inspect \
  "Perform a code review of the current changes and prioritize correctness, security, and missing tests."
```

Catalog profiles can also declare supported and preferred `text`, `image`,
`file`, and `audio` modalities. With multiple matching specialists,
orchestration can run independent stages before final synthesis. Preview the
resolved configuration and request without spending model tokens by adding
`--dry-run`.

Delegation, orchestration, and swarms serve different scopes:

| Capability | Best use |
| --- | --- |
| Delegate skill | One running agent hands off a bounded responsibility to a scoped child run. |
| Orchestration | The SDK routes known input modalities or subjects to catalog specialists. |
| `swarm-run` | A coordinator dynamically decomposes a broad objective into independent worker runs and synthesizes their results. |

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

The `--config` path is resolved from the directory where the command is run.
Paths inside the config are resolved as described below.

### Ambient filesystem inbox config

This complete example watches `agent_inbox/pending` for Markdown files. Each
file's contents become the goal for one agent run.

```json
{
  "version": 1,
  "workspaceRoot": ".",
  "artifactsRoot": "./artifacts/ambient",
  "agent": {
    "configPath": "./agents/inbox-agent.json"
  },
  "settings": {
    "configPath": "./agent.settings.json"
  },
  "runtime": {
    "mode": "sqlite"
  },
  "interaction": {
    "approvalMode": "reject",
    "clarificationMode": "fail"
  },
  "defaults": {
    "maxSteps": 30,
    "toolTimeoutMs": 120000,
    "modelTimeoutMs": 300000,
    "requireApprovalForWriteTools": true
  },
  "triggers": [
    {
      "id": "inbox",
      "type": "filesystem",
      "inboxDir": "./agent_inbox",
      "pattern": "*.md",
      "pollIntervalMs": 30000,
      "stabilityDelayMs": 1000
    }
  ]
}
```

The supervisor creates and manages this layout:

```text
agent_inbox/
  pending/      # Put new .md task files here.
  processing/   # Files claimed by active runs.
  processed/    # Files whose runs succeeded.
  failed/       # Failed, interrupted, approval, or clarification cases.
  .ambient/
    tasks.jsonl # Append-only task ledger.
```

For example:

```bash
mkdir -p agent_inbox/pending
printf '%s\n' 'Summarize the release changes in CHANGELOG.md.' \
  > agent_inbox/pending/release-summary.md
adaptive-agent ambient start --config ./ambient.config.json
```

`inboxDir` is relative to `workspaceRoot`; the legacy-equivalent field name
`path` is also accepted. `pattern` supports `*` wildcards and defaults to
`*.md`. The supervisor waits `stabilityDelayMs` after detecting a file and
only claims it if its size and modification time remain unchanged.

### Ambient cron config

This complete example starts one run at 8:00 AM every weekday in New York:

```json
{
  "version": 1,
  "workspaceRoot": ".",
  "artifactsRoot": "./artifacts/ambient",
  "agent": "./agents/daily-summary-agent.json",
  "settings": "./agent.settings.json",
  "runtime": {
    "mode": "sqlite"
  },
  "interaction": {
    "approvalMode": "reject",
    "clarificationMode": "fail"
  },
  "defaults": {
    "maxSteps": 30,
    "toolTimeoutMs": 120000,
    "modelTimeoutMs": 300000,
    "requireApprovalForWriteTools": true
  },
  "triggers": [
    {
      "id": "weekday-repo-summary",
      "type": "cron",
      "schedule": "0 8 * * MON-FRI",
      "timezone": "America/New_York",
      "goalFile": "./tasks/weekday-repo-summary.md",
      "artifactPath": "artifacts/ambient/weekday-repo-summary/{{yyyyMMdd}}-{{HH}}{{mm}}",
      "pollIntervalMs": 30000,
      "concurrency": 1,
      "misfirePolicy": "skip"
    }
  ]
}
```

The `schedule` is a five-field cron expression: minute, hour, day of month,
month, and day of week. Lists, ranges, steps, three-letter month/weekday names,
and `0` or `7` for Sunday are supported. `timezone` must be an IANA timezone
and defaults to `UTC`.

Use exactly one of `goalFile` or an inline `goal`:

```json
{
  "goal": "Review the repository and write today's engineering status summary."
}
```

`goalFile` is relative to `workspaceRoot` and is read for each occurrence.
`artifactPath` is also relative to `workspaceRoot` and supports `{{taskId}}`,
`{{occurrenceId}}`, `{{triggerId}}`, `{{scheduledAt}}`, `{{yyyy}}`, `{{MM}}`,
`{{dd}}`, `{{HH}}`, `{{mm}}`, and `{{yyyyMMdd}}`. Cron task ledgers are stored
under `<artifactsRoot>/.ambient/`. The current release supports only
`concurrency: 1` and `misfirePolicy: "skip"`; missed occurrences are not run
later.

For both trigger types, `workspaceRoot`, `agent`, and `settings` paths are
resolved relative to the ambient config file. A bare `agent` value such as
`"news-bulletin-agent"` selects a discoverable agent by name. `runtime.mode`
accepts `memory`, `sqlite`, or `postgres`. The safe unattended defaults are
`approvalMode: "reject"` and `clarificationMode: "fail"`; approval or
clarification requests therefore finish the ambient task without blocking the
supervisor. Validate the config and inspect its resolved paths and defaults
before starting:

```bash
adaptive-agent ambient start --config ./ambient.config.json --dry-run
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

## Preparing handler-backed skills

A skill can expose a scoped tool by declaring a handler in `SKILL.md`:

```text
my-skill/
|-- SKILL.md
|-- handler.ts
|-- package.json
`-- bun.lock
```

```md
---
name: my-skill
description: Run the custom skill handler
handler: handler.ts
---

Use the handler to complete the delegated objective.
```

Put packages imported by `handler.ts` in the skill's `package.json`, then
install them in the skill directory or an enclosing project. AdaptiveAgent
prepares referenced handlers automatically when it loads an agent. You can
also prepare and validate one explicitly:

```bash
adaptive-agent skill prepare ./skills/my-skill
adaptive-agent skill prepare ./skills/my-skill --force
```

Preparation uses the Bun runtime embedded in the binary CLI or `agent-runtime`
sidecar. It compiles TypeScript, bundles ordinary JavaScript dependencies, and
writes a platform-specific, content-addressed artifact under
`~/.adaptiveAgent/cache/skill-handlers`. The CLI and desktop sidecars use the
same Agent SDK preparation path and resolve skills by absolute path, so sidecar
behavior does not depend on its working directory.

Some dependencies cannot be bundled safely, including native `.node` addons,
packages that discover modules dynamically, and packages that require files or
executables beside `node_modules`. Keep those dependencies materialized beside
the skill and select package mode in the skill's `package.json`:

```json
{
  "type": "module",
  "dependencies": {
    "native-or-dynamic-package": "1.2.3"
  },
  "adaptiveAgent": {
    "handlerMode": "package"
  }
}
```

In package mode, the handler is loaded from the skill directory and normal
module resolution finds its local or enclosing `node_modules`. The dependency
must be compatible with Bun and with the sidecar's operating system and CPU.

### Skills preparation do's and don'ts

Do:

- Commit `package.json` and a lockfile with the skill source.
- Declare every runtime dependency used by the handler.
- Run `adaptive-agent skill prepare <dir>` before selecting or running a new
  handler-backed skill; automatic preparation remains a startup fallback.
- Use the default bundled mode for portable JavaScript and TypeScript packages.
- Use package mode for native addons, dynamic module loading, or package-owned
  runtime assets, and test it on every target platform.
- Treat handler code and dependencies as trusted executable code. A handler
  runs with the permissions of the CLI or sidecar process.

Don't:

- Expect a package embedded inside the AdaptiveAgent binary to be visible to an
  external handler. Handler dependencies belong to the skill package.
- Expect preparation to download missing dependencies silently. Install or
  vendor them first; missing imports fail with an actionable error.
- Copy only `handler.ts` when the handler depends on `package.json`, a lockfile,
  assets, native modules, or package-mode `node_modules`.
- Share a package-mode artifact across operating systems or CPU architectures
  unless all of its dependencies are platform independent.
- Edit files in `~/.adaptiveAgent/cache/skill-handlers`; change the skill source
  and prepare it again instead.

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
