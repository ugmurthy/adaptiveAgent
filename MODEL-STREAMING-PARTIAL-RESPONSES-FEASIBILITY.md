# Model Streaming Partial Responses Feasibility

## Summary

Provider adapters in `packages/core` already request streaming model responses and assemble provider chunks into complete `ModelResponse` values. The partial response state exists inside the adapters during generation, but it is not exposed to `AdaptiveAgent`, `@adaptive-agent/agent-sdk`, or the `adaptive-agent chat` UI today.

Exposing partial assistant text for chat UX is feasible, but it requires a core API change. The smallest compatible approach is to add a normalized streaming callback to `ModelRequest` and have adapters emit partial text as they aggregate chunks, while preserving the existing final `generate()` response contract.

No implementation changes were made as part of this analysis.

## Current behavior

### Core model contract

`ModelAdapter` currently exposes:

```ts
interface ModelAdapter {
  provider: string;
  model: string;
  capabilities: ModelCapabilities;
  formatToolName?(name: string): string;
  generate(request: ModelRequest): Promise<ModelResponse>;
  stream?(
    request: ModelRequest,
    onEvent: (event: ModelStreamEvent) => Promise<void> | void,
  ): Promise<ModelResponse>;
}
```

`ModelRequest` supports `onRetry`, but not a text/partial streaming callback. `AdaptiveAgent` currently calls `this.options.model.generate(...)` and waits for completion before emitting `model.completed`.

The optional `stream()` method exists on the interface, but the runtime does not use it for chat UX, and current provider adapters implement their streaming behavior inside `generate()`.

### Base OpenAI-compatible adapter

`BaseOpenAIChatAdapter.generate()`:

1. Builds a request body with `stream: true`.
2. Sends the chat completion request.
3. If the response is `text/event-stream`, reads all SSE chunks.
4. Aggregates chunks into an OpenAI-compatible completion.
5. Parses the completed response into `ModelResponse`.

The live partial text is accumulated in `OpenAIChatStreamAccumulator`:

```ts
const content = readStringProperty(delta, 'content');
if (content !== undefined) {
  this.text += content;
}
```

The same accumulator also reconstructs streamed reasoning and fragmented tool calls.

### Provider-specific adapters

The SDK-backed adapters follow the same shape:

- `OpenRouterAdapter.generate()` iterates an async stream, pushes chunks, calls `accumulator.add(chunk)`, then parses `accumulator.toCompletion()`.
- `MistralAdapter.generate()` iterates SDK stream events, normalizes each event, accumulates, then parses the final completion.
- `MeshAdapter.generate()` has its own `MeshStreamAccumulator`, accumulates streamed text/tool calls/usage, then parses and prices the final response.

In all cases, the partial text is available at chunk-processing time but is local to the adapter.

## Feasibility assessment

### Feasible path

Expose normalized partial events from core rather than raw provider chunks.

Recommended initial event shape:

```ts
type ModelStreamEvent =
  | { type: 'text_delta'; payload: { delta: string; text: string } }
  | { type: 'reasoning_delta'; payload: { delta: string; reasoning: string } }
  | { type: 'tool_call_delta'; payload: { index: number; id?: string; name?: string; argumentsDelta?: string } }
  | { type: 'usage'; payload: JsonValue }
  | { type: 'status'; payload: JsonValue };
```

Then add an optional callback to `ModelRequest`, for example:

```ts
interface ModelRequest {
  // existing fields...
  onStream?: (event: ModelStreamEvent) => Promise<void> | void;
}
```

This keeps `generate()` as the single execution path and preserves all existing adapter callers. It also matches the existing `onRetry` callback pattern.

### Why `onStream` is preferable to using `ModelAdapter.stream()` initially

`ModelAdapter.stream()` is already present, but introducing it as the primary path would require runtime branching and adapter method additions. An `onStream` callback is smaller because adapters already stream internally inside `generate()`.

With `onStream`:

- Existing `generate()` return semantics remain unchanged.
- Retry, timeout, and model invocation diagnostics stay on the same path.
- Adapters can emit events from their existing chunk loops.
- Agent SDK can consume runtime lifecycle events without owning provider-specific semantics.

## Expected implementation touchpoints

When implementation is approved, likely changes are:

1. Extend `ModelStreamEvent` in `packages/core/src/types.ts` with normalized text/reasoning/tool-call delta events.
2. Add optional `onStream` to `ModelRequest`.
3. Update `OpenAIChatStreamAccumulator` or its call sites to emit after each chunk.
4. Update `readOpenAICompatibleSseStream()` or adjacent code so base SSE adapters can emit as each event arrives, not after all chunks are read.
5. Update `OpenRouterAdapter`, `MistralAdapter`, and `MeshAdapter` chunk loops to call `request.onStream?.(...)` after each accumulator update.
6. Update `AdaptiveAgent` to bridge model stream events into runtime events, likely as a new event type such as `model.stream` or `model.partial`.
7. Update Agent SDK CLI/TUI chat paths to render `text_delta` events as transient assistant output until `model.completed` finalizes the message.

## UX considerations for `adaptive-agent chat`

- Show only `text_delta` by default in chat output.
- Keep reasoning deltas hidden unless an explicit debug/inspection mode requests them.
- Do not render tool-call argument deltas as assistant prose.
- Mark partial content as provisional until final completion.
- On mid-stream failure, either clear the provisional assistant text or show it with an explicit failed/incomplete marker.
- For schema-constrained output, disable partial rendering or label it as raw draft text because partial JSON will often be invalid.

## Risks and caveats

- Mid-stream failures currently reject and do not return a partial `ModelResponse`. UI state must not treat displayed partials as durable successful assistant messages.
- Adding a new runtime event type affects event stores, progress renderers, and downstream listeners.
- Streaming can produce many events; the implementation should avoid bloating durable event logs. A reasonable policy is to emit live events to listeners and either not persist every delta or persist coalesced snapshots only if needed.
- Tool calls are reconstructed from fragmented deltas. Any public event shape must avoid exposing malformed partial JSON as final tool input.
- The package boundary should remain intact: core owns normalized runtime/model stream events; Agent SDK owns CLI/TUI rendering.

## Recommendation

Proceed with a small core design change centered on `ModelRequest.onStream`, normalized delta events, and runtime event bridging. This unlocks responsive chat UX while keeping provider-specific streaming details inside core adapters and preserving the existing final `ModelResponse` contract.
