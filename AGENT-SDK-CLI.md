# Agent SDK CLI Design

This document describes a high-level design for evolving `packages/agent-sdk/src/adaptive-agent.ts` from a manual SDK test runner into a user-facing CLI with useful defaults and first-class support for running GAIA-style benchmarks.

## Current Starting Point

The existing `adaptive-agent.ts` already provides a useful seed:

- loads SDK config through `loadAgentSdkConfig()`;
- creates an SDK instance through `createAgentSdk()`;
- parses JSON run/chat specs;
- supports provider, model, runtime, approval, clarification, event, inspect, and output overrides;
- emits pretty or JSON output;
- warns about provider multimodal capability mismatches.

There is also a lower-level `@adaptive-agent/core-cli` package. The SDK CLI should not replace it. The recommended split is:

- `core-cli`: local-only direct host for `@adaptive-agent/core`, useful for core runtime development;
- `agent-sdk` CLI: user-facing, config-driven, provider/defaults/benchmark oriented.

The SDK CLI can borrow command ideas from `core-cli`, but should route execution through `AgentSdk` so config, tools, delegates, runtime stores, logging, and interactions remain consistent.

## Design Goals

1. Provide one easy command for ad-hoc use:

   ```bash
   adaptive-agent run "Find the answer to this question..."
   adaptive-agent chat
   adaptive-agent run --file question.md --image chart.png
   ```

2. Provide one repeatable command for benchmark execution:

   ```bash
   adaptive-agent eval gaia --input ./gaia/validation.jsonl --out ./runs/gaia-qwen3.jsonl
   ```

3. Keep defaults useful but overrideable:

   - defaults from `agent.json` and `agent.settings.json`;
   - CLI flags override config;
   - benchmark presets supply runtime, output, metadata, and trace defaults.

4. Reuse `AgentSdk` as the only execution boundary:

   - the CLI should stay a thin orchestration layer over `createAgentSdk()`;
   - avoid duplicating core runtime, tool, delegate, approval, or logging setup.

## Proposed Command Shape

```text
adaptive-agent [global options] <command> [command options]

Commands:
  run <goal...>                 Run one task and print the final answer
  chat [message...]             Interactive chat or one-shot chat
  spec <path>                   Run existing JSON spec format
  eval gaia                     Run a GAIA-format benchmark set
  inspect <run-id>              Inspect run/event summary
  resume <run-id>               Resume persisted run
  retry <run-id>                Retry persisted failed run
  config                        Print resolved config
  init                          Generate starter agent/settings config
```

The current manual test flow becomes `spec <path>`, while `run` and `eval gaia` provide more ergonomic user and benchmark workflows.

## Global Options

Global options should map directly to existing SDK config concepts:

```text
--cwd <path>
--agent <path>
--settings <path>
--runtime memory|postgres
--provider openrouter|ollama|mistral|mesh
--model <name>
--base-url <url>
--api-key-env <name>

--approval auto|manual|reject
--clarification interactive|fail
--events
--inspect
--output pretty|json|jsonl
--log-file <path>
--metadata key=value
```

Recommended defaults:

| Setting | Ad-hoc default | GAIA default |
| --- | --- | --- |
| Runtime | `memory` | `postgres` if `DATABASE_URL` exists, else `memory` |
| Approval | `manual` unless config says otherwise | `auto` or `reject`, depending tool policy |
| Clarification | `interactive` | `fail` |
| Output | `pretty` | `jsonl` |
| Events | off | captured to artifact file |
| Inspect | off | summary only |
| Metadata | agent/model/runtime | dataset/task ids/model/runtime/git sha |

## `adaptive-agent run`

Primary human-friendly command.

Examples:

```bash
adaptive-agent run "Summarize this repository"
adaptive-agent run --file ./prompt.md
adaptive-agent run --input-json '{"question":"...","level":2}'
adaptive-agent run --image ./diagram.png "Answer the question using the image"
adaptive-agent run --output json "What is 2+2?"
```

Behavior:

- accept goal from positional args, `--file`, or stdin;
- support repeatable attachments such as `--image <path>`;
- support an advanced `--content-part <json>` escape hatch;
- internally build the same request shape currently used by the spec runner: `goal`, `input`, `images`, `contentParts`, `context`, `outputSchema`, and `metadata`;
- call `sdk.run(goal, options)`.

Useful default output:

```text
✓ completed run 01J...
model: openrouter/openai/gpt-4.1
steps: 12
tools: read_file x3, web_search x2

Answer:
...
```

For `--output json`, use stable fields:

```json
{
  "status": "completed",
  "runId": "...",
  "output": "...",
  "usage": {},
  "events": {},
  "metadata": {}
}
```

## `adaptive-agent spec <path>`

This command preserves the current `--spec` flow, promoted to a subcommand.

Current style:

```bash
adaptive-agent --spec ./specs/all-types.json --events --inspect
```

Proposed style:

```bash
adaptive-agent spec ./specs/all-types.json --events --inspect
```

Keep the existing JSON spec parser and provider capability warnings. This command remains useful for regression testing multimodal and provider adapter behavior.

## `adaptive-agent eval gaia`

This command runs GAIA-format benchmark sets.

Example:

```bash
adaptive-agent eval gaia \
  --input ./data/gaia-validation.jsonl \
  --out ./runs/gaia-validation-qwen3.jsonl \
  --artifacts ./runs/artifacts \
  --provider openrouter \
  --model openai/gpt-4.1 \
  --runtime postgres \
  --concurrency 1 \
  --resume
```

### GAIA Input Normalization

Support a minimal canonical task format first:

```json
{
  "task_id": "2023_validation_001",
  "Question": "What is ...?",
  "file_name": "abc.png",
  "Level": "1",
  "Final answer": "..."
}
```

Normalize input rows to an internal benchmark case:

```ts
interface BenchmarkCase {
  id: string;
  dataset: 'gaia';
  split?: string;
  level?: string;
  question: string;
  attachments: Array<{ path: string; kind: 'image' | 'file' | 'audio' }>;
  expectedAnswer?: string;
  metadata: Record<string, JsonValue>;
}
```

The benchmark command should not hard-code GAIA details into the generic run path. Keep the flow layered:

```text
GAIA loader -> BenchmarkCase[] -> AgentSdk run loop -> result writer
```

### GAIA Options

```text
--input <path>              JSONL/JSON/CSV input
--files-dir <path>          Directory for GAIA attachments
--out <path>                JSONL result file
--artifacts <dir>           Per-task traces, prompts, outputs
--limit <n>
--offset <n>
--ids <id,id,...>
--level <1|2|3>
--split validation|test
--concurrency <n>           Start with default 1
--resume                    Skip tasks already present in output
--fail-fast
--max-steps <n>
--timeout-ms <n>
--answer-only               Ask model to produce final answer only
--judge exact|llm|none      Optional scoring mode
```

Recommended GAIA defaults:

```text
--clarification fail
--output jsonl
--events captured
--metadata dataset=gaia
--concurrency 1
```

Start with concurrency `1`. The runtime, delegation, and tool execution paths are easier to debug deterministically. Add higher concurrency once output locking, rate limits, and runtime isolation are proven.

## GAIA Result Format

Use append-only JSONL so interrupted benchmark runs can resume safely.

Each line should follow a stable shape:

```ts
interface BenchmarkResultRecord {
  schemaVersion: 1;
  dataset: 'gaia';
  taskId: string;
  level?: string;
  status: 'completed' | 'failed' | 'timeout' | 'skipped';
  runId?: string;
  question: string;
  prediction?: JsonValue;
  predictionText?: string;
  expectedAnswer?: string;
  score?: {
    mode: 'exact' | 'llm' | 'none';
    correct?: boolean;
    reason?: string;
  };
  usage?: JsonObject;
  timings: {
    startedAt: string;
    finishedAt: string;
    durationMs: number;
  };
  model: {
    provider: string;
    model: string;
  };
  runtime: {
    mode: 'memory' | 'postgres';
  };
  artifacts?: {
    eventLog?: string;
    inspection?: string;
    stdout?: string;
    stderr?: string;
  };
  error?: {
    message: string;
    code?: string;
    stack?: string;
  };
  metadata: Record<string, JsonValue>;
}
```

This keeps downstream evaluation simple:

```bash
jq -r '[.taskId, .status, .predictionText] | @tsv' runs.jsonl
```

## Artifact Layout

For benchmark runs, write both a summary ledger and per-task artifacts:

```text
runs/
  gaia-2026-05-14-qwen3/
    results.jsonl
    summary.json
    config.resolved.json
    tasks/
      2023_validation_001/
        input.json
        output.json
        events.jsonl
        inspection.json
        answer.txt
      2023_validation_002/
        ...
```

Reasons:

- `results.jsonl` is the durable benchmark ledger;
- per-task artifacts make failures debuggable;
- `config.resolved.json` captures provider, model, tools, runtime, and defaults for reproducibility.

## Configuration Presets

Add CLI presets as explicit config overlays, not hidden magic.

Examples:

```bash
adaptive-agent eval gaia --preset gaia-default
adaptive-agent eval gaia --preset gaia-web
adaptive-agent eval gaia --preset gaia-no-shell
```

Example preset shape:

```json
{
  "defaults": {
    "maxSteps": 40,
    "capture": "summary"
  },
  "interaction": {
    "approvalMode": "auto",
    "clarificationMode": "fail"
  },
  "tools": [
    "read_file",
    "list_directory",
    "web_search",
    "read_web_page"
  ],
  "systemInstructions": "Answer GAIA questions. Use tools when needed. Return a concise final answer."
}
```

For safety and reproducibility, include the selected preset and fully resolved config in result metadata.

## Suggested Internal Module Split

Keep `adaptive-agent.ts` from becoming a large file:

```text
packages/agent-sdk/src/
  adaptive-agent.ts              # CLI entrypoint + command dispatch
  cli/
    args.ts                      # parse args
    render.ts                    # pretty/json/jsonl rendering
    spec-command.ts              # current spec runner
    run-command.ts               # ad-hoc run/chat
    inspect-command.ts
    eval/
      benchmark-types.ts
      benchmark-runner.ts        # generic case runner
      gaia.ts                    # GAIA loader/normalizer/scorer
      jsonl.ts                   # append/read result records
```

Keep public SDK types in `index.ts`; keep CLI-only benchmark types under `cli/eval`.

## Execution Flow

```text
CLI argv
  -> parse command
  -> resolve SDK config from agent/settings/env/flags
  -> createAgentSdk()
  -> command adapter: run/spec/eval gaia
  -> write pretty/json/jsonl output
```

For GAIA:

```text
GAIA file
  -> normalize cases: id/question/files
  -> resume filter: skip completed ids
  -> per-case sdk.run() with metadata
  -> append result JSONL and write artifacts
  -> summary/scoring
```

## GAIA-Specific Defaults

Recommended GAIA system instruction preset:

```text
You are solving GAIA benchmark tasks.

Use available tools to inspect files and search/read web pages when necessary.
Do not ask the user for clarification.
When you have enough evidence, produce the final answer concisely.
If a question asks for a name, number, date, or short phrase, output only that value.
Do not include reasoning in the final answer unless requested.
```

Recommended default tools:

```json
[
  "read_file",
  "list_directory",
  "web_search",
  "read_web_page"
]
```

Be cautious with `shell_exec` as a default for benchmarks. It can help with files and data processing, but complicates sandboxing and approval policy. Prefer making it opt-in:

```bash
adaptive-agent eval gaia --allow-shell
```

## Phased Implementation Plan

### Phase 1: Make the Current Runner a Real CLI

- Add subcommands: `run`, `chat`, `spec`, `config`.
- Preserve current `--spec` compatibility for one release.
- Add stdin/file prompt support.
- Keep current pretty/json output.

### Phase 2: Add Benchmark Runner Foundation

- Add generic `BenchmarkCase` and `BenchmarkResultRecord`.
- Add append-only JSONL writer.
- Add `--resume`, `--limit`, `--ids`, and `--artifacts`.
- Add per-task metadata and event capture.

### Phase 3: Add `eval gaia`

- Implement GAIA input loader.
- Map question and file attachments into `sdk.run()`.
- Add GAIA preset instructions.
- Add summary output and optional exact-match scoring.

### Phase 4: Harden Real Benchmark Runs

- Recommend or auto-detect durable Postgres runtime.
- Add timeouts.
- Add rate-limit handling.
- Add optional concurrency.
- Add retry policy per task.
- Add provider/model comparison support:

  ```bash
  adaptive-agent eval gaia --matrix models.json
  ```

## Key Recommendation

Treat the CLI as three layers:

1. SDK config/runtime layer, which already mostly exists in `AgentSdk`.
2. Command UX layer: `run`, `chat`, `spec`, and `inspect`.
3. Benchmark orchestration layer: `eval gaia`, result JSONL, artifacts, and resume.

This keeps the current `adaptive-agent.ts` useful for testing while evolving it into a practical command-line harness for GAIA without entangling benchmark logic with the core agent runtime.
