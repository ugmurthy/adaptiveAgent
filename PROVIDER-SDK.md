# Provider SDK Adapter Implementation Plan

This plan describes replacing the current hand-written OpenAI-compatible HTTP path with provider SDK adapters for OpenRouter and Mistral first. Mesh is intentionally deferred until its Node.js SDK package and registry details are confirmed.

## Goals

- Add provider-native SDK adapters for OpenRouter and Mistral behind the existing `ModelAdapter` contract.
- Preserve current AdaptiveAgent runtime behavior: tool calling, JSON output, streaming, usage accounting, retries, logging, snapshots, and resumability.
- Keep the current OpenAI-compatible adapter as a fallback for Ollama, Mesh, custom endpoints, and rollback.
- Prepare the adapter layer for richer multimodal inputs without forcing a large first change.

## Non-goals

- Do not implement Mesh SDK support in this phase.
- Do not remove `BaseOpenAIChatAdapter`.
- Do not switch AdaptiveAgent to OpenAI Responses semantics globally.
- Do not add broad file/audio/video support in the first SDK-adapter milestone unless required by SDK typing.

## Current State

The current provider adapters are thin subclasses of `BaseOpenAIChatAdapter`:

- `OpenRouterAdapter` posts to `https://openrouter.ai/api/v1/chat/completions`.
- `MistralAdapter` posts to `https://api.mistral.ai/v1/chat/completions`.
- `MeshAdapter` posts to `https://api.meshapi.ai/v1/chat/completions`.
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
    "@mistralai/mistralai": "<pinned-version>"
  }
}
```

Use Bun-native install/update commands:

```bash
bun add --cwd packages/core @openrouter/sdk @mistralai/mistralai
```

Pin the versions committed to `bun.lock` after checking install compatibility.

## Proposed Adapter Shape

Keep `BaseOpenAIChatAdapter` and add SDK-backed adapters:

```text
packages/core/src/adapters/
  base-openai-chat-adapter.ts       # existing fallback/shared parser reference
  openrouter-adapter.ts             # can become SDK-backed or delegate to SDK implementation
  mistral-adapter.ts                # can become SDK-backed or delegate to SDK implementation
  mesh-adapter.ts                   # unchanged for now
  ollama-adapter.ts                 # unchanged
  provider-message-mapping.ts       # optional shared internal mapping helpers
```

Prefer the smallest initial implementation:

- Update `OpenRouterAdapter` to use `@openrouter/sdk` directly.
- Update `MistralAdapter` to use `@mistralai/mistralai` directly.
- Keep constructor config and public exports stable.
- Keep `createModelAdapter()` config shape stable.

If the SDK response shapes make each adapter too large, split provider-specific helpers into small local functions in the same file first. Create shared files only if duplication becomes meaningful.

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
- `ModelToolCall` replay -> assistant `tool_calls`.
- Tool result messages -> `role: 'tool'` with `tool_call_id`.
- `outputSchema` -> structured output/JSON schema field supported by OpenRouter SDK.
- Response `choices[0].message` -> `ModelResponse`.
- Usage -> `UsageSummary`.

### Compatibility points

- Preserve delegate tool name aliasing behavior currently implemented by the base adapter.
- Preserve reasoning/reasoning-details round trip if OpenRouter returns those fields.
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

## Phase 3: Transport Selection And Rollback

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
- `mesh`: `openai-compatible`
- `ollama`: `openai-compatible`

This creates a rollback path without changing CLI or SDK users by default.

## Phase 4: Multimodal/File Input Expansion

After SDK adapters are green for existing behavior, extend the internal content model.

Current content model supports only text and image:

```ts
export type ModelContentPart = ModelTextContentPart | ModelImageContentPart;
```

Add provider-neutral content parts later:

```ts
export interface FileInput {
  path?: string;
  url?: string;
  fileId?: string;
  filename?: string;
  mimeType?: string;
  name?: string;
}

export interface AudioInput {
  path?: string;
  data?: string;
  format?: string;
  mimeType?: string;
  name?: string;
}

export interface VideoInput {
  path?: string;
  url?: string;
  mimeType?: string;
  name?: string;
}
```

Then extend `ModelContentPart` with:

```ts
| { type: 'file'; file: FileInput }
| { type: 'audio'; audio: AudioInput }
| { type: 'video'; video: VideoInput }
```

Provider mapping can then be additive:

- OpenRouter: image URL/data URL, PDF/file part, audio, video, PDF parser plugins.
- Mistral: image chunks, document URL/file chunks, OCR/document APIs where appropriate.
- Mesh: defer until SDK package details are confirmed.

## Capability Model Follow-up

Current `ModelCapabilities` has only `imageInput?: boolean` for multimodal input. Before broad file support, replace or supplement it with provider-neutral capabilities:

```ts
inputModalities?: Array<'text' | 'image' | 'file' | 'audio' | 'video'>;
inputSources?: Array<'path' | 'url' | 'base64' | 'file_id'>;
supportedMimeTypes?: string[];
providerFeatures?: Record<string, boolean>;
```

Do this after SDK adapters are stable unless a provider SDK requires it earlier.

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
- Mesh and Ollama still use the OpenAI-compatible path.
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
- **Retry behavior changes:** keep existing retry wrapper semantics around SDK calls if SDK retries are unclear.
- **Streaming shape differs by SDK:** implement `generate()` first; add or update `stream()` only after non-streaming parity is green.
- **Tool-call naming regressions:** preserve current provider tool-name formatting and delegate aliasing tests.
- **Usage accounting differences:** normalize missing token fields to current `UsageSummary` behavior.
- **Provider model capability mismatch:** keep adapter capabilities conservative and document model-dependent multimodal support.

## Mesh Deferral

Mesh SDK support is deferred until package availability is confirmed. The expected package from docs is:

```bash
npm install meshapi-node-sdk
```

Before implementing Mesh SDK support, verify:

- package registry and version,
- Bun install compatibility,
- exported TypeScript types,
- `client.chat.completions.create()` request/response shapes,
- `client.responses` and `client.files` schemas,
- streaming and error behavior.

Until then, keep `MeshAdapter` on `BaseOpenAIChatAdapter`.

## Suggested Milestones

1. Add SDK dependencies and compile-only imports.
2. Implement OpenRouter SDK `generate()` parity.
3. Implement Mistral SDK `generate()` parity.
4. Restore or implement SDK-backed streaming parity.
5. Run adapter and AdaptiveAgent regression tests.
6. Add optional transport selector only if rollback is needed after testing.
7. Plan file/audio/video content model expansion as a separate change.
