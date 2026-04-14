# Channels And Hooks Implementation Plan

## Purpose

This document is a self-contained implementation plan for evolving `packages/gateway-fastify` from its current gateway-centric channel model into a first-class channel-and-hooks architecture that can later support OpenClaw-style channel plugins.

It is written so that a new engineer can pick it up and implement the work phase by phase without needing prior context from an Amp thread.

## Repository Context

- Primary workspace for this effort: `packages/gateway-fastify`
- Runtime stack: Bun + TypeScript + Fastify + Vitest
- Existing package scripts:
  - `bun run build`
  - `bun run test`
  - `bun run typecheck`
- Current gateway responsibilities already include:
  - websocket upgrade auth
  - session creation and reattachment
  - deterministic routing to configured agents
  - chat and structured run orchestration
  - realtime event forwarding
  - reconnect state restoration
  - hook slots in config
  - cron ingress

## Problem Statement

Today, `gateway-fastify` uses the word `channel` for two different concepts:

- configured routing channels such as `web`, `api`, and `public`
- event subscription scopes such as `session:s-1`, `run:r-1`, and `agent:support-agent`

That ambiguity makes it hard to evolve toward a real channel plugin model.

The desired end state is:

- configured channels become first-class runtime extension units
- hooks remain a first-class cross-cutting mechanism and are executed in the live path
- event subscriptions remain supported, but are clearly modeled as a different concept from channel plugins
- the package can later support external channel plugins without rewriting the core gateway again

## Target Architecture

The target architecture should separate these concepts clearly:

- `ConfiguredChannel`: a configured channel instance such as `web`, `public`, or `slack-support`
- `ChannelPlugin`: the implementation for a configured channel instance
- `ResolvedChannel`: a runtime pairing of configured channel instance plus plugin
- `EventSubscription`: the existing observer/filtering scope for realtime events
- `GatewayHookDefinition`: cross-cutting hook handlers that can run at authentication, routing, execution, realtime, outbound, disconnect, and error boundaries

The gateway server remains the orchestrator, but it should resolve channels explicitly and run hooks consistently at the same boundaries for live websocket traffic, reconnects, and scheduler-driven ingress.

## Design Principles

- Prefer additive changes over rewriting major flows.
- Keep existing gateway behavior working between phases.
- Do not introduce external plugin packaging until the internal channel model is stable.
- Keep channel plugin scope intentionally smaller than OpenClaw in the first iteration.
- Separate naming and concepts before broadening runtime behavior.
- Verify each phase with focused tests before moving on.

## Definitions

### Configured Channel

A gateway-facing channel instance declared in gateway config. Examples: `web`, `api`, `public`.

### Event Subscription

A realtime event filter scope used by `channel.subscribe`. Examples: `session:s-1`, `run:r-1`, `root-run:r-root`, `agent:support-agent`.

### Channel Plugin

A first-class runtime extension unit that may influence auth policy, routing policy, inbound behavior, outbound behavior, lifecycle, reconnect policy, and optional module contributions.

### Hook Slot

A named lifecycle boundary where hook modules may inspect, enrich, reject, or observe gateway processing.

## Assumptions

- Current runtime behavior in `packages/gateway-fastify` is the source of truth over earlier docs.
- Phase 0 may already be partially present in the branch, but this plan is written to be executable from scratch if needed.
- Existing websocket protocol shapes should be preserved unless a phase explicitly changes them.
- Existing gateway configs should continue to work throughout the migration.

## Proposed End-State File Layout

This is the intended direction, not a requirement for the first phase.

```text
packages/gateway-fastify/src/
  channels/
    plugin.ts
    runtime.ts
    registry.ts
    builtins/
      gateway-websocket.ts
  event-subscriptions.ts
  hooks.ts
  registries.ts
  server.ts
  auth.ts
  routing.ts
  chat.ts
  run.ts
  reconnect.ts
  scheduler.ts
```

## Execution Order

Implement the sections in this order:

1. Foundations
2. Core Runtime Migration
3. Expansion

Do not skip ahead to external plugins before the foundations and runtime migration are stable.

## Foundations

### Phase 0

#### Goal

Make the live gateway behavior match the documented hook, reconnect, and subscription model.

#### Why This Phase Exists

The package already documents hooks, reconnect state restoration, and channel-based event subscriptions. Those claims must be true in the live request path before introducing more architecture.

#### Scope

- live hook execution
- realtime subscription filtering
- reconnect restoration in the websocket path
- doc alignment

#### Tasks

- Wire `onAuthenticate` into websocket upgrade authentication.
- Wire `onSessionResolve` into session lookup and reconnect handling.
- Wire `beforeRoute` into chat and run dispatch.
- Wire `beforeInboundMessage` into live chat execution.
- Wire `beforeRunStart` into live structured-run execution.
- Wire `afterRunResult` into chat and run completion paths.
- Wire `onAgentEvent` into realtime event forwarding.
- Wire `beforeOutboundFrame` into outbound frame delivery.
- Wire `onDisconnect` into websocket close handling.
- Wire `onError` into unhandled gateway errors.
- Ensure `channel.subscribe` actively filters realtime `agent.event` delivery once subscriptions exist.
- Ensure reconnect via `session.open` with `sessionId` restores active run linkage and subscription scopes.
- Update README to describe the behavior that is actually live.

#### Primary Files

- `packages/gateway-fastify/src/server.ts`
- `packages/gateway-fastify/src/chat.ts`
- `packages/gateway-fastify/src/run.ts`
- `packages/gateway-fastify/src/realtime-events.ts`
- `packages/gateway-fastify/src/reconnect.ts`
- `packages/gateway-fastify/src/bootstrap.ts`
- `packages/gateway-fastify/README.md`

#### Tests To Add Or Update

- `packages/gateway-fastify/src/server.test.ts`
- `packages/gateway-fastify/src/reconnect.test.ts`
- `packages/gateway-fastify/src/hooks.test.ts`

#### Verification

- `bun run typecheck`
- `bunx vitest run src/server.test.ts src/reconnect.test.ts src/hooks.test.ts`
- `bun run test`

#### Exit Criteria

- Hook slots are executed in live websocket request handling.
- Realtime events are filtered by subscriptions when subscriptions exist.
- Reconnect returns current state and restores subscriptions.
- README matches current runtime behavior.

#### Non-Goals

- no new plugin abstractions yet
- no config shape changes yet
- no external plugin loading yet

### Phase 1

#### Goal

Introduce the `ChannelPlugin` and `ChannelRuntimeContext` types without changing runtime behavior.

#### Why This Phase Exists

This phase establishes the future architecture boundary in code so later changes have stable types and terms.

#### Scope

- channel plugin interfaces
- runtime context types
- registry support for channel plugins
- no behavior change

#### Tasks

- Add `ChannelPlugin` interface with the first-pass adapters:
  - `config`
  - `auth`
  - `routing`
  - `inbound`
  - `outbound`
  - `lifecycle`
  - `reconnect`
  - `modules`
- Add `ChannelPluginMeta`, `ConfiguredChannel`, `ResolvedChannel`, and related helper types.
- Add `ChannelRuntimeContext` and request-specific context types.
- Extend `ModuleRegistry` to register and resolve channel plugins.
- Export the new public types from the package entrypoint.
- Preserve full backward compatibility with the current config model.

#### Primary Files

- `packages/gateway-fastify/src/registries.ts`
- `packages/gateway-fastify/src/config.ts`
- `packages/gateway-fastify/src/index.ts`

#### New Files

- `packages/gateway-fastify/src/channels/plugin.ts`
- `packages/gateway-fastify/src/channels/runtime.ts`

#### Tests To Add Or Update

- `packages/gateway-fastify/src/registries.test.ts`
- `packages/gateway-fastify/src/config.test.ts`

#### Verification

- `bun run typecheck`
- `bunx vitest run src/registries.test.ts src/config.test.ts`
- `bun run test`

#### Exit Criteria

- Channel plugin types exist and compile.
- The registry can register channel plugins.
- No runtime behavior has changed yet.

#### Non-Goals

- no channel plugin execution in runtime yet
- no file renames yet

### Phase 2

#### Goal

Separate event subscription concepts from channel plugin concepts in naming and module structure.

#### Why This Phase Exists

The codebase currently uses `channels.ts` for event subscriptions. That will become a major source of confusion once channel plugins are introduced.

#### Scope

- renaming and concept cleanup
- no major behavior change

#### Tasks

- Rename the current `channels.ts` subscription module to `event-subscriptions.ts` or similar.
- Update imports across the package.
- Update docs and comments to reserve the term `channel` for configured channels and channel plugins.
- Update tests to reflect the renamed module.

#### Primary Files

- `packages/gateway-fastify/src/channels.ts`
- `packages/gateway-fastify/src/server.ts`
- `packages/gateway-fastify/src/outbound.ts`
- `packages/gateway-fastify/src/index.ts`
- `packages/gateway-fastify/README.md`

#### Tests To Add Or Update

- `packages/gateway-fastify/src/channels.test.ts`
- `packages/gateway-fastify/src/server.test.ts`
- `packages/gateway-fastify/src/outbound.test.ts`

#### Verification

- `bun run typecheck`
- `bun run test`

#### Exit Criteria

- Engineers can distinguish event subscriptions from channel plugins by name alone.
- The runtime still behaves the same.

#### Non-Goals

- no pluginized configured channels yet

## Core Runtime Migration

### Phase 3

#### Goal

Make every configured channel resolve through a built-in channel plugin registry while preserving current behavior.

#### Why This Phase Exists

The easiest migration path is to model current `web`, `api`, and `public` behavior as a built-in plugin before supporting any new plugin types.

#### Scope

- registry-backed channel resolution
- built-in default channel plugin
- backward-compatible config defaults

#### Tasks

- Add channel resolution helpers that map a configured channel instance to a registered `ChannelPlugin`.
- Introduce a built-in `gateway-websocket` channel plugin that represents the current baseline behavior.
- Allow configured channels to declare `plugin`, but default to `gateway-websocket` when omitted.
- Fail fast at bootstrap if a configured channel references an unknown plugin.

#### Primary Files

- `packages/gateway-fastify/src/bootstrap.ts`
- `packages/gateway-fastify/src/config.ts`
- `packages/gateway-fastify/src/registries.ts`

#### New Files

- `packages/gateway-fastify/src/channels/registry.ts`
- `packages/gateway-fastify/src/channels/builtins/gateway-websocket.ts`

#### Tests To Add Or Update

- `packages/gateway-fastify/src/bootstrap.test.ts`
- `packages/gateway-fastify/src/config.test.ts`
- `packages/gateway-fastify/src/registries.test.ts`

#### Verification

- `bun run typecheck`
- `bunx vitest run src/bootstrap.test.ts src/config.test.ts src/registries.test.ts`
- `bun run test`

#### Exit Criteria

- Every configured channel can be resolved through the registry.
- Existing configs still work with no migration required.
- The built-in plugin reproduces today’s behavior.

#### Non-Goals

- no external plugins yet
- no Slack or WhatsApp-style integrations yet

### Phase 4

#### Goal

Make websocket upgrade authentication channel-aware.

#### Why This Phase Exists

Public/private channel policy and future channel-specific auth need to be driven by the resolved channel plugin, not only by hardcoded gateway checks.

#### Scope

- channel-aware auth resolution
- auth-provider reuse
- hook ordering around authentication

#### Tasks

- Resolve the configured channel during websocket upgrade using `channelId`.
- Move public/private channel policy behind the channel plugin auth adapter.
- Keep the existing gateway auth provider mechanism for shared JWT handling.
- Allow channel plugins to augment or override upgrade auth policy where appropriate.
- Ensure `onAuthenticate` still runs after the effective auth decision.

#### Primary Files

- `packages/gateway-fastify/src/auth.ts`
- `packages/gateway-fastify/src/server.ts`
- `packages/gateway-fastify/src/channels/registry.ts`
- `packages/gateway-fastify/src/channels/builtins/gateway-websocket.ts`

#### Tests To Add Or Update

- `packages/gateway-fastify/src/auth.test.ts`
- `packages/gateway-fastify/src/server.test.ts`

#### Verification

- `bun run typecheck`
- `bunx vitest run src/auth.test.ts src/server.test.ts`
- `bun run test`

#### Exit Criteria

- Public/private channel behavior is channel-driven.
- JWT auth still works for current clients.
- Hook ordering remains correct and tested.

#### Non-Goals

- no new auth providers beyond the current gateway model

### Phase 5

#### Goal

Make session handling, routing, and invocation policy channel-aware.

#### Why This Phase Exists

Channel plugins need to influence how inbound traffic is interpreted before chat and run execution, especially for allowed invocation modes and routing hints.

#### Scope

- channel-aware session resolution
- channel-aware routing policy
- inbound metadata enrichment

#### Tasks

- Resolve the effective configured channel from `session.open`, `message.send`, and `run.start`.
- Pass `ResolvedChannel` through the live request path.
- Let channel plugins enrich request metadata before chat and run execution.
- Let channel plugins influence allowed invocation modes.
- Keep the current deterministic gateway binding model as the primary router.

#### Primary Files

- `packages/gateway-fastify/src/session.ts`
- `packages/gateway-fastify/src/routing.ts`
- `packages/gateway-fastify/src/chat.ts`
- `packages/gateway-fastify/src/run.ts`
- `packages/gateway-fastify/src/server.ts`

#### Tests To Add Or Update

- `packages/gateway-fastify/src/routing.test.ts`
- `packages/gateway-fastify/src/server.test.ts`
- `packages/gateway-fastify/src/transcript.test.ts`

#### Verification

- `bun run typecheck`
- `bunx vitest run src/routing.test.ts src/server.test.ts src/transcript.test.ts`
- `bun run test`

#### Exit Criteria

- Chat and run execution have access to `ResolvedChannel`.
- Invocation mode policy can be influenced by channel plugins.
- Existing routing behavior remains deterministic.

#### Non-Goals

- no alternate routing engine
- no removal of current gateway bindings

### Phase 6

#### Goal

Make outbound delivery, realtime events, and reconnect policies channel-aware.

#### Why This Phase Exists

A first-class channel model needs some control over outbound behavior, even if the gateway still owns the websocket transport.

#### Scope

- channel-aware outbound delivery
- realtime shaping
- reconnect policy hooks

#### Tasks

- Pass `ResolvedChannel` into realtime event forwarding.
- Let channel plugins observe or shape outbound frames before send.
- Let channel plugins participate in reconnect subscription selection.
- Preserve existing websocket message shapes unless a future phase intentionally expands them.

#### Primary Files

- `packages/gateway-fastify/src/realtime-events.ts`
- `packages/gateway-fastify/src/server.ts`
- `packages/gateway-fastify/src/reconnect.ts`
- `packages/gateway-fastify/src/channels/builtins/gateway-websocket.ts`

#### Tests To Add Or Update

- `packages/gateway-fastify/src/server.test.ts`
- `packages/gateway-fastify/src/reconnect.test.ts`
- `packages/gateway-fastify/src/local-ws-client.test.ts`

#### Verification

- `bun run typecheck`
- `bunx vitest run src/server.test.ts src/reconnect.test.ts src/local-ws-client.test.ts`
- `bun run test`

#### Exit Criteria

- Realtime and reconnect logic are channel-aware.
- Existing clients continue to work.
- Hooks and channel outbound behavior do not conflict.

#### Non-Goals

- no replacement of websocket transport with custom transports yet

## Expansion

### Phase 7

#### Goal

Allow channel plugins to contribute tools, delegates, and hooks.

#### Why This Phase Exists

OpenClaw-style channel plugins often bundle channel-local capabilities. This phase allows that while keeping the registry model centralized.

#### Scope

- module contributions from channel plugins
- deterministic merge semantics

#### Tasks

- Define how a channel plugin contributes `ToolDefinition[]`, `DelegateDefinition[]`, and `GatewayHookDefinition[]`.
- Merge those contributions into existing registry and agent resolution flows.
- Ensure duplicate names are handled deterministically and fail fast when needed.

#### Primary Files

- `packages/gateway-fastify/src/registries.ts`
- `packages/gateway-fastify/src/agent-registry.ts`
- `packages/gateway-fastify/src/channels/plugin.ts`
- `packages/gateway-fastify/src/channels/builtins/gateway-websocket.ts`

#### Tests To Add Or Update

- `packages/gateway-fastify/src/registries.test.ts`
- `packages/gateway-fastify/src/agent-registry.test.ts`

#### Verification

- `bun run typecheck`
- `bunx vitest run src/registries.test.ts src/agent-registry.test.ts`
- `bun run test`

#### Exit Criteria

- Channel plugins can contribute modules safely.
- Agent resolution remains deterministic.

#### Non-Goals

- no external loading mechanism yet

### Phase 8

#### Goal

Make scheduler and cron paths resolve channels consistently with live websocket traffic.

#### Why This Phase Exists

If scheduled ingress bypasses channel policy, the architecture becomes inconsistent and harder to reason about.

#### Scope

- channel-aware cron ingress
- consistent behavior across live and scheduled traffic

#### Tasks

- Resolve channels for `session_event`, `isolated_run`, and `isolated_chat` targets where applicable.
- Let channel plugins influence cron ingress policy as needed.
- Keep current delivery modes unless there is a concrete need to expand them.

#### Primary Files

- `packages/gateway-fastify/src/scheduler.ts`
- `packages/gateway-fastify/src/cron-delivery.ts`
- `packages/gateway-fastify/src/stores.ts`

#### Tests To Add Or Update

- `packages/gateway-fastify/src/scheduler.test.ts`
- `packages/gateway-fastify/src/cron-delivery.test.ts`
- `packages/gateway-fastify/src/stores-postgres-cron.test.ts`

#### Verification

- `bun run typecheck`
- `bunx vitest run src/scheduler.test.ts src/cron-delivery.test.ts src/stores-postgres-cron.test.ts`
- `bun run test`

#### Exit Criteria

- Scheduler-driven ingress respects the same channel semantics as websocket traffic.
- No regression in lease, dispatch, or delivery behavior.

#### Non-Goals

- no new scheduler product features

### Phase 9

#### Goal

Support loading channel plugins from outside the package.

#### Why This Phase Exists

Only after the internal model is stable should the package expose an extension story to third parties or other workspaces.

#### Scope

- local or package-based plugin loading
- compatibility contract
- sample external plugin

#### Tasks

- Decide the first supported loading model:
  - workspace-local modules
  - package-based modules
  - or both in sequence
- Extend local module loading to discover channel plugins.
- Define a minimal compatibility contract and plugin registration entrypoint.
- Add one sample external channel plugin and verify end-to-end registration.

#### Primary Files

- `packages/gateway-fastify/src/local-modules.ts`
- `packages/gateway-fastify/src/bootstrap.ts`
- `packages/gateway-fastify/src/channels/registry.ts`

#### Tests To Add Or Update

- `packages/gateway-fastify/src/local-modules.test.ts`
- integration tests for external plugin registration

#### Verification

- `bun run typecheck`
- `bun run test`

#### Exit Criteria

- At least one external channel plugin can be registered without modifying core gateway code.
- Internal built-in channels still work unchanged.

#### Non-Goals

- no large marketplace or package manifest system

### Phase 10

#### Goal

Finalize docs, examples, and maintenance guidance for the new architecture.

#### Why This Phase Exists

After the architecture stabilizes, the docs need to reflect the final mental model so future changes do not regress into mixed concepts again.

#### Scope

- architecture docs
- plugin authoring guidance
- examples
- cleanup of stale terminology

#### Tasks

- Update `packages/gateway-fastify/README.md` with the final architecture.
- Add an example gateway config using explicit built-in channel plugins.
- Document the difference between:
  - configured channels
  - channel plugins
  - event subscriptions
  - hooks
- Document hook ordering and runtime guarantees.
- Document the minimal channel plugin authoring contract.
- Remove stale wording that treats event subscriptions as the same thing as configured channels.

#### Primary Files

- `packages/gateway-fastify/README.md`
- `packages/gateway-fastify/src/index.ts`
- any example config files added in earlier phases

#### Tests To Add Or Update

- no code-specific tests required unless docs examples become executable fixtures

#### Verification

- manual doc review against runtime behavior
- `bun run build`
- `bun run typecheck`
- `bun run test`

#### Exit Criteria

- Docs are aligned with runtime behavior.
- A new contributor can understand the architecture from docs alone.
- The package no longer uses overloaded terminology ambiguously.

#### Non-Goals

- no new runtime functionality beyond doc alignment and polish

## Recommended Working Order Within Each Phase

For each phase, implement in this order:

1. update types and function signatures
2. add or update focused tests
3. implement runtime logic
4. run focused verification
5. run package-wide verification
6. update docs if the phase changes public behavior

## Risks To Watch Throughout The Plan

- naming collisions between event subscriptions and configured channels
- accidental breaking changes to websocket protocol shapes
- hook execution becoming inconsistent across live and scheduled ingress
- plugin contributions creating duplicate tool, delegate, or hook names
- allowing external plugin loading before the internal channel model is stable

## Success Criteria For The Full Program

The overall initiative is complete when all of the following are true:

- hooks execute consistently at all supported runtime boundaries
- configured channels are first-class runtime entities resolved through a registry
- event subscriptions remain supported but are clearly separate from channel plugins
- the built-in websocket channel behavior is implemented as a channel plugin
- cron and reconnect flows use the same channel semantics as live websocket traffic
- at least one external channel plugin can be loaded without changing gateway core
- docs describe the final model clearly and accurately

## Final Note

If implementation capacity is limited, prioritize the phases in this order:

1. Phase 0
2. Phase 1
3. Phase 2
4. Phase 3
5. Phase 4
6. Phase 5
7. Phase 6
8. Phase 8
9. Phase 7
10. Phase 9
11. Phase 10

This order keeps the architecture grounded in runtime correctness before expansion.
