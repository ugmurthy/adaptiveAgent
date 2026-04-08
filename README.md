# AdaptiveAgent

AdaptiveAgent is a Bun + TypeScript runtime for goal-oriented AI agents with typed tools, structured events, resumable runs, and bounded delegation to child runs.

This repository currently contains two things:

- living v1.4 product and contract docs
- a working `@adaptive-agent/core` prototype under `packages/core`

The docs describe the intended architecture across `@adaptive-agent/core`, `@adaptive-agent/store-postgres`, and `@adaptive-agent/dashboard-example`. The checked-in code today is focused on the core runtime and examples.

## Current Status

Implemented in the prototype today:

- `run()`, `interrupt()`, `resume()`, and `executePlan()` on the core agent
- typed tool registration and tool-call execution
- synthetic `delegate.*` tools backed by child runs
- in-memory run, event, snapshot, and plan stores for local development
- model adapters for Ollama, OpenRouter, Mistral, and Mesh
- structured runtime logging with Pino
- skill loading from `SKILL.md` files and conversion into delegate profiles
- executable skills with dynamically imported handler modules (handler-as-tool)
- built-in file, shell, and web tools

Not implemented yet:

- `plan()` generation in the runtime scaffold
- the Postgres store package described in the contracts
- the dashboard example package described in the spec

## Repository Layout

```text
.
|- packages/core/                     # runtime prototype
|- examples/run-agent.ts             # end-to-end sample script
|- examples/run-chat.ts              # interactive chat demo
|- examples/skills/                  # sample SKILL.md delegates
|- agen-spec-v1.4.md                 # current product spec
|- agen-contracts-v1.4.md            # current implementation contracts
|- agen-runtime-v1.4-algorithms.md   # runtime behavior notes
|- agen-spec-v1.3.md                 # older spec snapshot
|- agen-contracts-v1.4-multi-agent.md # delegation delta notes
`- artifacts/                        # sample outputs produced by examples
```

## What The Core Package Does

`packages/core` is the executable heart of the repo. Its package entrypoint is `packages/core/src/index.ts`, and that entrypoint re-exports the runtime, stores, adapters, tools, skills, logging helpers, and core contracts used by the prototype.

The delegation model follows the v1.4 design boundary: tools remain the only first-class executable primitive, and delegation is represented as synthetic `delegate.<name>` tools plus normal child runs.

## @adaptive-agent/core API

The workspace-local package entrypoint is `./packages/core/src/index.js`:

```ts
import {
  AdaptiveAgent,
  createAdaptiveAgent,
  createAdaptiveAgentRuntime,
  createListDirectoryTool,
  createModelAdapter,
  createReadFileTool,
} from "./packages/core/src/index.js";
```

### Runtime Surface

- `AdaptiveAgent` is the main runtime class. Its public methods are `run(request)`, `chat(request)`, `resume(runId)`, `interrupt(runId)`, `resolveApproval(runId, approved)`, `executePlan(request)`, and `plan(request)`.
- `createAdaptiveAgent(options)` is the higher-level constructor for the common case: it resolves a model adapter from config when needed, creates default in-memory runtime stores, merges optional `skills` into `delegates`, and returns both `{ agent, runtime }`.
- `createAdaptiveAgentRuntime(options?)` creates the in-memory-backed runtime bundle used by the helper and can also be reused directly when you want explicit access to the stores.
- `plan(request)` is exported, but currently throws because plan generation is not implemented in the scaffold yet.
- `DelegationExecutor`, `DelegationError`, `ExecuteChildRunRequest`, and `ParentResumeResult` are also exported for lower-level delegation orchestration.

### Core Contracts

- The package re-exports the runtime contracts from `src/types.ts`, including `AdaptiveAgentOptions`, `AgentDefaults`, `DelegationPolicy`, `RunRequest`, `ChatRequest`, `ChatMessage`, `PlanRequest`, `ExecutePlanRequest`, `RunResult`, `ChatResult`, `ToolDefinition`, `ToolContext`, `DelegateDefinition`, `ModelAdapter`, `RunStore`, `EventStore`, `SnapshotStore`, `PlanStore`, `AgentRun`, `AgentEvent`, `RunSnapshot`, `PlanStep`, `PlanExecution`, and `UsageSummary`.
- Those types are the implementation-facing API for host applications that want to provide custom tools, stores, model adapters, delegates, or event sinks.

### In-Memory Stores

- `InMemoryRunStore`, `InMemoryEventStore`, `InMemorySnapshotStore`, and `InMemoryPlanStore` are included for local development and examples.
- `OptimisticConcurrencyError` is exported from the run store implementation for callers that want to handle version conflicts explicitly.

### Model Adapters

- `createModelAdapter(config)` creates a `ModelAdapter` for `ollama`, `openrouter`, `mistral`, or `mesh`.
- The concrete adapter classes are also exported: `OllamaAdapter`, `OpenRouterAdapter`, `MistralAdapter`, `MeshAdapter`, and the shared `BaseOpenAIChatAdapter`.
- Related config and error exports are available as part of the public API: `ModelAdapterConfig`, `OllamaAdapterConfig`, `OpenRouterAdapterConfig`, `MistralAdapterConfig`, `MeshAdapterConfig`, `BaseOpenAIChatAdapterConfig`, and `ModelRequestError`.

### Built-In Tool Factories

- `createReadFileTool(config)` creates `read_file`; `ReadFileToolConfig` supports `allowedRoot` and `maxSizeBytes`.
- `createListDirectoryTool(config)` creates `list_directory`; `ListDirectoryToolConfig` supports `allowedRoot`.
- `createWriteFileTool(config)` creates `write_file`; `WriteFileToolConfig` supports `allowedRoot` and `createDirectories`. This tool requires approval.
- `createShellExecTool(config)` creates `shell_exec`; `ShellExecToolConfig` supports `cwd`, `maxOutputBytes`, and `shell`. This tool requires approval.
- `createWebSearchTool(config)` creates `web_search`; `WebSearchToolConfig` supports `provider`, `apiKey`, `maxResults`, `baseUrl`, and `timeoutMs`.
- `createReadWebPageTool(config)` creates `read_web_page`; `ReadWebPageToolConfig` supports `maxSizeBytes`, `maxTextLength`, and `timeoutMs`.

### Skills And Logging

- Skill-loading exports include `loadSkillFromDirectory`, `loadSkillFromFile`, `parseSkillMarkdown`, `skillToDelegate`, `skillsToDelegate`, `SkillLoadError`, `LoadSkillOptions`, and `SkillDefinition`.
- Logging exports include `createAdaptiveAgentLogger`, `DEFAULT_LOG_LEVEL`, `DEFAULT_LOG_DESTINATION`, `captureValueForLog`, `summarizeValueForLog`, `errorForLog`, `runLogBindings`, `summarizeModelRequestForLog`, `summarizeModelResponseForLog`, `captureToolInputForLog`, and `captureToolOutputForLog`.

## Quick Start

Install dependencies:

```bash
bun install
```

Copy the example environment file:

```bash
cp .env.example .env
```

Run the sample agent with Ollama:

```bash
bun run examples/run-agent.ts
```

Run the sample with a custom goal:

```bash
bun run examples/run-agent.ts "Explain the architecture of this repository"
```

Run the interactive chat demo:

```bash
bun run examples/run-chat.ts
CHAT_SYSTEM_PROMPT="You are a terse staff engineer." bun run examples/run-chat.ts
```

Use a hosted provider instead:

```bash
PROVIDER=openrouter OPENROUTER_API_KEY=... bun run examples/run-agent.ts
PROVIDER=mistral MISTRAL_API_KEY=... bun run examples/run-agent.ts
PROVIDER=mesh MESH_API_KEY=... bun run examples/run-agent.ts
```

The sample script:

- builds a provider-specific model adapter
- registers built-in tools
- loads delegates from `examples/skills/`
- runs the agent against your goal
- prints the final result plus run and child-run activity

Additional setup details and environment variable notes live in `examples/README.md`.

## Minimal Repo-Local Example

This repository is a monorepo prototype rather than a published package, so local examples import from the workspace source directly:

```ts
import {
  createAdaptiveAgent,
  createListDirectoryTool,
  createReadFileTool,
} from "./packages/core/src/index.js";

const projectRoot = process.cwd();

const { agent } = createAdaptiveAgent({
  model: {
    provider: "ollama",
    model: process.env.OLLAMA_MODEL ?? "qwen3.5",
  },
  tools: [
    createReadFileTool({ allowedRoot: projectRoot }),
    createListDirectoryTool({ allowedRoot: projectRoot }),
  ],
});

const result = await agent.run({
  goal: "List the top-level files in this repository and summarize their purpose.",
});

console.log(result);
```

For a fuller example with delegates, approvals, provider selection, markdown rendering, and optional web tools, see `examples/run-agent.ts`.

For a minimal multi-turn chat loop that passes transcript messages into `agent.chat(...)`, see `examples/run-chat.ts`.

## Skills And Delegation

The sample runtime can load skills from Markdown files with YAML frontmatter:

```text
examples/skills/
|- bmi-calculator/SKILL.md + handler.ts
|- file-analyst/SKILL.md
|- researcher/SKILL.md
`- shell-exec/SKILL.md
```

Each skill is parsed into a `SkillDefinition` and then converted into a delegate profile. At runtime, that profile is exposed to the model as a synthetic tool such as `delegate.file-analyst` or `delegate.researcher`.

### Executable Skills (Handler-as-Tool)

Skills can optionally include a `handler` field in their frontmatter that points to a TypeScript module. When set, the module is dynamically imported at load time and exposed as a scoped tool inside the child run. This lets skills bundle deterministic code alongside LLM-driven reasoning.

Example `SKILL.md` with a handler:

```yaml
---
name: bmi-calculator
description: Calculate BMI from height (cm) and weight (kg)
handler: handler.ts
allowedTools:
  - write_file
---
```

The handler module exports named fields matching the `ToolDefinition` shape:

```ts
export const name = "bmi_calculate";
export const description = "Calculate BMI from height and weight";
export const inputSchema = {
  /* JSON Schema */
};
export async function execute(input, context) {
  // deterministic computation
  return { bmi: 22.5, category: "Normal weight" };
}
```

When the child run executes, the LLM can call both the handler tool (`bmi_calculate`) and any host tools listed in `allowedTools` (`write_file`). The handler tool name defaults to `skill.<name>.handler` if the module does not export a `name`.

A working example is included at `examples/skills/bmi-calculator/`.

This keeps delegation aligned with the core design:

- the planner still chooses tools
- child work happens in a separate run
- parent and child runs keep separate events and snapshots
- the parent resumes only after the child returns a structured result
- handler tools are just `ToolDefinition` instances — no new execution primitive

## Built-In Tools

The prototype includes several built-in tools for local experiments:

- `read_file`
- `list_directory`
- `write_file`
- `shell_exec`
- `web_search`
- `read_web_page`

`write_file` and `shell_exec` require approval. The example script supports interactive approval and an `--auto-approve` mode for non-interactive runs.

The web tools support:

- Brave Search with an API key
- DuckDuckGo without an API key
- recoverable error outputs so the model can continue after soft web failures

## Specs And Contracts

The current source-of-truth docs are:

- `agen-spec-v1.4.md` for product behavior and scope
- `agen-contracts-v1.4.md` for TypeScript interfaces, event types, and schema boundaries
- `agen-runtime-v1.4-algorithms.md` for execution and delegation behavior notes

Historical and transition docs are also checked in for comparison:

- `agen-spec-v1.md`
- `agen-spec-v1.3.md`
- `agen-contracts-v1.3.md`
- `agen-contracts-v1.4-multi-agent.md`

If code and docs disagree, treat the v1.4 spec and contract docs as the intended design, and treat the current implementation as the executable prototype that is still catching up.

## Development

Build the core package:

```bash
cd packages/core
bun run build
```

Run the test suite:

```bash
cd packages/core
bun test
```

The root workspace is mostly a container for docs, examples, and the `packages/core` prototype. Most implementation work happens inside `packages/core/src`.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
