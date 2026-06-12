# @adaptive-agent/core

`@adaptive-agent/core` is the runtime API for AdaptiveAgent. It owns runs, sessions, child runs, tools, model calls, persistence contracts, events, snapshots, retries, continuation, and low-level orchestration primitives.

Use this package when you are embedding an agent runtime in an application. If you only need a shell command that loads `agent.json`, use `@adaptive-agent/agent-sdk`.

## API at a glance

The package entrypoint exports:

- `AdaptiveAgent`: the main run-oriented runtime class.
- `createAdaptiveAgent(options)`: convenience constructor that resolves model config, creates default in-memory stores, merges skills into delegates, and returns `{ agent, runtime }`.
- `createAdaptiveAgentRuntime(options?)`: builds a runtime store bundle, defaulting to in-memory stores.
- Store implementations: in-memory stores and Postgres-backed runtime stores.
- Model adapters: `createModelAdapter`, `OpenRouterAdapter`, `OllamaAdapter`, `MistralAdapter`, and `MeshAdapter`.
- Tool factories: `createReadFileTool`, `createListDirectoryTool`, `createWriteFileTool`, `createShellExecTool`, `createWebSearchTool`, and `createReadWebPageTool`.
- Skill helpers: `loadSkillFromDirectory`, `skillToDelegate`, and related skill types.
- Orchestration helpers: `SwarmCoordinator` and delegation support.
- Runtime contracts from `types.ts`, including `RunRequest`, `RunResult`, `ToolDefinition`, `ModelAdapter`, `RunStore`, `EventStore`, `SnapshotStore`, `PlanStore`, `ContinuationStore`, `AgentEvent`, and `AgentRun`.

The central boundary is simple: `ToolDefinition` is the only first-class executable primitive. Plans, delegates, skills, and swarms eventually execute through tools and normal runs.

## Runtime model

```text
host application
  |
  | createAdaptiveAgent(...)
  v
AdaptiveAgent
  |- model adapter: generate messages and tool calls
  |- tools: typed executable capabilities
  |- runStore: durable run records and leases
  |- eventStore: ordered audit log
  |- snapshotStore: resumable execution state
  |- continuationStore: failed-run recovery lineage
  `- optional planStore and toolExecutionStore
```

Important runtime concepts:

- A `run` is the durable execution unit. Every `run()` and `chat()` call creates or advances a run record.
- `sessionId` groups related runs.
- `RunResult` is a union: `success`, `failure`, `approval_requested`, or `clarification_requested`.
- Approval and clarification are explicit states. Hosts resolve them with `resolveApproval()` and `resolveClarification()`.
- `resume(runId)` continues the same non-terminal run from stored state.
- `retry(runId)` retries a failed run in place when policy allows.
- `continueRun(options)` creates a new linked continuation run after safe recovery analysis.

## Simple use case: one model-only run

Use `createAdaptiveAgent()` when you want the smallest embedded runtime. With no custom runtime provided, core creates in-memory run, event, snapshot, and continuation stores.

```ts
import { createAdaptiveAgent } from "@adaptive-agent/core";

const { agent } = createAdaptiveAgent({
  model: {
    provider: "ollama",
    model: "llama3.2",
  },
  tools: [],
  defaults: {
    maxSteps: 4,
    capture: "summary",
  },
});

const result = await agent.run({
  goal: "Explain what AdaptiveAgent core is in three concise bullets.",
  outputSchema: {
    type: "object",
    properties: {
      bullets: {
        type: "array",
        items: { type: "string" },
        minItems: 3,
        maxItems: 3,
      },
    },
    required: ["bullets"],
    additionalProperties: false,
  },
});

if (result.status !== "success") {
  throw new Error(`Run did not complete: ${JSON.stringify(result)}`);
}

console.log(result.output);
```

Use this shape for local prototypes, simple summarization, and tests that do not need durable storage.

## Medium use case: typed tool plus structured output

Tools are regular TypeScript objects with an input schema, optional output schema, and an `execute()` function. Core validates and executes model-selected tools inside a run.

```ts
import {
  createAdaptiveAgent,
  type ToolDefinition,
} from "@adaptive-agent/core";

type TicketLookupInput = {
  id: string;
};

type TicketLookupOutput = {
  id: string;
  severity: "low" | "medium" | "high";
  owner: string;
  summary: string;
};

const lookupTicket: ToolDefinition<TicketLookupInput, TicketLookupOutput> = {
  name: "lookup_ticket",
  description: "Look up one support ticket by id.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
    },
    required: ["id"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      severity: { enum: ["low", "medium", "high"] },
      owner: { type: "string" },
      summary: { type: "string" },
    },
    required: ["id", "severity", "owner", "summary"],
    additionalProperties: false,
  },
  async execute(input, context) {
    console.log(`Executing ${context.toolCallId} in run ${context.runId}`);

    return {
      id: input.id,
      severity: "high",
      owner: "platform-oncall",
      summary: "Checkout latency is above the incident threshold.",
    };
  },
};

const { agent, runtime } = createAdaptiveAgent({
  model: {
    provider: "openrouter",
    model: "qwen/qwen3.5-27b",
    apiKey: process.env.OPENROUTER_API_KEY!,
  },
  tools: [lookupTicket],
  defaults: {
    maxSteps: 12,
    toolTimeoutMs: 30_000,
    capture: "summary",
  },
});

const result = await agent.run({
  sessionId: "incident-204",
  goal: "Assess ticket INC-204 and return the escalation decision.",
  input: { ticketId: "INC-204" },
  allowedTools: ["lookup_ticket"],
  outputSchema: {
    type: "object",
    properties: {
      escalate: { type: "boolean" },
      owner: { type: "string" },
      rationale: { type: "string" },
    },
    required: ["escalate", "owner", "rationale"],
    additionalProperties: false,
  },
});

const events = await runtime.eventStore.listByRun(result.runId);

console.log(result);
console.log(events.map((event) => event.type));
```

Use this shape when your host application supplies business capabilities as tools and wants core to manage model/tool turns, eventing, and result states.

## Complex use case: durable runtime, approvals, delegates, and recovery

Production hosts should provide durable stores. Core includes Postgres store implementations and migrations; the host supplies a compatible client or pool.

```ts
import { Pool } from "pg";
import {
  POSTGRES_RUNTIME_MIGRATIONS,
  createAdaptiveAgent,
  createListDirectoryTool,
  createPostgresRuntimeStores,
  createReadFileTool,
  createShellExecTool,
  type DelegateDefinition,
  type RunResult,
} from "@adaptive-agent/core";

const workspaceRoot = process.cwd();
const pool = new Pool({ connectionString: process.env.DATABASE_URL! });

for (const migration of POSTGRES_RUNTIME_MIGRATIONS) {
  await pool.query(migration.sql);
}

const stores = createPostgresRuntimeStores({ client: pool });

const repoAuditor: DelegateDefinition = {
  name: "repo-auditor",
  description: "Read-only repository auditor for focused file and directory inspection.",
  instructions: "Inspect only the files needed to answer the parent run. Keep findings brief and cite file paths.",
  allowedTools: ["read_file", "list_directory"],
  defaults: {
    maxSteps: 20,
    capture: "summary",
  },
};

const { agent } = createAdaptiveAgent({
  model: {
    provider: "openrouter",
    model: "qwen/qwen3.5-27b",
    apiKey: process.env.OPENROUTER_API_KEY!,
  },
  tools: [
    createReadFileTool({ allowedRoot: workspaceRoot }),
    createListDirectoryTool({ allowedRoot: workspaceRoot }),
    createShellExecTool({ cwd: workspaceRoot }),
  ],
  delegates: [repoAuditor],
  delegation: {
    maxDepth: 1,
    maxChildrenPerRun: 3,
    childRunsMayRequestApproval: false,
    childRunsMayRequestClarification: false,
  },
  runtime: stores,
  eventSink: {
    emit(event) {
      console.log(`[${event.type}] run=${event.runId}`);
    },
  },
  defaults: {
    maxSteps: 50,
    modelTimeoutMs: 90_000,
    toolTimeoutMs: 60_000,
    requireApprovalForWriteTools: true,
    autoApproveAll: false,
    capture: "summary",
    toolBudgets: {
      shell_exec: {
        maxCalls: 2,
        onExhausted: "fail",
      },
    },
  },
  recovery: {
    continuation: {
      enabled: true,
      defaultStrategy: "hybrid_snapshot_then_step",
      requireUserApproval: true,
    },
    retryableErrorCodes: ["MODEL_ERROR", "INTERRUPTED"],
    fallbackModels: [
      {
        provider: "openrouter",
        model: "qwen/qwen3.5-27b",
        whenFailureClass: ["provider_transient"],
      },
    ],
  },
  systemInstructions: "Prefer tool-grounded findings and concise final answers.",
});

async function finish(result: RunResult): Promise<RunResult> {
  if (result.status === "approval_requested") {
    console.log(`Approval requested for ${result.toolName}: ${result.message}`);
    await agent.resolveApproval(result.runId, true);
    return finish(await agent.resume(result.runId));
  }

  if (result.status === "clarification_requested") {
    return finish(await agent.resolveClarification(
      result.runId,
      "Focus on production runtime risks and ignore generated build artifacts.",
    ));
  }

  if (result.status === "failure") {
    const recovery = await agent.getRecoveryOptions(result.runId);
    if (recovery.continuable) {
      return finish(await agent.continueRun({
        fromRunId: result.runId,
        strategy: recovery.recommendedStrategy,
        provider: recovery.recommendedProvider,
        model: recovery.recommendedModel,
        requireApproval: true,
      }));
    }
  }

  return result;
}

try {
  const initial = await agent.run({
    sessionId: "release-audit-2026-06",
    goal: "Audit this repository for high-risk release blockers and produce a prioritized action list.",
    allowedTools: ["read_file", "list_directory", "shell_exec", "delegate.repo-auditor"],
    context: {
      release: "2026.06",
      riskTolerance: "low",
    },
    metadata: {
      source: "release-dashboard",
    },
  });

  const final = await finish(initial);
  console.log(final);
} finally {
  await pool.end();
}
```

Use this shape when you need durable execution semantics: events, snapshots, leases, tool execution records, explicit interaction states, child runs, and continuation lineage.

## Core methods

| Method | Purpose |
| --- | --- |
| `run(request)` | Start a goal-oriented run. |
| `chat(request)` | Start a run from explicit chat messages. |
| `executePlan(request)` | Execute an already persisted plan from `planStore`. |
| `plan(request)` | Reserved planning surface; current scaffold does not implement plan generation. |
| `interrupt(runId)` | Mark an active run interrupted. |
| `steer(runId, input)` | Queue extra guidance into an active run. |
| `resolveApproval(runId, approved)` | Resolve a run paused for an approval-gated tool. |
| `resolveClarification(runId, message)` | Provide missing user input and continue the run. |
| `resume(runId)` | Continue the same run from persisted state. |
| `retry(runId)` | Retry the same failed run when policy allows. |
| `getRecoveryOptions(runId)` | Analyze whether a failed run can continue safely. |
| `continueRun(options)` | Create and execute a new linked continuation run. |
| `createContinuationRun(options)` | Create the continuation run record without executing it. |

## Result handling pattern

Always branch on `result.status`.

```ts
const result = await agent.run({ goal: "Draft a release summary." });

switch (result.status) {
  case "success":
    console.log(result.output);
    break;
  case "approval_requested":
    console.log(result.toolName, result.message);
    break;
  case "clarification_requested":
    console.log(result.message, result.suggestedQuestions);
    break;
  case "failure":
    console.error(result.code, result.error);
    break;
}
```

## Built-in runtime pieces

### Stores

- In-memory stores are useful for tests and local prototypes.
- Postgres stores are useful for durable production runs and expose `runStore`, `eventStore`, `snapshotStore`, `planStore`, `continuationStore`, `toolExecutionStore`, and transaction support.
- `POSTGRES_RUNTIME_MIGRATIONS` contains the SQL required for the Postgres runtime schema.

### Model adapters

`createModelAdapter(config)` supports:

- `openrouter`
- `ollama`
- `mistral`
- `mesh`

You can also supply your own `ModelAdapter` implementation directly in `createAdaptiveAgent({ model })`.

### Tools

Built-in tool factories are opt-in. Core never grants file, shell, or web access unless the host registers the corresponding tool.

- `createReadFileTool({ allowedRoot })`
- `createListDirectoryTool({ allowedRoot })`
- `createWriteFileTool({ allowedRoot })`
- `createShellExecTool({ cwd })`
- `createWebSearchTool({ provider, apiKey })`
- `createReadWebPageTool({ timeoutMs })`

Custom tools should keep `inputSchema` strict and return JSON-serializable outputs.

### Delegates and swarms

- A `DelegateDefinition` becomes a synthetic `delegate.<name>` tool exposed to the parent run.
- Child runs are normal core runs with `parentRunId`, `rootRunId`, `delegateName`, and delegation depth metadata.
- `SwarmCoordinator` is the lower-level core primitive for coordinator, worker, quality, and synthesizer runs. It does not load agent profiles; callers provide already-created `AdaptiveAgent` instances.

## Choosing core vs agent-sdk

Use `@adaptive-agent/core` when:

- your application owns TypeScript code, tools, stores, and model adapters
- you need durable run semantics or custom persistence
- you want to embed approval, clarification, retry, or continuation in your own UI or service
- you need lower-level access to events, snapshots, child runs, or swarm primitives

Use `@adaptive-agent/agent-sdk` when:

- you want a CLI that loads `agent.json`
- built-in file, shell, and web tools are enough
- command-line output modes and config discovery are the main API you need
