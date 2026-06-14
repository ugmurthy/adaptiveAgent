# Built-in Tools Developer Guide

This directory contains the opt-in built-in tool factories exported by
`@adaptive-agent/core`. A built-in tool is still just a `ToolDefinition`: core
does not register it automatically, and hosts must pass the tool instance in
`AdaptiveAgentOptions.tools`.

Use this guide when adding a new factory under `packages/core/src/tools`.

## 1. Confirm the tool belongs in core

Add a tool to core only when it is a generic runtime capability that can be used
without Agent SDK or CLI concepts. Good core tools are about files, shell,
network fetches, data conversion, or other reusable execution primitives.

Do not add these to core:

- CLI command parsing, profile loading, `agent.json` discovery, or friendly CLI
  prompts.
- Agent SDK-only setup, default agent selection, or delegate catalog logic.
- A default registry that grants access automatically.
- Fields that duplicate agent definitions such as model, instructions,
  delegates, or allowed tools.

If the new tool should be available from Agent SDK, Core CLI, or the Fastify
gateway, add that registration in those packages after the core factory is
implemented and exported.

## 2. Follow the file and naming pattern

Use one file per tool:

```text
packages/core/src/tools/<tool-name>.ts
```

Use these names consistently:

- Public tool name: snake_case, for example `read_file` or `web_search`.
- Factory: `createXTool`, for example `createReadFileTool`.
- Config export: `XToolConfig`.
- Input and output types: keep private unless callers need them.

The existing built-ins export factories, not singleton instances. This keeps
each host in charge of roots, credentials, limits, and timeout choices.

## 3. Implement the factory as a `ToolDefinition`

A small read-only tool should look like this shape:

```ts
import type { ToolDefinition } from '../types.js';

export interface ExampleToolConfig {
  /** Tool timeout in milliseconds. Defaults to 30000. */
  timeoutMs?: number;
}

type ExampleInput = {
  value: string;
  maxLength?: number;
};

type ExampleOutput = {
  value: string;
  length: number;
  truncated?: boolean;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MODEL_RESULT_MAX_BYTES = 32 * 1024;

export function createExampleTool(config?: ExampleToolConfig): ToolDefinition<ExampleInput, ExampleOutput> {
  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: 'example_tool',
    description: 'Normalize a string and return its length.',
    timeoutMs,
    maxModelResultBytes: DEFAULT_MODEL_RESULT_MAX_BYTES,
    retryPolicy: {
      retryable: false,
    },
    inputSchema: {
      type: 'object',
      required: ['value'],
      additionalProperties: false,
      properties: {
        value: { type: 'string', description: 'Text to normalize.' },
        maxLength: {
          type: 'number',
          description: 'Optional maximum returned character length.',
        },
      },
    },
    summarizeResult(output) {
      return {
        length: output.length,
        truncated: output.truncated ?? false,
      };
    },
    async execute(rawInput, context) {
      // Some models send tool input as a JSON string instead of an object.
      const input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
      const { value, maxLength } = input as unknown as ExampleInput;

      if (typeof value !== 'string' || !value.trim()) {
        throw new Error('example_tool requires a non-empty "value" string');
      }

      context.signal.throwIfAborted();

      const normalized = value.trim();
      const limit = maxLength === undefined ? normalized.length : Math.max(1, Math.floor(maxLength));
      const truncated = normalized.length > limit;
      const outputValue = truncated ? normalized.slice(0, limit) : normalized;

      return {
        value: outputValue,
        length: normalized.length,
        ...(truncated ? { truncated: true } : {}),
      };
    },
  };
}
```

Adjust the optional fields according to the tool behavior:

- `requiresApproval: true` for shell execution, writes, deletes, external
  side effects, destructive operations, or anything costly/sensitive.
- `timeoutMs` for network, process, conversion, or long-running work.
- `retryPolicy` only when retrying is safe and useful. Use retry kinds from
  `FailureKind` in `../types.js`.
- `budgetGroup` when the tool participates in a shared budget. Existing web
  research groups are `web_research.search` and `web_research.read`.
- `capture` and `redact` when inputs or outputs may include secrets or large
  sensitive payloads.
- `summarizeResult` when logs/events should store a compact view instead of a
  full payload.
- `formatResultForModel` and `maxModelResultBytes` when outputs can exceed the
  model-facing budget.
- `recoverError` when the model can use a structured recovery result, such as a
  workspace-relative path suggestion.

## 4. Validate both schema and runtime input

The `inputSchema` is sent to the model/provider, but the tool must still defend
itself at execution time. Core validates execution-time data, and model output
cannot be trusted.

Rules:

- Use strict JSON Schema objects: `required` plus `additionalProperties: false`.
- Prefer strings, numbers, booleans, arrays, objects, and enums that are JSON
  serializable.
- Normalize stringified JSON inputs at the start of `execute()`.
- Check required values before performing side effects.
- Throw clear errors that name the tool and missing field.
- Return JSON-serializable outputs only. Do not return `Buffer`, streams,
  class instances, functions, or cyclic objects.

## 5. Preserve safety boundaries

Built-in tools are powerful because hosts often expose them directly to models.
Keep safety local to the tool factory.

For filesystem tools:

- Accept `allowedRoot?: string` and default it to `process.cwd()` only when that
  matches the existing tool behavior.
- Use `resolvePathWithinRoot()` from `./path-utils.js` for every host-provided
  or model-provided path.
- Add `recoverError()` with `buildWorkspacePathRecovery()` for
  `PathOutsideRootError` when a retry with a relative path would help.
- Reject path traversal, absolute paths outside the root, and unsafe archive
  member paths.

For network tools:

- Accept dependency/config injection for provider URLs, API keys, fetch limits,
  and timeouts.
- Always pass `context.signal` to `fetch()` or equivalent async work.
- Bound response size before reading large bodies into memory.
- Convert provider failures into useful errors or structured recoverable outputs
  when the model can proceed with partial information.

For process or conversion tools:

- Use `context.signal` to cancel child processes or long-running work.
- Bound stdout/stderr or generated text by bytes, not only characters.
- Make cleanup deterministic in `finally` blocks.
- Require approval for commands and write-like conversions.

For tools with external side effects:

- Prefer idempotent behavior where possible.
- Consider `context.idempotencyKey` when calling durable external services.
- Do not hide partial failure. Return enough information for the runtime and
  model to decide whether to retry, continue, or ask for approval.

## 6. Export the tool

Add the factory and config type to `packages/core/src/tools/index.ts`:

```ts
export { createExampleTool } from './example-tool.js';
export type { ExampleToolConfig } from './example-tool.js';
```

Use `.js` in TypeScript import/export specifiers because this package is ESM and
the existing source follows Node/Bun ESM resolution conventions.

`packages/core/src/index.ts` already re-exports `./tools/index.js`, so callers of
`@adaptive-agent/core` receive the new export once it is added to the tools
index.

## 7. Add focused tests

Add tests in `packages/core/src/tools/tools.test.ts`, or create a sibling
`<tool-name>.test.ts` if the fixture setup is large. Keep tests focused on the
tool factory and pure helpers.

Cover at least:

- Metadata: `name`, approval requirement, timeout, retry policy, and schema.
- Happy path execution.
- Runtime validation for missing or invalid required fields.
- Safety boundaries such as `allowedRoot`, max size, timeout, or unsupported
  provider responses.
- Cancellation through `context.signal` for async/process/network work.
- Result summarization or model formatting when outputs can be large.
- Recoverable errors when `recoverError()` is implemented.

Use injected dependencies instead of live network calls or real external tools
where possible. Existing tests use temporary directories, `vi.fn()`, and
stubbed extraction/search functions as examples.

Run the narrowest useful checks from the package directory:

```sh
bunx vitest run src/tools/tools.test.ts
bun run build
```

If the new tool has its own test file, run that file directly first:

```sh
bunx vitest run src/tools/<tool-name>.test.ts
```

## 8. Register it in hosts only when needed

Core exports factories. It does not decide which tools an agent gets.

Host applications register tools like this:

```ts
import { AdaptiveAgent, createExampleTool } from '@adaptive-agent/core';

const agent = new AdaptiveAgent({
  model,
  tools: [createExampleTool({ timeoutMs: 10_000 })],
  runStore,
  eventStore,
  snapshotStore,
});
```

If the new built-in should be addressable by name in repository hosts, update
the appropriate host-owned registry:

- Agent SDK: `packages/agent-sdk/src/index.ts` (`createBuiltinTools`).
- Core CLI: `packages/core-cli/src/local-modules.ts` (`createBuiltinTools`).
- Fastify gateway local runtime: `packages/gateway-fastify/src/core.ts` and
  related local module configuration.
- User-facing docs or install defaults only if the new tool is meant to be part
  of that host's supported local tool set.

Keep those registrations outside core so the core/runtime boundary remains
clean.

## 9. Update public docs when the API surface changes

When the new factory is intended for public use, update the tool lists in:

- `packages/core/README.md`
- root `README.md`
- host package READMEs if that host registers the tool by default

Do not update historical versioned specs unless the task explicitly changes a
versioned contract.

## Final checklist

- [ ] The tool belongs in core and has no Agent SDK or CLI dependency.
- [ ] The factory returns a configured `ToolDefinition` instance.
- [ ] `inputSchema` is strict and runtime validation is explicit.
- [ ] Outputs are JSON-serializable and bounded for model/log use.
- [ ] File, network, process, and side-effect boundaries are enforced locally.
- [ ] Mutating or risky operations set `requiresApproval: true`.
- [ ] Long-running work uses `timeoutMs` and `context.signal`.
- [ ] The factory and config type are exported from `tools/index.ts`.
- [ ] Focused tests cover happy path, invalid input, safety, and formatting.
- [ ] Optional host registries/docs are updated outside core when needed.
