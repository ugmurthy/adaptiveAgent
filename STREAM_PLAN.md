# Streaming-Backed `generate()` Implementation Plan

## Goal

Switch provider inference to streaming transport without changing the model
generation contract used by the rest of core.

The public and internal runtime boundary remains:

```ts
generate(request: ModelRequest): Promise<ModelResponse>;
```

Adapters may use provider streaming internally, consume the stream to completion,
aggregate chunks, and return the same final `ModelResponse` shape that callers
receive today.

This is not a UX streaming feature. The purpose is to avoid provider, gateway,
or HTTP client timeouts on long-running model inference that can exceed five
minutes.

## Non-Goals

- Do not change `ModelRequest`.
- Do not change `ModelResponse`.
- Do not require `AdaptiveAgent` to call `model.stream()`.
- Do not add `modelStreaming`, `modelIdleTimeoutMs`, or gateway config fields in
  this phase.
- Do not stream token deltas to gateway or TUI clients.
- Do not persist partial token/chunk events as durable execution state.
- Do not change tool execution, delegation, sessions, snapshots, replay, or plan
  execution semantics.
- Do not stream chain-of-thought or provider-private reasoning.

## Current State

- `AdaptiveAgent.generateModelResponse()` calls `this.options.model.generate()`.
- `ModelAdapter` already exposes a stable required `generate()` method and an
  optional `stream()` method.
- OpenRouter, Mistral, Mesh, and Ollama declare streaming capability.
- Current remaining adapter implementation that still uses a non-streaming
  generation path:
  - Mistral: SDK `client.chat.complete(...)`.
- Phase 1 is implemented for Mesh:
  - `MeshAdapter.generate()` now calls SDK chat completions with `stream: true`.
  - Mesh stream chunks are consumed internally and aggregated back into the
    existing final `ModelResponse` contract.
  - Mesh text, structured output, fragmented and multiple tool calls, usage,
    missing usage, abort, HTTP error enrichment, and mid-stream error behavior
    have focused adapter coverage.
- Phase 2 is implemented for the OpenAI-compatible base path:
  - `BaseOpenAIChatAdapter.generate()` now sends `stream: true`, requests stream
    usage where the adapter declares usage support, parses SSE frames, consumes
    `[DONE]`, and aggregates chunks back into the existing final
    `ModelResponse` contract.
  - OpenAI-compatible text, fragmented and multiple tool calls, usage, abort,
    gate release, HTTP retry-before-stream behavior, and mid-stream failure
    behavior have focused adapter coverage.
- Phase 3 is implemented for OpenRouter:
  - `OpenRouterAdapter.generate()` now uses the SDK streaming overload while
    preserving SDK request field normalization.
  - SDK stream chunks are aggregated through the shared OpenAI-compatible stream
    accumulator, including delegate tool-name alias restoration and usage.
- `modelTimeoutMs` remains a core wall-clock timeout around the whole model turn.
  Streaming will not bypass this timeout.

## Recommended Implementation Shape

Keep core unchanged and make streaming a provider-adapter implementation detail:

```text
AdaptiveAgent core
  -> model.generate(ModelRequest)
      -> adapter starts provider stream internally
      -> adapter aggregates chunks
      -> adapter returns final ModelResponse
  -> core continues exactly as today
```

The adapter `generate()` implementation should behave conceptually like this:

```ts
async generate(request: ModelRequest): Promise<ModelResponse> {
  const stream = await startProviderStream(request);
  const aggregate = new ProviderStreamAccumulator(this.provider, this.model);

  for await (const chunk of stream) {
    aggregate.add(chunk);
  }

  return aggregate.toModelResponse();
}
```

No caller should need to know whether the adapter used a non-streaming request
or a streaming request internally.

## Contract Parity Requirements

For a given provider response, streaming-backed `generate()` must preserve the
current final response semantics:

- `text`: concatenate content deltas in order.
- `structuredOutput`: parse final text as JSON using the same behavior as the
  existing parser.
- `toolCalls`: reconstruct the same `ModelToolCall[]` shape as non-streaming.
- `finishReason`: map provider finish reasons to the existing union.
- `usage`: preserve usage when the provider supplies it in stream output.
- `providerResponseId`: preserve the provider response id when available.
- `reasoning` and `reasoningDetails`: preserve only provider-returned reasoning
  fields that are already part of the current `ModelResponse` contract.
- `performance`: continue recording adapter latency, request bytes, response
  bytes when practical, attempt count, retry delay, and provider status details.

If a provider cannot supply usage in streaming mode, document that provider as a
parity exception and keep the non-streaming path available until the tradeoff is
accepted.

## Timeout Semantics

Keep `modelTimeoutMs` as the total wall-clock timeout for the model turn.

Important consequence:

- Streaming can avoid transport/body-response timeouts after the first chunk.
- Streaming cannot help if the model emits no chunk or heartbeat before the
  configured `modelTimeoutMs` expires.
- Long-running inference still requires a larger `defaults.modelTimeoutMs` or a
  disabled core model timeout (`0`) where the host configuration path supports
  it.

Do not add a separate idle timeout in this drop-in phase. If needed later, add it
as a follow-up with explicit runtime and gateway configuration.

## Provider Implementation Plan

### Phase 1: Mesh first - Complete

Mesh is the best first target because its installed SDK exposes explicit chat
completion streaming:

```ts
const stream = client.chat.completions.create(
  {
    ...body,
    stream: true,
  },
  { signal: request.signal },
);
```

Notes:

- Mesh SDK `timeoutMs` is ignored for streaming and applies only to initial
  connection behavior, so keep using `request.signal` for core cancellation.
- Preserve `enrichMeshError()` for SDK and mid-stream errors.
- Aggregate OpenAI-compatible stream chunks into the existing parser shape.
- Mocked final usage chunks map to `UsageSummary`; missing usage is accepted
  without throwing. Manual provider validation should still confirm whether live
  Mesh streams include usage for the target models before relying on streaming
  usage accounting in production.

### Phase 2: OpenAI-compatible base path - Complete

Add streaming-backed generation support to `BaseOpenAIChatAdapter` for Ollama
and compatible endpoints.

Request behavior:

- Reuse `buildRequestBody(request)`.
- Add `stream: true`.
- Add provider-supported usage options when known, such as
  `stream_options: { include_usage: true }` for OpenAI-compatible providers that
  support it.
- Reuse existing headers, request gate, abort signal, retry, and cooldown
  behavior before stream consumption begins.

Parsing behavior:

- Parse server-sent events from `response.body`.
- Ignore empty lines and SSE comments.
- Stop on `data: [DONE]`.
- Parse JSON `data:` frames.
- Accumulate content deltas.
- Accumulate tool-call deltas by `index`, `id`, and function fields.
- Concatenate fragmented tool-call argument strings.
- Parse accumulated tool arguments using the same argument parsing behavior as
  non-streaming responses.
- Map final finish reason using the same mapper as non-streaming responses.

Implementation notes:

- `BaseOpenAIChatAdapter.generate()` keeps JSON response parsing as a fallback if
  an OpenAI-compatible endpoint returns a non-SSE response despite `stream: true`.
- `stream_options: { include_usage: true }` is sent only when the adapter
  declares usage support, so Ollama avoids an unsupported usage option.
- Mid-stream read, parse, and abort failures are surfaced as response-body model
  failures and are not automatically retried.

### Phase 3: OpenRouter SDK - Complete

Use the SDK streaming overload:

```ts
const stream = await client.chat.send(
  {
    chatRequest: {
      ...toSdkRequest(body),
      stream: true,
    },
  } as never,
  { signal: request.signal, headers: sdkHeaders } as never,
);
```

Notes:

- Keep the existing SDK request normalization. Do not leak REST-only field names
  into SDK input.
- Convert SDK stream chunks into the same accumulator used for OpenAI-compatible
  chunks where possible.
- Preserve reasoning and `reasoningDetails` when the SDK returns them.
- Verify tool-call streaming with delegate tool-name aliases.

Implementation notes:

- `toSdkRequest()` now maps REST `stream_options` to SDK `streamOptions` so
  REST-only field names do not leak into SDK input.
- The OpenRouter adapter keeps a non-streaming SDK result fallback for tests and
  SDK/provider cases that return a full JSON completion despite requesting a
  stream.
- Focused coverage verifies streaming text/tool-call aggregation, usage, and
  delegate alias restoration through the SDK path.

### Phase 4: Mistral SDK

Use the SDK streaming method:

```ts
const stream = await client.chat.stream(toSdkRequest(body) as never, {
  signal: request.signal,
} as never);
```

Notes:

- Mistral event names and chunk shapes may differ from OpenAI-compatible chunks.
- Map Mistral-specific stream events into the same final accumulator model.
- Verify structured output, tool calls, and usage separately; do not assume
  non-streaming and streaming response fields match exactly.

## Retry Policy

Preserve current retry behavior for failures before stream consumption starts:

- request gate wait failures;
- request construction failures;
- HTTP status failures before a stream body is consumed;
- connection failures before the first stream chunk.

Be conservative after stream consumption starts:

- Do not automatically retry after partial chunks have been received.
- Treat mid-stream provider errors as model failures.
- Preserve provider-specific error enrichment where it already exists.

This avoids duplicating partial inference work and avoids changing deterministic
execution behavior.

## Stream Accumulator Requirements

The accumulator can start provider-local. Create a shared helper only after at
least two providers need materially identical logic.

Minimum behavior:

```ts
interface AccumulatedToolCall {
  index: number;
  id?: string;
  name?: string;
  argumentsText: string;
}
```

Rules:

- Content deltas append to a text buffer.
- Tool calls are keyed primarily by provider `index`; fall back to insertion
  order when index is missing.
- Tool-call `id` and function `name` can arrive before, after, or between
  argument fragments.
- Argument fragments concatenate exactly as received before JSON parsing.
- Empty final text should remain `undefined`, matching current behavior.
- `finishReason: 'tool_calls'` should be returned when final chunks indicate
  tool calls, even if text is empty.
- `structuredOutput` is derived from final text only after stream completion.

## Event Store and Replay

Do not persist partial stream chunks in this phase.

Core should continue persisting only the same durable artifacts as today:

- final assistant text;
- final tool calls;
- final usage, if available;
- existing events such as `model.started`, `model.completed`, and
  `model.failed`;
- snapshots after model response/tool-call queueing as currently implemented.

This keeps replay and resumability behavior unchanged.

## Tests

### Adapter tests

Add focused tests under `packages/core/src/adapters/adapters.test.ts`.

Required cases:

- Streaming-backed `generate()` returns final text equal to non-streaming parser
  expectations.
- Multiple text deltas concatenate in order.
- `[DONE]` terminates SSE parsing.
- Empty and comment SSE lines are ignored.
- Fragmented tool-call arguments reconstruct a valid `ModelToolCall`.
- Multiple tool calls are reconstructed by index.
- Final usage chunk maps to `UsageSummary` when present.
- Missing usage is handled without throwing.
- Abort signal cancels stream consumption.
- Request gate release happens on success, provider failure, parse failure, and
  abort.
- Retryable HTTP statuses before stream consumption preserve current retry
  behavior.
- Mid-stream errors fail the request without automatic retry.

Provider-specific cases:

- Mesh streaming response chunks map to `ModelResponse`.
- Mesh mid-stream `MeshAPIApiError` preserves enriched provider detail.
- OpenRouter SDK stream chunks preserve SDK field-name normalization.
- Mistral stream events map content, tool calls, finish reason, and usage when
  available.
- Ollama/OpenAI-compatible SSE works through `BaseOpenAIChatAdapter`.

### Core regression tests

Because core should remain unchanged, run existing core agent tests to ensure the
adapter behavior is still transparent:

```bash
bunx vitest run packages/core/src/adaptive-agent.test.ts
bunx vitest run packages/core/src/create-adaptive-agent.test.ts
```

### Verification commands

Use Bun-native checks:

```bash
bunx vitest run packages/core/src/adapters/adapters.test.ts
bunx vitest run packages/core/src/adaptive-agent.test.ts
bun run --cwd packages/core build
```

If provider config or SDK imports change, also run:

```bash
bunx vitest run packages/agent-sdk/src/index.test.ts
bun run --cwd packages/agent-sdk typecheck
```

## Rollout Plan

1. Done: Implement Mesh streaming-backed `generate()` behind the existing
   `MeshAdapter.generate()` method.
2. Done: Add Mesh stream aggregation tests for text, tool calls, usage, abort,
   and mid-stream errors.
3. Next: Manually validate one long-running Mesh inference with a large enough
   `modelTimeoutMs`.
4. If Mesh parity is acceptable, decide whether Mesh should always use
   streaming internally or keep a private adapter fallback during burn-in.
5. Done: Implement OpenAI-compatible SSE support in
   `BaseOpenAIChatAdapter.generate()` and a shared stream accumulator.
6. Next: Validate Ollama locally.
7. Done: Implement OpenRouter SDK streaming-backed `generate()`.
8. Next: Implement Mistral SDK streaming-backed `generate()`.
9. Keep `ModelAdapter.stream()` optional and unused by core until a separate UX
   streaming feature is explicitly required.

## Risks and Mitigations

- **No early chunks:** streaming does not help if the provider emits nothing
  before core or upstream initial-response timeout. Mitigate with larger
  `modelTimeoutMs` and provider-specific testing.
- **Missing usage:** some providers omit stream usage. Mitigate by testing usage
  first and keeping a non-streaming fallback for providers where accounting is
  required.
- **Fragmented tool calls:** tool calls can arrive as partial JSON strings.
  Mitigate with accumulator tests for fragmented and multiple tool calls.
- **Provider-specific chunk shapes:** SDK stream events differ. Mitigate by
  implementing provider-local mapping first.
- **Mid-stream failures:** automatic retry after partial output is unsafe.
  Mitigate by retrying only before stream consumption starts.
- **Structured output differences:** some providers may not support structured
  output with streaming. Mitigate by testing `outputSchema` per provider before
  making streaming the default.
- **Response byte metrics:** streaming does not naturally expose one response
  body string. Mitigate by approximating serialized chunk bytes or recording the
  final accumulated response bytes.

## Future Phase: UX Streaming

If user-facing live token updates are needed later, add that separately:

- make core choose `model.stream()` explicitly;
- define durable vs ephemeral model stream events;
- negotiate gateway/websocket client capability;
- keep existing final-result frames unchanged for old clients.

That future work should not be mixed with this timeout-focused drop-in transport
change.
