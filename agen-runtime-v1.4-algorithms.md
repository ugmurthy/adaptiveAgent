# AdaptiveAgent v1.4 Runtime Algorithms

This document sketches the minimal runtime algorithms needed to implement bounded supervisor delegation in v1.4.

It assumes the contracts in [agen-contracts-v1.4.md](file:///Users/ugmurthy/riding-amp/AgentSmith/agen-contracts-v1.4.md) and the product rules in [agen-spec-v1.4.md](file:///Users/ugmurthy/riding-amp/AgentSmith/agen-spec-v1.4.md).

## 1. Core Invariants

The runtime should maintain these invariants at all times:

- `Tool` remains the only first-class executable primitive.
- Delegate profiles are surfaced as synthetic tools under the reserved `delegate.` namespace.
- A parent run may have at most one active child run at a time.
- `delegationDepth` must not exceed policy limits.
- Persisted plans must not contain `delegate.*` steps.
- Every run owns its own event sequence and lease.
- Parent and child relationships are reconstructed from `rootRunId`, `parentRunId`, and `currentChildRunId`.

## 2. Delegate Tool Registration

At agent construction time:

1. Register all host-authored tools as normal planner-visible tools.
2. For each `DelegateDefinition`, synthesize a planner-visible tool named `delegate.${name}`.
3. The synthetic tool should expose a stable `inputSchema` equivalent to `DelegateToolInput`.
4. The synthetic tool executor should not directly call a host tool. It should enter the delegation flow below.

Pseudo-code:

```ts
for (const delegate of delegates) {
  toolRegistry.register({
    name: `delegate.${delegate.name}`,
    description: delegate.description,
    inputSchema: delegateToolInputSchema,
    execute: (input, context) => executeDelegateTool(delegate, input, context),
  });
}
```

## 3. `delegate.*` Execution Algorithm

When a parent run selects a synthetic delegate tool:

1. Validate the delegate name exists.
2. Validate `delegationDepth < maxDepth`.
3. Validate `maxChildrenPerRun` has not been exceeded.
4. Validate recursive self-delegation policy.
5. Pre-allocate a child `runId` if the store requires explicit linkage at insert time.
6. Create the child run with:
   - `rootRunId` inherited from the parent
   - `parentRunId` set to the parent run ID
   - `parentStepId` set to the current step
   - `delegateName` set to the selected profile
   - `delegationDepth = parent.delegationDepth + 1`
7. Update the parent run to:
   - `status = 'awaiting_subagent'`
   - `currentChildRunId = childRunId`
8. Persist a parent snapshot before handing control to the child.
9. Emit:
   - `tool.started` on the parent run
   - `delegate.spawned` on the parent run
   - `run.created` on the child run
10. Execute the child run using the delegate's bounded toolset and optional model override.
11. Wait for the child to reach a terminal state.
12. Map the child terminal state back into the parent step.
13. Clear `currentChildRunId` on the parent.
14. Move the parent back to `running`.
15. Emit `tool.completed` or `tool.failed` on the parent.

Pseudo-code:

```ts
async function executeDelegateTool(
  delegate: DelegateDefinition,
  input: DelegateToolInput,
  parentContext: ToolContext,
): Promise<JsonValue> {
  assertDelegationAllowed(delegate, parentContext);

  const childRunId = generateRunId();
  const childDepth = parentContext.delegationDepth + 1;

  await runStore.createRun({
    id: childRunId,
    rootRunId: parentContext.rootRunId,
    parentRunId: parentContext.runId,
    parentStepId: parentContext.stepId,
    delegateName: delegate.name,
    delegationDepth: childDepth,
    goal: input.goal,
    input: input.input,
    context: input.context,
    metadata: input.metadata,
    status: 'queued',
  });

  await runStore.updateRun(parentContext.runId, {
    status: 'awaiting_subagent',
    currentChildRunId: childRunId,
  });

  await eventSink.emit({
    runId: parentContext.runId,
    stepId: parentContext.stepId,
    type: 'delegate.spawned',
    schemaVersion: 1,
    payload: {
      toolName: `delegate.${delegate.name}`,
      delegateName: delegate.name,
      childRunId,
      parentRunId: parentContext.runId,
      parentStepId: parentContext.stepId,
      rootRunId: parentContext.rootRunId,
      delegationDepth: childDepth,
    },
  });

  const childResult = await executeChildRun(delegate, childRunId, input, parentContext);

  await runStore.updateRun(parentContext.runId, {
    status: 'running',
    currentChildRunId: undefined,
  });

  return mapChildResultToToolOutput(childResult);
}
```

## 4. Child Run Execution Algorithm

A child run is executed by the same runtime, but with a bounded configuration:

- model = delegate override if present, otherwise inherit parent model
- tools = only the delegate's `allowedTools`
- defaults = parent defaults merged with delegate defaults
- delegates = none by default, unless recursive delegation is explicitly enabled

Pseudo-code:

```ts
async function executeChildRun(
  delegate: DelegateDefinition,
  childRunId: UUID,
  input: DelegateToolInput,
  parentContext: ToolContext,
): Promise<RunResult> {
  const childAgent = createScopedAgent({
    model: delegate.model ?? rootAgent.model,
    tools: pickTools(delegate.allowedTools),
    delegates: parentPolicy.allowRecursiveDelegation ? rootAgent.delegates : [],
    defaults: mergeDefaults(rootAgent.defaults, delegate.defaults),
  });

  return childAgent.runWithExistingRun({
    runId: childRunId,
    rootRunId: parentContext.rootRunId,
    parentRunId: parentContext.runId,
    parentStepId: parentContext.stepId,
    delegateName: delegate.name,
    delegationDepth: parentContext.delegationDepth + 1,
    goal: input.goal,
    input: input.input,
    context: input.context,
    outputSchema: input.outputSchema,
    metadata: input.metadata,
  });
}
```

## 5. Child Result Mapping

### Success

If the child returns:

```ts
{ status: 'success', output, ... }
```

then the parent delegate step completes normally and `output` becomes the synthetic tool result.

### Failure

If the child returns:

```ts
{ status: 'failure', error, code, ... }
```

then the parent delegate step should fail as a tool failure.

Recommended mapping:

- parent event: `tool.failed`
- parent terminal failure code if unrecoverable: `TOOL_ERROR`

### Clarification Or Approval

If the child returns:

- `clarification_requested`
- `approval_requested`

then in the minimal v1.4 design the runtime should treat that as a child failure, because nested interaction flows are out of scope.

## 6. Parent Resume Algorithm

When `resume(parentRunId)` is called:

1. Load the parent run.
2. Acquire the parent lease.
3. Load the parent snapshot.
4. If the parent is not `awaiting_subagent`, resume normal step execution.
5. If the parent is `awaiting_subagent`, read `currentChildRunId` from the run row or snapshot state.
6. Load the child run.
7. Branch on child status:
   - if child is `succeeded`, map the stored child result into the parent step and continue
   - if child is `failed`, map the error into the parent step and continue failure handling
   - if child is `interrupted`, resume the child first or fail it explicitly
   - if child is `running` or `awaiting_approval`, do not advance the parent; either wait or drive child progress depending on the execution model
   - if child is missing, fail the parent because the waiting boundary cannot be resolved safely
8. Persist a new parent snapshot once the wait boundary has been resolved.
9. Continue the parent loop.

Resume must be lease-protected and idempotent:

- If the parent run is already terminal, return the stored terminal result without emitting more parent events.
- If the latest snapshot is absent, corrupt, or uses an incompatible future `schemaVersion`, fail explicitly instead of rebuilding state from partial events.
- If the parent snapshot says it is waiting on a child, prefer the run row linkage and fall back to snapshot `waitingOnChildRunId`; both must identify a child linked to the same parent.
- If the child is terminal and the parent is still waiting, resolve the delegate step from the stored child result and persist the parent update and continuation snapshot once.
- If the child linkage is missing or points at another parent, fail the parent with a tool error because the delegation boundary cannot be trusted.
- If a repeated `resume(parentRunId)` races with a previous successful parent resolution, the second call should observe the resolved parent state or terminal state and must not emit a second parent `tool.completed`.
- If the child is active but its lease is expired, resume the child or hand it to the recovery scanner before advancing the parent.
- If the child is active and leased elsewhere, keep the parent waiting.

Pseudo-code:

```ts
async function resumeParentRun(parentRunId: UUID): Promise<RunResult> {
  const parent = await runStore.getRun(parentRunId);
  assert(parent);

  await acquireLeaseOrThrow(parentRunId);

  const snapshot = await snapshotStore.getLatest(parentRunId);
  const state = restoreState(snapshot);

  if (parent.status !== 'awaiting_subagent') {
    return continueRun(parent, state);
  }

  const childRunId = parent.currentChildRunId ?? state.waitingOnChildRunId;
  if (!childRunId) {
    return failParent(parent, 'Missing child linkage while awaiting sub-agent');
  }

  const child = await runStore.getRun(childRunId);
  if (!child) {
    return failParent(parent, 'Child run missing while resolving delegation boundary');
  }

  if (child.status === 'interrupted') {
    await resume(childRunId);
  }

  return resolveParentFromChild(parent, child);
}
```

## 7. Child Resume Algorithm

When `resume(childRunId)` is called directly:

1. Load the child run and child snapshot.
2. Acquire the child lease.
3. Resume normal single-run execution.
4. On terminal completion, update the parent if the parent is still waiting on this child.
5. Emit parent-side `tool.completed` or `tool.failed` only once.

This requires idempotent parent resolution logic so repeated resumes do not double-complete the same parent step.

## 8. Tool Ledger Resume Algorithm

When a snapshot contains a pending tool call:

1. Recreate the `idempotencyKey` from `runId`, `stepId`, and `toolCallId`.
2. Read the durable tool execution ledger by `idempotencyKey`.
3. If the ledger status is `completed`, append the stored output as the tool result message, complete the pending step, and continue without invoking the tool.
4. If the ledger status is `failed`, return or replay the stored failure according to the tool retry policy.
5. If the ledger row is missing or still `started`, retry according to host policy. For side-effecting tools, the tool must use `ToolContext.idempotencyKey` to make external calls safe to retry.
6. When a fresh tool execution completes, persist the ledger completion, `tool.completed`, `step.completed`, and continuation snapshot in one transaction when a transaction store is configured.

This gives runtime-level exactly-once result reuse for completed tool calls. It does not guarantee external exactly-once side effects unless the tool cooperates with the external system.

## 9. Gateway Reconnect Algorithm

When a client reconnects with `session.open` and an existing `sessionId`:

1. Authenticate the caller and verify the session owner.
2. Update the session `updatedAt` timestamp.
3. Subscribe the connection to the session channel, active root run channel, active run channel, and agent channel after runtime recovery decisions are applied.
4. If the session has no active run, emit `session.opened` and a `session.updated` state frame.
5. If the active runtime run is terminal, clear `currentRunId` and `currentRootRunId`, set `lastCompletedRootRunId`, and emit the stored `run.output`.
6. If the run is `awaiting_approval`, keep the session in `awaiting_approval` and re-present the pending approval state.
7. If the run is `clarification_requested`, emit the clarification request state and wait for `clarification.resolve`.
8. If the run is `running`, `planning`, `queued`, or `awaiting_subagent` with an expired lease, call `resume(currentRunId)` when supported and then settle the session from the returned `RunResult`.
9. If the active run is leased by another worker, reattach as an observer and do not mutate the run.
10. If the active runtime run is missing, fail the session explicitly.

Gateway reconnect must not spawn a new root run for an existing active session.

## 10. Interrupt Cascade Algorithm

When `interrupt(parentRunId)` is called:

1. Mark the parent as interrupted at the next cooperative boundary.
2. If `currentChildRunId` is set, best-effort interrupt the child too.
3. Emit `run.interrupted` on both runs if both are affected.
4. Persist snapshots for both runs when practical.

The parent should not continue until the child boundary is resolved.

## 11. Event Sequence Example

A typical delegated sequence should look like this:

1. parent `step.started`
2. parent `tool.started` for `delegate.researcher`
3. parent `delegate.spawned`
4. child `run.created`
5. child `run.status_changed` to `running`
6. child `step.started`
7. child `tool.started`
8. child `tool.completed`
9. child `step.completed`
10. child `run.completed`
11. parent `tool.completed` for `delegate.researcher`
12. parent `step.completed`

Every run keeps its own sequence numbers. Tree reconstruction happens from run linkage rather than a global event order.

## 12. Failure Modes To Handle Explicitly

The runtime should make deliberate decisions for these cases:

- delegate profile removed between planning and execution
- delegate profile attempts disallowed recursive delegation
- parent snapshot says waiting on child but `currentChildRunId` is null
- child run exists but parent linkage fields do not match
- child run succeeds but output fails parent-side schema validation
- child run requests approval or clarification in a mode that disallows it
- repeated resume calls race to resolve the same parent wait boundary
- completed tool ledger exists but the latest continuation snapshot is stale
- gateway session points at a missing runtime run
- active run lease is expired at reconnect time
- snapshot schema version is newer than this runtime supports

## 13. Recommended Tests

High-value behavioral tests for this design are:

1. parent run delegates to one child and successfully resumes with child output
2. process crash after `delegate.spawned` resumes safely from `awaiting_subagent`
3. child failure maps to parent `tool.failed`
4. interrupting the parent interrupts the child or leaves the parent safely blocked
5. persisted plans reject `delegate.*` steps with `replan.required`
6. recursive delegation is blocked when `maxDepth = 1`
7. completed tool ledger entry is reused without invoking the tool again
8. model tool-call snapshot resumes from the queued tool call without calling the model again
9. repeated `resume()` on a terminal run returns the stored result
10. gateway reconnect settles terminal runs and resumes expired active leases
