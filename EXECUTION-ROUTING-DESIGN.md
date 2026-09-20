# Adaptive Execution Routing Design

## Status and scope

This document defines an engine-neutral routing boundary for Agent SDK runs and
a phased migration from the current deterministic orchestration planner. Phase
1 enhances only explicit `run --orchestrate`. Plain `run` behavior remains
unchanged. Phase 2 may add opt-in automatic direct-versus-orchestration routing.

The design follows `CORE-SESSION-SWARM-SPEC.md`: Agent SDK owns CLI intent,
agent-profile discovery, safe catalog summaries, routing prompts, and the
translation into strict execution requests. Core owns durable run and
orchestration execution semantics, persistence, recovery, and execution-time
validation. Existing agent JSON profiles remain the source of model, tools,
instructions, delegates, and capability metadata.

## Current behavior

For an ordinary `run` with `settings.agent.mode: "auto"`, Agent SDK discovers
active profiles and filters them to profiles that are valid, support `run`, and
declare support for every supplied attachment modality. Missing capability
metadata means text-only. The configured `agentSelection.engine` then chooses
one profile: `"agent"` uses a tool-free agent run, while `"typesafe"` uses the
TypeSafe/JEV adapter. The agent engine may use `taskPreparation.agent` as its
legacy selector fallback.

Selection occurs before task preparation. Consequently the selected execution
profile is also the target profile supplied to task preparation, and prepared
task reuse is checked against that profile. Selection and task preparation are
separate decisions even when the same configured profile performs both.

`--orchestrate` is currently an explicit, forced CLI decision. It does not ask
either selection engine whether execution should be direct or orchestrated.
The deterministic orchestration planner detects modalities and subject hints,
chooses specialists, and optionally runs requested-agent synthesis. Its CLI
catalog currently contains only repeated `--catalog` entries plus the requested
agent. It does not automatically include all valid active profiles discovered
from configured `agents.dirs`.

The current orchestration implementation persists a plan and catalog
fingerprint, creates durable stage records, validates the fingerprint on
resume, and recovers or resumes stage runs. Modality specialists are currently
chosen independently per modality, which can create duplicate nodes for one
multimodal agent.

## Concepts and boundary

Task preparation normalizes or clarifies what should be done. Execution routing
decides which already-known profiles should execute it and in what supported
shape. These concerns must remain separate even if one profile participates in
both.

The common boundary is `ExecutionRoutingDecision`. It is independent of the
selection engine and contains references only to catalog agent IDs:

```ts
type ExecutionRoutingMode = 'direct' | 'orchestration';

interface ExecutionRoutingAssignment {
  agentId: string;
  modalities: SupportedModality[];
  reason: string;
}

interface ExecutionRoutingDecision {
  mode: ExecutionRoutingMode;
  primaryAgentId: string;
  synthesisAgentId?: string;
  assignments: ExecutionRoutingAssignment[];
  selectedCatalogAgentIds: string[];
  reason: string;
  confidence?: number;
  source: 'deterministic' | 'agent' | 'typesafe';
}
```

`primaryAgentId` is the direct execution agent or the requested/coordinating
profile for orchestration. `synthesisAgentId`, when present, identifies the
profile that consumes specialist results. `assignments` are validated
agent-to-modality assignments; multiple modalities assigned to one profile are
one assignment and therefore one specialist node. `selectedCatalogAgentIds` is
the stable, deduplicated set used for observability and compatibility checks.
Reason and optional confidence explain the choice without embedding profile
contents.

An engine adapter may propose a decision, but Agent SDK validates and
normalizes it before plan construction. Both `agentSelection.engine: "agent"`
and `agentSelection.engine: "typesafe"` can produce the same decision shape.
Phase 1 uses a deterministic adapter for explicit orchestration; Phase 2 may
add agent and TypeSafe/JEV routing adapters without coupling plan execution to
either service.

## Trust and validation

Model or JEV output may propose only known catalog agent IDs, execution mode,
and modality assignments. It cannot supply config paths, profile definitions,
models, tools, instructions, credentials, provider settings, or arbitrary
stage graphs. Agent SDK resolves IDs to the already-loaded catalog and validates:

- every selected ID is a valid, active profile that supports `run`;
- every assignment contains known, detected modalities;
- every assigned profile declares coverage for every assigned modality;
- every non-text input claim is assigned exactly once when specialists are
  required, with no attachment silently discarded;
- direct mode's primary profile supports all input modalities;
- orchestration uses only the supported flat fan-out plus optional synthesis
  shape and stays within configured candidate, stage, cost, and latency limits;
- synthesis and requested-agent behavior obey CLI precedence; and
- missing capability metadata is interpreted as text-only.

Core and provider checks remain authoritative at execution time. Agent SDK
validation improves errors and prevents invalid stages from launching, but does
not replace runtime validation. The entire decision and plan must be validated
before the first stage is launched.

## Precedence and compatibility

Routing applies these rules in order:

1. Plain `run` semantics are unchanged in Phase 1. Existing fixed and automatic
   single-agent selection continue to work as today.
2. Explicit `--orchestrate` forces orchestration routing. It may retain the
   existing one-node execution shape when the requested profile covers all
   inputs and no stronger modality or subject specialist exists.
3. Explicit `--agent` remains the fixed primary and synthesis profile. Under
   `--orchestrate`, specialists may still be selected exactly as orchestration
   already permits; routing must not replace the requested profile with a new
   primary.
4. Explicit `--catalog` remains additive and compatible. Phase 1 also makes
   valid active `run` profiles from configured `agents.dirs` available.
5. Phase 2 may add an explicit opt-in mode in which an engine chooses direct
   versus orchestration. It must not silently change default plain `run`.

Catalog discovery uses the existing Agent SDK inventory rules. Invalid profiles
are diagnostics and are excluded. For duplicate IDs, the existing deterministic
inventory winner is the only eligible profile and duplicate entries remain
diagnosable. Explicit catalog entries are resolved by the existing name/path
rules and must not produce ambiguous hidden overrides.

## Input inventory and deterministic assignment

Routing inventories the goal, `images`, typed `contentParts`, and recognized
structured `input` claims. The inventory records modality, source, index, MIME
type, and display name where available; it does not read or disclose attachment
contents merely to route them.

The deterministic adapter scores each candidate for each detected modality:

- declared support is mandatory;
- preferred modality, `analyze` role, and established specialist naming add
  deterministic preference;
- narrower capable profiles win after specialist score;
- agent ID is the final stable tie-breaker.

The requested profile is retained when it supports all detected modalities and
no candidate has a strict specialist or subject advantage. Otherwise each
required modality is assigned to the highest-ranked eligible candidate.
Assignments are then grouped by agent ID. For example, one profile selected for
both image and audio receives one node with both sets of attachment claims, not
two runs. Separate winners receive separate parallel nodes.

Text goal context accompanies every specialist. Raw attachments accompany only
the node assigned their claims. Subject-only specialists receive the goal and
do not duplicate unrelated attachments. If synthesis is enabled, the requested
profile receives upstream results and only raw attachments it supports. This
preserves provider/runtime checks and never drops an unsupported attachment to
make a stage pass.

## Synthesis

The default explicit-orchestration shape remains specialist fan-out followed by
requested-agent synthesis. A one-node requested-agent plan needs no synthesis.
The synthesis profile is an existing catalog ID, normally the requested agent;
its model and instructions come from its JSON profile. Synthesis receives the
original objective, typed upstream results, and any raw modalities it declares
it can consume. Specialist failures follow the existing orchestration failure
policy.

No nested orchestration, arbitrary DAG proposed by a model, or multi-child
parent run model is introduced. The durable representation remains one
orchestration execution with independent root stage runs and dependencies.

## Persistence and observability

Persist the validated routing decision with, or as part of, the durable plan.
The plan and lifecycle/output summaries must expose:

- routing mode and source;
- primary and optional synthesis agent IDs;
- grouped agent-to-modality assignments;
- selected catalog agent IDs;
- detected modalities and subject matches;
- routing reason and optional confidence; and
- the credential-free catalog fingerprint.

Stage metadata continues to identify selected agent, stage, node, dependencies,
and routing reason. Recovery reconstructs execution from the persisted validated
plan and rejects a changed catalog fingerprint. Fingerprints may include stable
profile execution fields but must omit inline API keys and other credentials.
Model-visible summaries use safe descriptors only: IDs, names, descriptions,
invocation modes, declared capabilities, tool/delegate names, and routing hints
specifically approved for selection. They must not include raw private config,
paths, environment values, API keys, or profile instructions.

## Confidence, fallback, cost, and latency

Deterministic routing has an explainable score and reason but no synthetic
probability. Model/JEV adapters may provide confidence. Agent SDK applies
configured confidence thresholds before execution. A low-confidence automatic
proposal falls back only to a policy-defined safe outcome (normally the fixed
requested agent if it covers all inputs) or fails before launch; it must not
guess, silently omit claims, or invent a profile.

Candidate count, model calls, specialist stages, parallelism, timeout, and
estimated spend must be bounded. Phase 1 performs no paid routing call and
retains existing orchestration concurrency. Phase 2 should score the bounded
candidate-by-modality matrix in one routing evaluation where possible, cap the
number of selected specialists, and prefer direct execution when expected
quality gain does not justify fan-out latency/cost.

## Security and privacy

Discovery is metadata-only and must not import tool or delegate handlers.
Routing does not expose config paths, environment variables, inline credentials,
provider secrets, profile instructions, or attachment bytes to a selector.
Only minimal attachment type/count metadata and safe catalog summaries may be
sent to an external routing engine. Deployments must treat objective text,
attachment names, MIME types, and capability descriptions as potentially
sensitive and apply provider policy before enabling external routing.

Execution remains constrained by each selected profile's tools, delegates,
workspace, provider authorization, and runtime policy. A routing decision does
not grant capabilities or bypass approval, permit, modality, or provider checks.

## Task-preparation ordering

Current compatibility requires selection before preparation. Changing that
order can alter the preparation target, preparation-run reuse identity, prompt,
selected profile, metadata, and user-visible prepared task. Phase 1 therefore
does not reorder ordinary runs.

The desired long-term flow is:

1. inventory and normalize inputs;
2. prepare the objective using a preparation profile independent of the
   eventual executor;
3. route the normalized objective and inventory;
4. validate the decision against the exact catalog snapshot; and
5. execute or persist a resumable plan.

Migration requires a versioned preparation contract whose identity is not tied
to an execution profile, explicit compatibility behavior for old preparation
runs, and metadata that records both preparation and routing actors. Until that
contract exists, Phase 2 must either preserve current ordering or expose the new
ordering only through an opt-in mode.

## Rollout

### Phase 1: explicit orchestration

- Keep plain `run` and current selection engines unchanged.
- Feed `run --orchestrate` the deterministic valid active `run` catalog from
  configured `agents.dirs`, plus compatible explicit `--catalog` entries and
  the requested profile.
- Introduce and validate the engine-neutral routing decision boundary.
- Group multiple modality assignments to the same specialist into one node.
- Persist and emit routing decision metadata and catalog fingerprint without
  secrets.
- Retain the existing durable plan, stage, retry, pause/resume, and recovery
  behavior.

### Phase 2: opt-in adaptive execution routing (implemented)

- Add agent and TypeSafe/JEV adapters that propose the common decision shape.
- Add an explicit opt-in for automatic direct-versus-orchestration selection.
- Define confidence fallback and bound specialist fan-out with
  `maxSpecialists`.
- Decide and version preparation-before-routing migration behavior.
- Evaluate deterministic versus learned routing on representative multimodal
  and subject-specialist cases before changing defaults.

The implemented compatibility choice preserves selection/routing before task
preparation. `executionRouting.mode: "adaptive"` is the explicit opt-in;
`maxSpecialists` bounds fan-out and `lowConfidenceFallback` controls safe direct
fallback versus failure. Preparation-before-routing remains a possible future
versioned migration rather than a Phase 2 behavior change.

### Later phases

- Consider calibrated quality/cost feedback and policy tuning using persisted
  routing outcomes.
- Consider generalized token, dollar, and deadline budgets beyond the Phase 2
  specialist-count bound.
- Consider making adaptive routing a default only after compatibility,
  privacy, latency, and quality gates are met.

## Non-goals

- Changing plain `run` behavior in Phase 1.
- Replacing agent JSON profiles with a new catalog schema.
- Letting a selector invent config paths, profiles, tools, models, or prompts.
- Moving profile discovery or CLI policy into core.
- Moving durable execution semantics into Agent SDK.
- Nested orchestration, arbitrary model-authored DAGs, parallel child runs under
  one parent run, child messaging, or a separate swarm identity.
- Silently converting, dropping, or weakening validation for attachments.
- Live paid TypeSafe/JEV calls as part of Phase 1 routing or tests.
