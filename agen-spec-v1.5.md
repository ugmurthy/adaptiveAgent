# High-Level Product Specification: AdaptiveAgent Library

**Version**: 1.5 (May 2026)
**Target Stack**: Bun + TypeScript
**Optional Example UI**: Svelte 5 + SvelteKit dashboard example
**Core Principle**: Keep the runtime small, typed, resumable, observable, and safe to extend into hierarchical supervision.

## 1. Scope

This document supersedes `agen-spec-v1.4.md` for the currently implemented runtime surface.

Unless explicitly replaced below, the v1.4 product goals, design rules, and delegation boundary remain in force.

## 2. What Changed From v1.4

The current implementation has moved ahead of the published v1.4 docs in a few important places. v1.5 formalizes those changes:

- input modalities are `text` and `image`
- model capability declarations may include `imageInput`
- model messages may carry structured content parts rather than only plain strings
- assistant/model replay may preserve `reasoning` and `reasoningDetails`
- model requests may expose retry callbacks for provider retry observability
- tool execution and runtime wiring include additional host/runtime extension points already present in code

## 3. Input Modality Boundary

AdaptiveAgent currently supports only these input modalities:

- `text`
- `image`

The runtime does not standardize provider-neutral `file`, `audio`, or `video` inputs in v1.5.

When an image is supplied, it is represented as structured message content and normalized by the provider adapter into the provider SDK or transport shape. Local images may be encoded as data URLs by the adapter when required by the provider.

## 4. Model Adapter Contract Notes

The `ModelAdapter` boundary remains the public execution boundary for providers.

Provider adapters must:

- accept internal `ModelRequest`
- normalize nested message/content fields to the provider SDK field names
- preserve tool calling, structured output, usage accounting, abort signals, retry observability, and resumability
- reject image-bearing requests when the adapter does not declare `imageInput`

Current reference adapters are:

- `OpenRouterAdapter`, backed by `@openrouter/sdk`
- `MistralAdapter`, backed by `@mistralai/mistralai`
- `MeshAdapter`, backed by `meshapi-node-sdk`
- `OllamaAdapter`, backed by the OpenAI-compatible `/chat/completions` path

## 5. Reasoning And Replay

The runtime may preserve assistant-side reasoning metadata in structured form for provider replay compatibility:

- `reasoning`
- `reasoningDetails`

This metadata is for protocol continuity and observability. The runtime should continue emitting status/progress summaries rather than exposing hidden chain-of-thought as a first-class user-facing stream.

## 6. Retry Observability

Model adapters may surface retry activity through request-scoped callbacks so hosts can observe rate limiting and provider retries without breaking the stable `ModelAdapter` abstraction.

This does not change the core rule that retry behavior must remain bounded, deterministic, and resumable.

## 7. Compatibility

v1.5 is intended as an additive contract-alignment release over v1.4:

- no change to the central `Tool` boundary
- no change to persisted-plan restrictions around `delegate.*`
- no introduction of parallel child runs, child messaging, or generalized workflow DAGs
- no expansion beyond `text` and `image` input modalities
