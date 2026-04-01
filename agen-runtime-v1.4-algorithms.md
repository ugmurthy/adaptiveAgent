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

## 8. Interrupt Cascade Algorithm

When `interrupt(parentRunId)` is called:

1. Mark the parent as interrupted at the next cooperative boundary.
2. If `currentChildRunId` is set, best-effort interrupt the child too.
3. Emit `run.interrupted` on both runs if both are affected.
4. Persist snapshots for both runs when practical.

The parent should not continue until the child boundary is resolved.

## 9. Event Sequence Example

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

## 10. Failure Modes To Handle Explicitly

The runtime should make deliberate decisions for these cases:

- delegate profile removed between planning and execution
- delegate profile attempts disallowed recursive delegation
- parent snapshot says waiting on child but `currentChildRunId` is null
- child run exists but parent linkage fields do not match
- child run succeeds but output fails parent-side schema validation
- child run requests approval or clarification in a mode that disallows it
- repeated resume calls race to resolve the same parent wait boundary

## 11. Recommended Tests

High-value behavioral tests for this design are:

1. parent run delegates to one child and successfully resumes with child output
2. process crash after `delegate.spawned` resumes safely from `awaiting_subagent`
3. child failure maps to parent `tool.failed`
4. interrupting the parent interrupts the child or leaves the parent safely blocked
5. persisted plans reject `delegate.*` steps with `replan.required`
6. recursive delegation is blocked when `maxDepth = 1`
