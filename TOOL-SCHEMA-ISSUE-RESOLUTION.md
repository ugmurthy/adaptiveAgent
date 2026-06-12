# Tool Schema Issue Resolution

## Problem Statement

Two separate research runs failed with `MODEL_ERROR` while using delegated research tools through the Mesh provider:

- `research-2026-06-11-25.log`
- `research-2026-06-11-30.log`

Both failures point to provider/API payload-shape problems around tool calls and delegated tool results, rather than a normal model reasoning failure. The issue sits at the runtime boundary where core accepts model-produced tool-call inputs, launches child runs, and serializes tool results back into model messages.

This handover focuses only on these three causes:

1. Model-visible tool results can be serialized as JSON string literals instead of JSON objects.
2. Delegate tool input validation is too permissive at runtime.
3. `outputSchema` is not validated/normalized strongly enough before model calls and child-run completion.

Do not address unrelated web-search provider failures in this change.

## Evidence From Logs

### Run 25: malformed delegate input reaches child model call

In `research-2026-06-11-25.log`, the parent model emits a delegate call with malformed fields:

- The requested tool name is misspelled as `delegate.reserearcher`, then corrected to `delegate.researcher`.
- `context`, `metadata`, and `outputSchema` are JSON-looking strings instead of objects.

Relevant events:

- Parent model response at line 154 emits the malformed delegate call.
- `tool.name_corrected` at line 161 corrects `delegate.reserearcher` to `delegate.researcher`.
- `delegate.spawned` at line 169 shows `context`, `metadata`, and `outputSchema` as strings.
- Child `model.request` at line 175 sends `outputSchema` as a string.
- Child `model.failed` at lines 177 and 182 fails with Mesh upstream `500`.
- Root run fails with `MODEL_ERROR` at line 196.

Likely interpretation: the runtime lets malformed delegate fields pass through because it checks only that the delegate input is an object with a string `goal`. The adapter then sees a truthy `outputSchema` and sends it as a structured-output schema, but it is a string, not a schema object.

### Run 30: plain string delegate results rejected by provider

In `research-2026-06-11-30.log`, the parent emits four `delegate.researcher` calls in one turn. The child runs complete successfully, but each returns a large plain text string rather than a structured object.

Relevant events:

- Parent model response at line 14 emits four `delegate.researcher` calls.
- Delegate completions return string outputs at lines 550 and nearby previous delegate completions.
- Parent `model.request` at line 557 sends the four delegate tool results back to the model.
- Provider rejects the request at line 559 with:

```text
ValidationException when calling the Converse operation:
The format of the value at messages.2.content.0.toolResult.content.0.json is invalid.
Provide a json object for the field and try again.
```

Likely interpretation: the model-visible tool result payload is a JSON string literal when the delegate child output is plain text. Bedrock Converse-style tool results expect `toolResult.content[].json` to be a JSON object.

## Relevant Code Paths

Primary areas to inspect:

- `packages/core/src/adaptive-agent.ts`
  - `toolResultMessage(...)`
  - `formatToolOutputForModel(...)`
  - child-run completion path that uses `response.structuredOutput ?? response.text ?? null`
  - pending tool-call execution and message appending
- `packages/core/src/delegation-executor.ts`
  - `delegateToolInputSchema`
  - `toDelegateToolInput(...)`
  - `executeDelegateTool(...)`
- `packages/core/src/adapters/base-openai-chat-adapter.ts`
  - `buildRequestBody(...)`
  - `toOpenAIMessage(...)`
  - structured output handling with `response_format`

The current `toolResultMessage(...)` serializes all outputs with `JSON.stringify(output)`. That is safe for object outputs, but for string outputs it produces a JSON string literal.

## Proposed Solution 1: Always Envelope Model-Visible Tool Results As Objects

Introduce an invariant for model-visible tool result messages:

```ts
JsonValue output -> JsonObject modelVisibleToolResult
```

Suggested behavior:

- If the tool output is already a JSON object, preserve it as the model-visible payload.
- If the tool output is a string, wrap it:

```ts
{
  result: output,
  resultType: "text"
}
```

- If the tool output is an array, number, boolean, or null, wrap it:

```ts
{
  result: output
}
```

- Preserve the raw tool/run output separately for storage, events, and API return values.
- Apply this only to the model-visible tool result content sent back to the model.

Implementation direction:

- Add a helper such as `toModelVisibleToolResultObject(output: JsonValue): JsonObject`.
- Use it in `toolResultMessage(...)` or immediately before `toolResultMessage(...)`.
- Ensure truncation/capping still returns an object. If a capped string is produced, it should also be wrapped.

Expected outcome:

- Providers that require `toolResult.content[].json` to be an object no longer receive string literals.
- Plain-text delegate outputs remain usable by the parent model as `{ result, resultType }`.

## Proposed Solution 2: Strict Runtime Validation For Delegate Tool Inputs

The delegate tool schema already describes `context`, `metadata`, and `outputSchema` as objects, but runtime conversion is too permissive.

Tighten `toDelegateToolInput(...)` or an adjacent runtime validator so delegate inputs must satisfy:

- Input must be a JSON object.
- `goal` must be a string.
- `input`, if present, may be any `JsonValue`.
- `context`, if present, must be a JSON object.
- `metadata`, if present, must be a JSON object.
- `outputSchema`, if present, must be a JSON object.
- JSON-looking strings must be rejected, not parsed silently.

Bad input example that should fail before spawning a child run:

```json
{
  "goal": "Research frameworks",
  "outputSchema": "{\"type\":\"object\"}"
}
```

Recommended failure behavior:

- Treat malformed delegate input as an invalid tool call, not as a child model failure.
- Do not spawn the child run.
- Surface a clear repairable error to the model/runtime, for example:

```text
delegate.researcher input.outputSchema must be a JSON object, not a string
```

Expected outcome:

- Run 25-style malformed `outputSchema` does not reach `buildRequestBody(...)`.
- The model has a chance to repair the tool call instead of producing an opaque Mesh upstream `500`.

## Proposed Solution 3: Validate And Normalize `outputSchema`

Add a stricter guard for every `outputSchema` before it reaches a model adapter.

Suggested validation:

- Must be a JSON object.
- Prefer requiring root `type: "object"` for model structured output, unless the runtime intentionally supports non-object root schemas for all providers.
- If `properties` is present, it must be an object.
- If `required` is present, it must be an array of strings.
- If `additionalProperties` is present, it must be a boolean or schema object.
- If `items` is present, it must be a schema object or array of schema objects.
- Reject obviously invalid schemas with a clear runtime error.

Suggested normalization:

- Preserve valid JSON Schema objects.
- Do not parse JSON-looking strings.
- Do not pass invalid schemas into `response_format`.

Also tighten child-run completion when an `outputSchema` is supplied:

- If the model returns `structuredOutput`, use it.
- If the model returns only text while `outputSchema` is required, treat that as schema noncompliance rather than successful delegate output.
- The failure should be explicit and repairable where possible, for example `MODEL_OUTPUT_SCHEMA_ERROR` or an existing suitable failure code.

Expected outcome:

- A requested structured delegate result cannot silently degrade into plain prose.
- Parent runs receive either a valid structured result object or a clear child-run failure.
- Provider-specific structured-output errors are caught before the provider call.

## Scope Boundaries

Keep this change in `@adaptive-agent/core` unless a test or call site proves Agent SDK setup code needs adjustment.

Do not:

- Move CLI-specific parsing or agent-spec discovery into core.
- Make core depend on `@adaptive-agent/agent-sdk`.
- Treat DuckDuckGo challenge failures as part of this fix.
- Change public research policy behavior unless needed for tests.

## Suggested Tests

Add focused tests in `packages/core/src/adaptive-agent.test.ts` or adapter tests as appropriate:

1. A delegate child returning a string should append a model-visible tool result object, not a JSON string literal.
2. A delegate child returning an object should preserve the object shape.
3. `delegate.researcher` input with string `outputSchema` should fail before child spawn.
4. `delegate.researcher` input with string `context` or `metadata` should fail before child spawn.
5. A model request with string `outputSchema` should be rejected before adapter `response_format` construction.
6. A child run with required `outputSchema` that returns only plain text should not be treated as a successful structured delegate result.

## Acceptance Criteria

- No provider request is built with `outputSchema` as a string.
- No model-visible tool result sent to provider-native tool-result JSON fields is a scalar/string literal.
- Malformed delegate inputs fail early with clear errors.
- Valid object-shaped delegate outputs still work unchanged.
- Plain-text delegate outputs are represented to the parent model as object envelopes.
- Existing raw outputs and lifecycle events remain backward-compatible as much as possible.
