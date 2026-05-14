# Provider SDK Adapter Implementation Plan

This plan describes replacing the current hand-written OpenAI-compatible HTTP path with provider SDK adapters for OpenRouter, Mistral, and Mesh. Mesh SDK support is now in scope because `meshapi-node-sdk` is available on npm.

## Goals

- Add provider-native SDK adapters for OpenRouter, Mistral, and Mesh behind the existing `ModelAdapter` contract.
- Preserve current AdaptiveAgent runtime behavior: tool calling, JSON output, streaming, usage accounting, retries, logging, snapshots, and resumability.
- Keep the current OpenAI-compatible adapter as a fallback for Ollama, custom endpoints, and rollback.
- Prepare the adapter layer for richer multimodal inputs without forcing a large first change.

## Non-goals

- Do not remove `BaseOpenAIChatAdapter`.
- Do not switch AdaptiveAgent to OpenAI Responses semantics globally.
- Do not add broad file/audio/video support in the first SDK-adapter milestone unless required by SDK typing.

## Current State

The current provider adapters are thin subclasses of `BaseOpenAIChatAdapter`:

- `OpenRouterAdapter` posts to `https://openrouter.ai/api/v1/chat/completions`.
- `MistralAdapter` posts to `https://api.mistral.ai/v1/chat/completions`.
- `MeshAdapter` uses `meshapi-node-sdk` for chat completions.
- `OllamaAdapter` also uses the OpenAI-compatible base adapter.

The stable internal boundary is:

```ts
export interface ModelAdapter {
  provider: string;
  model: string;
  capabilities: ModelCapabilities;
  formatToolName?(name: string): string;
  generate(request: ModelRequest): Promise<ModelResponse>;
  stream?(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}
```

That means provider SDK migration can stay localized to `packages/core/src/adapters/*` if the SDK adapters continue accepting `ModelRequest` and returning `ModelResponse`.

## Dependencies

Add provider SDK dependencies to `packages/core/package.json`:

```json
{
  "dependencies": {
    "@openrouter/sdk": "<pinned-version>",
    "@mistralai/mistralai": "<pinned-version>",
    "meshapi-node-sdk": "<pinned-version>"
  }
}
```

Use Bun-native install/update commands:

```bash
bun add --cwd packages/core @openrouter/sdk @mistralai/mistralai meshapi-node-sdk
```

Pin the versions committed to `bun.lock` after checking install compatibility.

## Proposed Adapter Shape

Keep `BaseOpenAIChatAdapter` and add SDK-backed adapters:

```text
packages/core/src/adapters/
  base-openai-chat-adapter.ts       # existing fallback/shared parser reference
  openrouter-adapter.ts             # can become SDK-backed or delegate to SDK implementation
  mistral-adapter.ts                # can become SDK-backed or delegate to SDK implementation
  mesh-adapter.ts                   # SDK-backed through meshapi-node-sdk
  ollama-adapter.ts                 # unchanged
  provider-message-mapping.ts       # optional shared internal mapping helpers
```

Prefer the smallest initial implementation:

- Update `OpenRouterAdapter` to use `@openrouter/sdk` directly.
- Update `MistralAdapter` to use `@mistralai/mistralai` directly.
- Update `MeshAdapter` to use `meshapi-node-sdk` directly.
- Keep constructor config and public exports stable.
- Keep `createModelAdapter()` config shape stable.

If the SDK response shapes make each adapter too large, split provider-specific helpers into small local functions in the same file first. Create shared files only if duplication becomes meaningful.

## SDK Request Mapping Rule

Provider SDK adapters must map to the SDK's typed request model, not to the raw REST wire shape. Do not pass `BaseOpenAIChatAdapter.buildRequestBody()` output directly into an SDK call unless every nested field has been normalized to the SDK field names.

The runtime's OpenAI-compatible fallback uses REST-style snake_case fields. SDK clients commonly validate input before sending the request and may require camelCase fields even when the outbound HTTP payload is later serialized back to snake_case. A quick OpenRouter run exposed this failure mode: replayed assistant/tool messages built for REST contained `tool_calls`, `tool_call_id`, `reasoning_details`, and image `image_url`; the SDK expected `toolCalls`, `toolCallId`, `reasoningDetails`, and `imageUrl`, so validation failed before the provider request was sent.

For every SDK-backed provider, implement explicit normalization in both directions:

- Internal `ModelRequest` -> SDK request types, using SDK field names from installed `.d.ts` files.
- SDK response types -> internal `ModelResponse`, preserving existing `text`, `structuredOutput`, `toolCalls`, `usage`, `reasoning`, and `reasoningDetails` behavior.
- If reusing shared OpenAI-compatible helpers, treat their output as an intermediate convenience only. Add a provider-specific `toSdkRequest()` pass for all nested request objects before calling the SDK.

Minimum fields to audit for each provider SDK:

- message discriminators and roles;
- assistant tool-call replay fields (`toolCalls` vs `tool_calls`);
- tool result call IDs (`toolCallId` vs `tool_call_id`);
- content parts, especially images/files (`imageUrl` vs `image_url`, document/file chunk names, data URL fields);
- reasoning fields (`reasoningDetails` vs `reasoning_details`);
- tool definitions and strict/schema fields;
- structured output fields (`responseFormat` vs `response_format`);
- usage fields (`promptTokens` vs `prompt_tokens`, completion and reasoning token details);
- request options such as headers, abort signals, retries, base URL/server URL, and streaming flags.

Tests should assert the SDK-normalized request shape for nested messages and content, not only the final provider response parsing. Include at least one replayed assistant tool call, one tool result message, one delegate tool alias, and one image content part for each SDK adapter that supports those features.

## Phase 1: OpenRouter SDK Adapter

### Package/API

Use the OpenRouter SDK client:

```ts
import { OpenRouter } from '@openrouter/sdk';

const client = new OpenRouter({
  apiKey: config.apiKey,
  defaultHeaders: {
    'HTTP-Referer': config.siteUrl,
    'X-OpenRouter-Title': config.siteName,
  },
});
```

Call:

```ts
const completion = await client.chat.send({
  model: this.model,
  messages: toOpenRouterMessages(request.messages),
  tools: request.tools?.map(toOpenRouterTool),
  responseFormat: request.outputSchema ? toOpenRouterResponseFormat(request.outputSchema) : undefined,
  stream: false,
});
```

Use exact SDK field names from installed types. OpenRouter docs show camelCase in SDK examples for some multimodal parts, while raw REST uses snake_case.

### Required mappings

- `ModelMessage.role` -> OpenRouter message role.
- `string` content -> string content.
- `{ type: 'text' }` content part -> SDK text part.
- `{ type: 'image' }` content part -> OpenRouter image content part.
- `ToolDefinition` -> OpenAI-compatible function tool.
- `ModelToolCall` replay -> assistant `toolCalls` in SDK input; parse SDK response tool calls back to `ModelToolCall`.
- Tool result messages -> SDK tool messages with `toolCallId`; do not pass REST `tool_call_id` directly to the SDK.
- `outputSchema` -> structured output/JSON schema field supported by OpenRouter SDK.
- Response `choices[0].message` -> `ModelResponse`.
- Usage -> `UsageSummary`.

### Compatibility points

- Preserve delegate tool name aliasing behavior currently implemented by the base adapter.
- Preserve reasoning/reasoning-details round trip if OpenRouter returns those fields.
- Map request and response reasoning details using the SDK field name (`reasoningDetails`) and only use `reasoning_details` at REST/fallback boundaries.
- Preserve current retry/cooldown behavior or replace with equivalent SDK error handling only if the SDK exposes retry controls. If unclear, keep retry logic in the adapter wrapper around SDK calls.

## Phase 2: Mistral SDK Adapter

### Package/API

Use the Mistral SDK client:

```ts
import { Mistral } from '@mistralai/mistralai';

const client = new Mistral({
  apiKey: config.apiKey,
});
```

Call:

```ts
const completion = await client.chat.complete({
  model: this.model,
  messages: toMistralMessages(request.messages),
  tools: request.tools?.map(toMistralTool),
  responseFormat: request.outputSchema ? toMistralResponseFormat(request.outputSchema) : undefined,
});
```

Use exact SDK field names from installed types.

### Required mappings

- `ModelMessage.role` -> Mistral message role.
- `string` content -> string content.
- `{ type: 'text' }` content part -> Mistral text chunk.
- `{ type: 'image' }` content part -> Mistral image URL chunk with local images encoded as data URLs.
- `ToolDefinition` -> Mistral function tool shape.
- `ModelToolCall` replay -> assistant tool calls.
- Tool result messages -> tool messages with call IDs.
- `outputSchema` -> Mistral `responseFormat`, if compatible.
- Response message/tool calls/usage -> `ModelResponse`.

### Compatibility points

- Mistral may use different field names for `toolChoice`, `responseFormat`, and content chunks than the OpenAI-compatible REST adapter. Let SDK types drive the mapping.
- Mistral supports document/OCR/file APIs, but do not wire those into AdaptiveAgent in Phase 2 unless image support requires a small helper.
- Preserve current `imageInput: true` behavior for vision-capable models, but document that actual support still depends on selected model.

## Phase 3: Mesh SDK Adapter

### Package/API

Use the Mesh SDK client:

```ts
import { MeshAPI } from 'meshapi-node-sdk';

const client = new MeshAPI({
  baseUrl: config.baseUrl ?? 'https://api.meshapi.ai',
  token: config.apiKey,
});
```

Call:

```ts
const completion = await client.chat.completions.create(
  {
    model: this.model,
    messages: toMeshMessages(request.messages),
    tools: request.tools?.map(toMeshTool),
    response_format: request.outputSchema ? toMeshResponseFormat(request.outputSchema) : undefined,
    stream: false,
  },
  { signal: request.signal },
);
```

Use exact SDK field names from installed types. `meshapi-node-sdk@0.1.0` currently exposes OpenAI-compatible chat-completion request and response types, including snake_case fields such as `tool_calls`, `tool_call_id`, `image_url`, `response_format`, and usage token fields.

### Required mappings

- `ModelMessage.role` -> Mesh chat message role.
- `string` content -> string content.
- `{ type: 'text' }` content part -> Mesh text content part.
- `{ type: 'image' }` content part -> Mesh `image_url` content part with local images encoded as data URLs.
- `ToolDefinition` -> Mesh function tool shape.
- `ModelToolCall` replay -> assistant `tool_calls`.
- Tool result messages -> `role: 'tool'` with `tool_call_id`.
- `outputSchema` -> Mesh/OpenAI-compatible `response_format`, if supported by the selected model.
- Response `choices[0].message` -> `ModelResponse`.
- Usage -> `UsageSummary`.

### Compatibility points

- The SDK appends `/v1` paths internally. If the public config keeps accepting `baseUrl` values ending in `/v1`, normalize the SDK client base URL to the origin/root to avoid `/v1/v1/...` requests.
- The SDK has its own retry controls. Avoid accidental double retries if wrapping SDK calls with adapter-level retry/cooldown behavior.
- Preserve delegate tool name aliasing behavior currently implemented by the base adapter.
- Preserve current Mesh image capability behavior; actual support remains model-dependent.

## Phase 4: Transport Selection And Rollback

Keep the public provider config stable at first:

```ts
export interface ModelAdapterConfig {
  provider: 'openrouter' | 'ollama' | 'mistral' | 'mesh';
  model: string;
  apiKey?: string;
  baseUrl?: string;
  siteUrl?: string;
  siteName?: string;
  maxConcurrentRequests?: number;
}
```

If SDK behavior is uncertain, add an optional transport selector:

```ts
transport?: 'sdk' | 'openai-compatible';
```

Default proposal:

- `openrouter`: `sdk`
- `mistral`: `sdk`
- `mesh`: `sdk`
- `ollama`: `openai-compatible`

This creates a rollback path without changing CLI or SDK users by default.

## Phase 5: Multimodal/File Input Expansion

After SDK adapters are green for existing behavior, implement provider-neutral `file` and `audio` inputs using [INPUT-EXT.md](./INPUT-EXT.md) as the implementation contract.

`INPUT-EXT.md` is the source of truth for:

- shared `file` and `audio` runtime types
- modality-specific capability declarations
- request-surface changes for `RunRequest`, `ChatMessage`, and `DelegateToolInput`
- validation, logging, redaction, and replay behavior
- provider support commitments for OpenRouter, Mistral, and Mesh
- acceptance criteria and tests

Do not treat this document as a second competing spec for `file` or `audio` inputs. Keep `PROVIDER-SDK.md` focused on SDK adapter migration and use `INPUT-EXT.md` for the multimodal extension details.

`video` remains out of scope for the current extension even if some provider SDKs expose video-related types.

## Capability Model Follow-up

The capability-model follow-up for `file` and `audio` is also defined in [INPUT-EXT.md](./INPUT-EXT.md). Follow that document's modality-specific capability shape rather than the earlier sketch ideas in this file.

## Tests

Start with focused adapter tests under `packages/core/src/adapters/adapters.test.ts`.

### OpenRouter tests

- Constructs SDK request with model, messages, and tools.
- Maps system/user/assistant/tool messages correctly.
- Maps assistant tool-call replay and tool result messages correctly.
- Parses text response into `ModelResponse.text`.
- Parses tool calls into `ModelResponse.toolCalls`.
- Maps usage totals.
- Preserves image content part behavior.
- Handles provider errors with deterministic error messages/classes.

### Mistral tests

- Constructs SDK request with model, messages, and tools.
- Maps content strings and content arrays correctly.
- Parses text response into `ModelResponse.text`.
- Parses tool calls into `ModelResponse.toolCalls`.
- Maps usage totals.
- Preserves image content part behavior.
- Handles SDK errors with deterministic error messages/classes.

### Regression tests

- `createModelAdapter()` still creates OpenRouter and Mistral adapters from existing config.
- `createModelAdapter()` still creates Mesh adapters from existing config.
- Ollama still uses the OpenAI-compatible path.
- Existing AdaptiveAgent tool-calling tests continue to pass.
- Existing resume/snapshot tests continue to pass.

## Verification Commands

Use the narrowest checks first:

```bash
bunx vitest run packages/core/src/adapters/adapters.test.ts
bunx vitest run packages/core/src/adaptive-agent.test.ts
bun run --cwd packages/core build
```

If adapter changes affect public exports or CLI config, also run:

```bash
bunx vitest run packages/core-cli/src/config.test.ts
bunx vitest run packages/agent-sdk/src/index.test.ts
```

## Risks And Mitigations

- **SDK package compatibility with Bun:** install and run adapter tests before refactoring broadly.
- **SDK field names differ from REST docs:** rely on installed TypeScript types, not examples alone.
- **SDK validates input before sending:** normalize nested request fields to SDK camelCase/types before calling SDK methods; do not leak REST-only snake_case fields into SDK input.
- **Retry behavior changes:** keep existing retry wrapper semantics around SDK calls if SDK retries are unclear.
- **Streaming shape differs by SDK:** implement `generate()` first; add or update `stream()` only after non-streaming parity is green.
- **Tool-call naming regressions:** preserve current provider tool-name formatting and delegate aliasing tests.
- **Usage accounting differences:** normalize missing token fields to current `UsageSummary` behavior.
- **Provider model capability mismatch:** keep adapter capabilities conservative and document model-dependent multimodal support.

## Suggested Milestones

1. Add SDK dependencies and compile-only imports.
2. Implement OpenRouter SDK `generate()` parity.
3. Implement Mistral SDK `generate()` parity.
4. Implement Mesh SDK `generate()` parity.
5. Restore or implement SDK-backed streaming parity.
6. Run adapter and AdaptiveAgent regression tests.
7. Add optional transport selector only if rollback is needed after testing.
8. Implement `file` and `audio` content model expansion as a separate change using [INPUT-EXT.md](./INPUT-EXT.md); do not expand `video` in that pass.
