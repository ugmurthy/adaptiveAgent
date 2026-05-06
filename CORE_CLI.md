# Core CLI Implementation Approach

## Purpose

Create `packages/core-cli` as a local-only CLI host for `@adaptive-agent/core`. The CLI should run an AdaptiveAgent directly in-process without the Fastify gateway, WebSocket protocol, JWT auth, gateway sessions, channel routing, or gateway-owned stores.

The CLI keeps the agent definition in JSON so that each invocation can load a stable agent profile. The JSON defines the model, system instructions, allowed tool names, delegate names, workspace root, and runtime defaults. The CLI is responsible for resolving those names into executable core tools and delegate definitions before creating the core agent.

No model token streaming is in scope for the first implementation. The CLI may print lifecycle progress from persisted core events, but final assistant output is printed only after `agent.run(...)`, `agent.chat(...)`, or `agent.resume(...)` returns.

## High-Level Shape

```text
packages/core-cli/
|- package.json
|- tsconfig.json
|- README.md
`- src/
   |- index.ts
   |- cli.ts
   |- config.ts
   |- agent-loader.ts
   |- local-modules.ts
   |- render.ts
   `- interactive.ts
```

- `cli.ts` parses command-line arguments and dispatches `run`, `chat`, `resume`, `retry`, and `inspect` commands.
- `config.ts` loads and validates exactly one agent JSON file.
- `agent-loader.ts` converts the loaded JSON into `createAdaptiveAgent(...)` options.
- `local-modules.ts` creates built-in local tools and loads skill delegates from local directories.
- `render.ts` formats results, approvals, clarification requests, failures, and optional event timelines.
- `interactive.ts` owns prompt loops for chat mode, approval resolution, and clarification answers.

The package should depend on `@adaptive-agent/core` and small CLI/UI libraries only. It should not depend on `@adaptive-agent/gateway-fastify` for runtime behavior, although it can copy or later share config parsing code if useful.

## Execution Model

The CLI creates a core agent per process invocation:

```diagram
╭─────────────╮     ╭─────────────────╮     ╭────────────────────╮
│ CLI argv/env│────▶│ agent JSON file │────▶│ validated config    │
╰─────────────╯     ╰─────────────────╯     ╰─────────┬──────────╯
                                                       │
                                                       ▼
╭────────────────╮     ╭─────────────────╮     ╭────────────────────╮
│ local skills   │────▶│ module resolver │────▶│ createAdaptiveAgent │
╰────────────────╯     ╰────────┬────────╯     ╰─────────┬──────────╯
                                │                        │
╭────────────────╮              │                        ▼
│ built-in tools │──────────────╯                 ╭──────────────╮
╰────────────────╯                                │ core runtime │
                                                  ╰──────┬───────╯
                                                         │
                                                         ▼
                                                  ╭──────────────╮
                                                  │ CLI output   │
                                                  ╰──────────────╯
```

For v1, the CLI should assume one active local user and one active agent process. It should not implement gateway concepts such as tenant routing, roles, bindings, channel fanout, reconnect protocol, scheduled ingress, or multi-session transcript management.

## Agent Config Selection

The CLI loads one agent. It should be explicit about which agent JSON file is used and print the resolved path at startup.

Use this precedence order:

1. `--agent <path>` or `--agent-config <path>` on the command line.
2. `ADAPTIVE_AGENT_CONFIG` environment variable.
3. `./agent.json` in the current working directory.
4. `~/.adaptiveAgent/agents/default-agent.json` as the conventional local default.

If none of these paths exists, fail with a clear error that shows the lookup order and an example minimal config. Do not scan a directory and choose from multiple agents in v1; that would reintroduce gateway-style routing and ambiguity. A future `--agent-id <id> --agent-dir <dir>` mode can be added later, but the first version should keep the contract to one concrete JSON path.

Recommended command examples:

```bash
bun run packages/core-cli/src/cli.ts --agent ./agents/researcher.json run "Summarize this repo"
ADAPTIVE_AGENT_CONFIG=./agents/local.json bun run packages/core-cli/src/cli.ts chat
bun run packages/core-cli/src/cli.ts --agent ~/.adaptiveAgent/agents/default-agent.json resume <run-id>
```

## Agent JSON Contract

Reuse the current gateway agent config shape where practical so existing agent definitions remain portable:

```json
{
  "id": "local-agent",
  "name": "Local Agent",
  "invocationModes": ["chat", "run"],
  "defaultInvocationMode": "run",
  "model": {
    "provider": "ollama",
    "model": "qwen3.5"
  },
  "workspaceRoot": "$HOME/riding-amp/AgentSmith",
  "systemInstructions": "You are a local coding assistant.",
  "tools": ["read_file", "list_directory", "write_file", "shell_exec"],
  "delegates": ["file-analyst"],
  "defaults": {
    "maxSteps": 30,
    "toolTimeoutMs": 30000,
    "modelTimeoutMs": 120000,
    "capture": "summary"
  }
}
```

Fields to support in v1:

- `id`: stable local agent identifier used in logs and metadata.
- `name`: display name.
- `invocationModes`: allowed modes, `chat` and/or `run`.
- `defaultInvocationMode`: default command when the user does not specify `run` or `chat`.
- `model`: core `ModelAdapterConfig` for `ollama`, `openrouter`, `mistral`, or `mesh`.
- `workspaceRoot`: root for local file and shell tools. Expand `$HOME`, `${HOME}`, and normal environment variables.
- `systemInstructions`: optional root system prompt.
- `tools`: names resolved by the local module resolver.
- `delegates`: names resolved from local skills or explicitly registered delegates.
- `defaults`: passed to core as agent runtime defaults.
- `metadata`: optional JSON object copied into run metadata.

The local CLI should ignore gateway-only fields such as `routing` rather than enforcing them. If a config contains `routing`, print a debug-level note only when verbose mode is enabled.

## Tool And Delegate Resolution

Agent JSON should reference tools by name. The resolver converts those names into executable core `ToolDefinition` objects.

Built-in tool names for v1:

- `read_file`
- `list_directory`
- `write_file`
- `shell_exec`
- `web_search`
- `read_web_page`

Resolution rules:

- Create file tools with `workspaceRoot` as `allowedRoot`.
- Create `shell_exec` with `workspaceRoot` as `cwd` unless a later config field explicitly overrides shell cwd.
- Enable `web_search` only when the requested provider can be configured locally.
- Use `WEB_SEARCH_PROVIDER=duckduckgo` by default for local use unless `BRAVE_SEARCH_API_KEY` is present and `WEB_SEARCH_PROVIDER=brave` is requested.
- If the agent JSON references an unavailable tool, fail during startup with the missing tool name and the registered tool names.

Delegates should be loaded from local skills and converted through core skill-to-delegate support. Suggested delegate lookup order:

1. `--skills-dir <path>` if provided.
2. `ADAPTIVE_AGENT_SKILLS_DIR` if set.
3. `./skills` in the current working directory.
4. `~/.adaptiveAgent/skills`.
5. `examples/skills` only when `--allow-example-skills` is passed.

For v1, only load delegate skills whose names are listed in the agent JSON. Skip unreferenced skills. If a referenced delegate cannot be loaded or requires tools that are not available to the root agent, fail before running the model.

## Runtime Stores

Default to in-memory runtime stores for the first implementation. This is enough for a single local command or an interactive process because the core helper creates in-memory `runStore`, `eventStore`, and `snapshotStore` automatically.

Support optional Postgres runtime stores only as an advanced mode:

```bash
bun run packages/core-cli/src/cli.ts --agent ./agent.json --runtime postgres run "..."
```

Postgres mode should use the existing core Postgres runtime store bundle and migrations. This gives restart-safe `resume`, `retry`, run snapshots, child runs, and event history. Do not add a gateway file store to this package; gateway file stores persist gateway sessions and transcripts, not full core runtime state.

## Commands

Initial commands:

```bash
core-agent run <goal>
core-agent chat
core-agent chat <message>
core-agent resume <run-id>
core-agent retry <run-id>
core-agent inspect <run-id>
core-agent config
```

Command behavior:

- `run <goal>` calls `agent.run({ goal, metadata })`.
- `chat` starts a local in-process transcript loop and calls `agent.chat({ messages, metadata })` for each turn.
- `chat <message>` sends one chat turn and exits.
- `resume <run-id>` calls `agent.resume(runId)` and prints the result.
- `retry <run-id>` calls `agent.retry(runId)` and prints the result.
- `inspect <run-id>` prints run details and event timeline from the runtime stores.
- `config` prints the resolved agent config path, model, tools, delegates, workspace root, and runtime store mode.

If no command is provided, use `defaultInvocationMode` from the agent JSON. If that mode is `run`, read the goal from positional args, stdin, or an interactive prompt. If that mode is `chat`, start the chat loop.

## Approval And Clarification Flow

Core may return `approval_requested` or `clarification_requested`. The CLI should keep the process alive and handle those states directly:

- If `approval_requested`, prompt `Approve tool "<toolName>"? [y/N]`, call `agent.resolveApproval(runId, approved)`, then call `agent.resume(runId)` when approved.
- If `clarification_requested`, prompt for an answer and call `agent.resolveClarification(runId, answer)`.
- If `--auto-approve` is passed, set `defaults.autoApproveAll = true` for this invocation.
- If stdin is non-interactive and approval is requested without `--auto-approve`, fail with a message explaining how to rerun safely.

This mirrors the existing example runner but should be packaged as a reusable CLI rather than a demo script.

## Non-Streaming Output

No token streaming should be implemented in v1. The CLI should render at these points:

- Startup summary: config path, model, workspace root, tools, delegates.
- Optional event progress: one-line lifecycle events from `eventStore.subscribe(...)` when `--events` is enabled.
- Approval and clarification prompts when core returns an interactive status.
- Final result, failure, or terminal status after the core method resolves.

This preserves a TUI-like sense of progress without changing core's current event-first runtime into a streaming model-token runtime.

## Package Scripts And Binary

`packages/core-cli/package.json` should expose a binary and Bun-native scripts:

```json
{
  "name": "@adaptive-agent/core-cli",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "bin": {
    "core-agent": "./src/cli.ts",
    "adaptive-agent-core": "./src/cli.ts"
  },
  "scripts": {
    "build": "bun build ./src/index.ts ./src/cli.ts --outdir dist --target bun",
    "test": "bunx vitest run",
    "typecheck": "bunx tsc --noEmit"
  },
  "dependencies": {
    "@adaptive-agent/core": "workspace:*"
  }
}
```

Add root scripts only after the package works, for example:

```json
{
  "core:cli": "bun run ./packages/core-cli/src/cli.ts"
}
```

## Implementation Phases

### Phase 1: Minimal Direct Runner

- Create `packages/core-cli` package and binary entrypoint.
- Load one agent config using the selection precedence above.
- Resolve built-in local tools from `workspaceRoot`.
- Create `@adaptive-agent/core` agent with in-memory runtime stores.
- Implement `run <goal>`, `chat <message>`, and final result rendering.
- Add config validation tests and one CLI smoke test with a fake model adapter if practical.

### Phase 2: Interactive Local UX

- Add interactive `chat` loop.
- Add approval and clarification handling.
- Add `--auto-approve`, `--events`, `--verbose`, and `config` command.
- Load local skills as delegate profiles and validate missing tools early.
- Reuse existing terminal formatting patterns where helpful, but avoid WebSocket/session code.

### Phase 3: Durable Local Runs

- Add optional Postgres runtime store mode.
- Add `resume`, `retry`, and `inspect` commands backed by durable stores.
- Add migration helper or startup check for core runtime tables.
- Document local-only durability tradeoffs clearly.

### Phase 4: Optional TUI Shell

- Reuse the existing TUI visual components only after the direct CLI path is stable.
- Replace the gateway WebSocket event loop with direct core method calls and direct event-store subscriptions.
- Keep no-streaming behavior: display event progress and final output, not model token deltas.

## Explicit Non-Goals

- No backend gateway.
- No WebSocket protocol.
- No JWT auth, tenant routing, channels, bindings, or gateway sessions.
- No model token streaming in v1.
- No directory scan that auto-selects among multiple agents.
- No scheduler or cron ingress.
- No new first-class executable primitive besides core `ToolDefinition`.

## Open Design Decisions

- Whether to keep config parsing independent in `packages/core-cli` or share a small config package with the gateway later.
- Whether `workspaceRoot` should be required for local file tools or default to `process.cwd()`.
- Whether API keys should be read only from environment variables or allowed inline in local-only JSON. For safety and portability, environment variables are preferred.
- Whether a future local file-backed runtime store is worth implementing. For v1, in-memory plus optional Postgres is simpler and aligns with existing core contracts.
