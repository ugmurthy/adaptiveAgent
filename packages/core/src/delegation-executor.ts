import type { Logger } from 'pino';

import { runLogBindings, summarizeRunResultForLog } from './logging.js';
import { captureValueForLog, summarizeValueForLog } from './logger.js';
import type {
  AgentDefaults,
  AgentEvent,
  AgentRun,
  DelegateDefinition,
  DelegateToolInput,
  DelegateSpawnedPayload,
  DelegationPolicy,
  EventSink,
  JsonObject,
  JsonSchema,
  JsonValue,
  ModelAdapter,
  RunFailureCode,
  RunResult,
  RunStatus,
  RunStore,
  RuntimeStores,
  RuntimeTransactionStore,
  SnapshotStore,
  ToolContext,
  ToolDefinition,
  UUID,
} from './types.js';

const DELEGATE_TOOL_NAMESPACE = 'delegate.';

const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  'succeeded',
  'failed',
  'clarification_requested',
  'replan_required',
  'cancelled',
]);

const DEFAULT_DELEGATION_POLICY: Required<DelegationPolicy> = {
  maxDepth: 1,
  maxChildrenPerRun: 5,
  allowRecursiveDelegation: false,
  childRunsMayRequestApproval: false,
  childRunsMayRequestClarification: false,
};

const delegateToolInputSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['goal'],
  properties: {
    goal: { type: 'string' },
    input: {},
    context: { type: 'object', additionalProperties: true },
    outputSchema: { type: 'object', additionalProperties: true },
    metadata: { type: 'object', additionalProperties: true },
  },
};

interface HierarchicalRunStore extends RunStore {
  listChildren(parentRunId: UUID): Promise<AgentRun[]>;
}

export interface ExecuteChildRunRequest {
  runId: UUID;
  rootRunId: UUID;
  parentRunId: UUID;
  parentStepId: string;
  delegate: DelegateDefinition;
  delegationDepth: number;
  goal: string;
  input?: JsonValue;
  context?: Record<string, JsonValue>;
  outputSchema?: JsonSchema;
  metadata?: Record<string, JsonValue>;
  model: ModelAdapter;
  tools: ToolDefinition[];
  delegates: DelegateDefinition[];
  defaults?: AgentDefaults;
}

export interface DelegationExecutorOptions {
  model: ModelAdapter;
  tools: ToolDefinition[];
  delegates?: DelegateDefinition[];
  delegation?: DelegationPolicy;
  defaults?: AgentDefaults;
  runStore: RunStore;
  eventSink?: EventSink;
  downstreamEventSink?: EventSink;
  logger?: Logger;
  snapshotStore?: SnapshotStore;
  transactionStore?: RuntimeTransactionStore;
  executeChildRun(request: ExecuteChildRunRequest): Promise<RunResult>;
}

export type ParentResumeResult =
  | { kind: 'not_waiting'; parentRun: AgentRun }
  | { kind: 'waiting'; parentRun: AgentRun; childRun: AgentRun; reason: string }
  | { kind: 'resolved'; parentRun: AgentRun; childRun: AgentRun; output: JsonValue }
  | { kind: 'failed'; parentRun: AgentRun; childRun?: AgentRun; error: string; code: RunFailureCode };

export class DelegationError extends Error {
  readonly code: RunFailureCode;

  constructor(message: string, code: RunFailureCode = 'TOOL_ERROR') {
    super(message);
    this.name = 'DelegationError';
    this.code = code;
  }
}

export class DelegationExecutor {
  private readonly hostToolsByName = new Map<string, ToolDefinition>();
  private readonly delegatesByName = new Map<string, DelegateDefinition>();
  private readonly policy: Required<DelegationPolicy>;
  private readonly logger?: Logger;

  constructor(private readonly options: DelegationExecutorOptions) {
    this.policy = { ...DEFAULT_DELEGATION_POLICY, ...options.delegation };
    this.logger = options.logger?.child({ component: 'adaptive-agent.delegation' });

    for (const tool of options.tools) {
      if (tool.name.startsWith(DELEGATE_TOOL_NAMESPACE)) {
        throw new Error(`Host tool ${tool.name} uses reserved ${DELEGATE_TOOL_NAMESPACE} namespace`);
      }

      if (this.hostToolsByName.has(tool.name)) {
        throw new Error(`Duplicate tool name ${tool.name}`);
      }

      this.hostToolsByName.set(tool.name, tool);
    }

    for (const delegate of options.delegates ?? []) {
      if (this.delegatesByName.has(delegate.name)) {
        throw new Error(`Duplicate delegate profile ${delegate.name}`);
      }

      for (const toolName of delegate.allowedTools) {
        if (!this.hostToolsByName.has(toolName)) {
          throw new Error(`Delegate ${delegate.name} references unknown tool ${toolName}`);
        }
      }

      this.delegatesByName.set(delegate.name, delegate);
    }
  }

  getTools(): ToolDefinition[] {
    return [...this.hostToolsByName.values(), ...this.createDelegateTools()];
  }

  createDelegateTools(): ToolDefinition[] {
    return Array.from(this.delegatesByName.values(), (delegate) => ({
      name: this.toDelegateToolName(delegate.name),
      description: delegate.description,
      inputSchema: delegateToolInputSchema,
      // Child runs enforce their own model/tool timeouts, so the synthetic
      // delegate tool should not also be capped by the parent's tool timeout.
      timeoutMs: 0,
      execute: async (input, context) => this.executeDelegateTool(delegate, toDelegateToolInput(input), context),
    }));
  }

  async executeDelegateTool(
    delegate: DelegateDefinition,
    input: DelegateToolInput,
    parentContext: ToolContext,
  ): Promise<JsonValue> {
    await this.assertDelegationAllowed(delegate, parentContext);

    const toolName = this.toDelegateToolName(delegate.name);
    const childRunId = crypto.randomUUID();
    const childDepth = parentContext.delegationDepth + 1;

    this.logLifecycle('info', 'tool.started', {
      runId: parentContext.runId,
      rootRunId: parentContext.rootRunId,
      parentRunId: parentContext.parentRunId,
      delegateName: parentContext.delegateName,
      delegationDepth: parentContext.delegationDepth,
      stepId: parentContext.stepId,
      toolName,
      childRunId,
      childDelegateName: delegate.name,
      input: captureValueForLog(input, { mode: this.options.defaults?.capture ?? 'summary' }),
    });

    await parentContext.emit({
      runId: parentContext.runId,
      stepId: parentContext.stepId,
      type: 'tool.started',
      schemaVersion: 1,
      payload: {
        toolName,
        delegateName: delegate.name,
        childRunId,
      },
    });

    const delegatePayload = {
      toolName,
      delegateName: delegate.name,
      childRunId,
      parentRunId: parentContext.runId,
      parentStepId: parentContext.stepId,
      rootRunId: parentContext.rootRunId,
      delegationDepth: childDepth,
    } satisfies DelegateSpawnedPayload;

    await this.persistChildSpawnBoundary({
      parentContext,
      childRunId,
      childDepth,
      delegate,
      input,
      delegatePayload,
    });

    this.logLifecycle('info', 'delegate.spawned', {
      ...delegatePayload,
      allowedTools: delegate.allowedTools,
      goal: summarizeValueForLog(input.goal),
      input: captureValueForLog(input.input, { mode: this.options.defaults?.capture ?? 'summary' }),
      context: captureValueForLog(input.context, { mode: this.options.defaults?.capture ?? 'summary' }),
      metadata: captureValueForLog(input.metadata, { mode: 'summary' }),
      outputSchema: input.outputSchema ? summarizeValueForLog(input.outputSchema) : undefined,
    });

    const childResult = await this.options.executeChildRun({
      runId: childRunId,
      rootRunId: parentContext.rootRunId,
      parentRunId: parentContext.runId,
      parentStepId: parentContext.stepId,
      delegate,
      delegationDepth: childDepth,
      goal: input.goal,
      input: input.input,
      context: input.context,
      outputSchema: input.outputSchema,
      metadata: input.metadata,
      model: delegate.model ?? this.options.model,
      tools: this.pickTools(delegate.allowedTools),
      delegates: this.policy.allowRecursiveDelegation ? [...this.delegatesByName.values()] : [],
      defaults: { ...this.options.defaults, ...delegate.defaults },
    });

    this.logLifecycle('info', 'delegate.child_result', {
      parentRunId: parentContext.runId,
      childRunId,
      delegateName: delegate.name,
      toolName,
      result: summarizeRunResultForLog(childResult),
    });

    await this.materializeChildTerminalState(childRunId, childResult);

    const resolution = await this.resolveParentFromChild({
      parentRunId: parentContext.runId,
      childRunId,
      stepId: parentContext.stepId,
      delegateName: delegate.name,
      toolName,
    });

    if (resolution.kind === 'resolved') {
      return resolution.output;
    }

    if (resolution.kind === 'failed') {
      throw new DelegationError(resolution.error, resolution.code);
    }

    throw new DelegationError('Child run did not reach a terminal state');
  }

  async resumeParentRun(parentRunId: UUID): Promise<ParentResumeResult> {
    const parentRun = await this.options.runStore.getRun(parentRunId);
    if (!parentRun) {
      throw new Error(`Parent run ${parentRunId} does not exist`);
    }

    this.logLifecycle('debug', 'delegate.resume_parent_requested', {
      ...runLogBindings(parentRun),
      status: parentRun.status,
      stepId: parentRun.currentStepId,
    });

    const childRunId = parentRun.currentChildRunId ?? (await this.getSnapshotChildRunId(parentRunId));
    if (parentRun.status !== 'awaiting_subagent') {
      if (parentRun.status === 'running' && childRunId) {
        return this.resolveStaleParentSnapshot(parentRun, childRunId);
      }

      return { kind: 'not_waiting', parentRun };
    }

    if (!childRunId) {
      const failedParent = await this.failParentRun(parentRun, 'Missing child linkage while awaiting sub-agent');
      return {
        kind: 'failed',
        parentRun: failedParent,
        error: failedParent.errorMessage ?? 'Missing child linkage while awaiting sub-agent',
        code: (failedParent.errorCode as RunFailureCode | undefined) ?? 'TOOL_ERROR',
      };
    }

    const childRun = await this.options.runStore.getRun(childRunId);
    if (!childRun) {
      const failedParent = await this.failParentRun(parentRun, 'Child run missing while resolving delegation boundary');
      return {
        kind: 'failed',
        parentRun: failedParent,
        error: failedParent.errorMessage ?? 'Child run missing while resolving delegation boundary',
        code: (failedParent.errorCode as RunFailureCode | undefined) ?? 'TOOL_ERROR',
      };
    }

    const linkageError = this.validateChildLinkage(parentRun, childRun, parentRun.currentStepId ?? childRun.parentStepId);
    if (linkageError) {
      const failedParent = await this.failParentRun(parentRun, linkageError);
      return {
        kind: 'failed',
        parentRun: failedParent,
        childRun,
        error: failedParent.errorMessage ?? linkageError,
        code: (failedParent.errorCode as RunFailureCode | undefined) ?? 'TOOL_ERROR',
      };
    }

    if (!TERMINAL_RUN_STATUSES.has(childRun.status)) {
      this.logLifecycle('debug', 'delegate.child_still_running', {
        ...runLogBindings(parentRun),
        childRunId,
        childStatus: childRun.status,
        reason: this.pendingReason(childRun.status),
      });
      return {
        kind: 'waiting',
        parentRun,
        childRun,
        reason: this.pendingReason(childRun.status),
      };
    }

    const stepId = parentRun.currentStepId ?? childRun.parentStepId;
    const delegateName = childRun.delegateName ?? 'unknown';
    const toolName = this.toDelegateToolName(delegateName);
    return this.resolveParentFromChild({
      parentRunId,
      childRunId,
      stepId,
      delegateName,
      toolName,
    });
  }

  private async resolveStaleParentSnapshot(parentRun: AgentRun, childRunId: UUID): Promise<ParentResumeResult> {
    const childRun = await this.options.runStore.getRun(childRunId);
    if (!childRun) {
      return {
        kind: 'failed',
        parentRun,
        error: 'Child run missing while recovering resolved delegation snapshot',
        code: 'TOOL_ERROR',
      };
    }

    const stepId = parentRun.currentStepId ?? childRun.parentStepId;
    const linkageError = this.validateChildLinkage(parentRun, childRun, stepId);
    if (linkageError) {
      return {
        kind: 'failed',
        parentRun,
        childRun,
        error: linkageError,
        code: 'TOOL_ERROR',
      };
    }

    if (!TERMINAL_RUN_STATUSES.has(childRun.status)) {
      return {
        kind: 'waiting',
        parentRun,
        childRun,
        reason: this.pendingReason(childRun.status),
      };
    }

    const delegateName = childRun.delegateName ?? 'unknown';
    return this.resolveParentFromChild({
      parentRunId: parentRun.id,
      childRunId,
      stepId,
      delegateName,
      toolName: this.toDelegateToolName(delegateName),
    });
  }

  private async resolveParentFromChild(params: {
    parentRunId: UUID;
    childRunId: UUID;
    stepId?: string;
    delegateName: string;
    toolName: string;
  }): Promise<Extract<ParentResumeResult, { kind: 'resolved' | 'failed' }>> {
    const parentRun = await this.options.runStore.getRun(params.parentRunId);
    const childRun = await this.options.runStore.getRun(params.childRunId);
    if (!parentRun || !childRun) {
      throw new Error('Unable to resolve delegation boundary without parent and child runs');
    }

    const alreadyResolved =
      parentRun.status !== 'awaiting_subagent' || parentRun.currentChildRunId !== params.childRunId;

    const mapped = this.mapChildRun(childRun);
    if (!alreadyResolved) {
      const statusChangedEvent = this.runStatusChangedEvent(parentRun, params.stepId, 'running', null);
      const parentToolEvent = this.parentToolResolutionEvent({
        parentRunId: parentRun.id,
        stepId: params.stepId,
        delegateName: params.delegateName,
        toolName: params.toolName,
        childRunId: params.childRunId,
        mapped,
      });
      const refreshedParent = await this.persistParentResolutionBoundary({
        parentRun,
        statusChangedEvent,
        parentToolEvent,
      });

      this.logLifecycle('info', 'run.status_changed', {
        ...runLogBindings(refreshedParent),
        stepId: params.stepId,
        fromStatus: parentRun.status,
        toStatus: 'running',
        childRunId: params.childRunId,
      });

      if (mapped.kind === 'success') {
        this.logLifecycle('info', 'tool.completed', {
          ...runLogBindings(refreshedParent),
          stepId: params.stepId,
          toolName: params.toolName,
          delegateName: params.delegateName,
          childRunId: params.childRunId,
          output: summarizeValueForLog(mapped.output),
        });
        return {
          kind: 'resolved',
          parentRun: refreshedParent,
          childRun,
          output: mapped.output,
        };
      }

      this.logLifecycle('error', 'tool.failed', {
        ...runLogBindings(refreshedParent),
        stepId: params.stepId,
        toolName: params.toolName,
        delegateName: params.delegateName,
        childRunId: params.childRunId,
        error: mapped.error,
        code: mapped.code,
      });

      return {
        kind: 'failed',
        parentRun: refreshedParent,
        childRun,
        error: mapped.error,
        code: mapped.code,
      };
    }

    if (mapped.kind === 'success') {
      return {
        kind: 'resolved',
        parentRun,
        childRun,
        output: mapped.output,
      };
    }

    return {
      kind: 'failed',
      parentRun,
      childRun,
      error: mapped.error,
      code: mapped.code,
    };
  }

  private async persistChildSpawnBoundary(params: {
    parentContext: ToolContext;
    childRunId: UUID;
    childDepth: number;
    delegate: DelegateDefinition;
    input: DelegateToolInput;
    delegatePayload: DelegateSpawnedPayload;
  }): Promise<AgentRun> {
    const transactionStore = this.options.transactionStore;
    if (transactionStore?.eventStore && transactionStore.snapshotStore) {
      const downstreamEvents: Array<Omit<AgentEvent, 'id' | 'seq' | 'createdAt'>> = [];
      const updatedParent = await transactionStore.runInTransaction(async (stores) => {
        if (!stores.eventStore || !stores.snapshotStore) {
          throw new Error('Transactional child spawn requires eventStore and snapshotStore');
        }

        const childRun = await stores.runStore.createRun(this.childRunInput(params));
        const parentRun = await stores.runStore.getRun(params.parentContext.runId);
        if (!parentRun) {
          throw new Error(`Parent run ${params.parentContext.runId} does not exist`);
        }

        const nextParent = await stores.runStore.updateRun(
          parentRun.id,
          {
            status: 'awaiting_subagent',
            currentChildRunId: params.childRunId,
          },
          parentRun.version,
        );

        const statusChangedEvent = this.runStatusChangedEvent(
          parentRun,
          params.parentContext.stepId,
          'awaiting_subagent',
          params.childRunId,
        );
        await stores.eventStore.append(statusChangedEvent);
        downstreamEvents.push(statusChangedEvent);

        const snapshotEvent = await this.persistAwaitingChildSnapshotWithStores(
          stores,
          nextParent,
          params.childRunId,
          params.delegate.name,
        );
        if (snapshotEvent) {
          downstreamEvents.push(snapshotEvent);
        }

        const delegateSpawnedEvent = this.delegateSpawnedEvent(
          params.parentContext.runId,
          params.parentContext.stepId,
          params.delegatePayload,
        );
        await stores.eventStore.append(delegateSpawnedEvent);
        downstreamEvents.push(delegateSpawnedEvent);

        const childCreatedEvent = this.childRunCreatedEvent(childRun);
        await stores.eventStore.append(childCreatedEvent);
        downstreamEvents.push(childCreatedEvent);

        return nextParent;
      });

      await this.emitDownstreamOnly(downstreamEvents);
      return updatedParent;
    }

    const childRun = await this.options.runStore.createRun(this.childRunInput(params));
    const parentRun = await this.options.runStore.getRun(params.parentContext.runId);
    if (!parentRun) {
      throw new Error(`Parent run ${params.parentContext.runId} does not exist`);
    }

    const updatedParent = await this.options.runStore.updateRun(
      params.parentContext.runId,
      {
        status: 'awaiting_subagent',
        currentChildRunId: params.childRunId,
      },
      parentRun.version,
    );

    await this.emitRunEvent(
      this.runStatusChangedEvent(parentRun, params.parentContext.stepId, 'awaiting_subagent', params.childRunId),
    );
    await this.persistAwaitingChildSnapshot(updatedParent, params.childRunId, params.delegate.name);
    await params.parentContext.emit(
      this.delegateSpawnedEvent(params.parentContext.runId, params.parentContext.stepId, params.delegatePayload),
    );
    await this.emitRunEvent(this.childRunCreatedEvent(childRun));

    return updatedParent;
  }

  private childRunInput(params: {
    parentContext: ToolContext;
    childRunId: UUID;
    childDepth: number;
    delegate: DelegateDefinition;
    input: DelegateToolInput;
  }): Parameters<RunStore['createRun']>[0] {
    return {
      id: params.childRunId,
      rootRunId: params.parentContext.rootRunId,
      parentRunId: params.parentContext.runId,
      parentStepId: params.parentContext.stepId,
      delegateName: params.delegate.name,
      delegationDepth: params.childDepth,
      goal: params.input.goal,
      input: params.input.input,
      context: params.input.context,
      metadata: params.input.metadata,
      status: 'queued',
    };
  }

  private async persistParentResolutionBoundary(params: {
    parentRun: AgentRun;
    statusChangedEvent: Omit<AgentEvent, 'id' | 'seq' | 'createdAt'>;
    parentToolEvent: Omit<AgentEvent, 'id' | 'seq' | 'createdAt'>;
  }): Promise<AgentRun> {
    const transactionStore = this.options.transactionStore;
    if (transactionStore?.eventStore) {
      const updatedParent = await transactionStore.runInTransaction(async (stores) => {
        if (!stores.eventStore) {
          throw new Error('Transactional parent resolution requires eventStore');
        }

        const nextParent = await stores.runStore.updateRun(
          params.parentRun.id,
          {
            status: 'running',
            currentChildRunId: undefined,
          },
          params.parentRun.version,
        );
        await stores.eventStore.append(params.statusChangedEvent);
        await stores.eventStore.append(params.parentToolEvent);
        return nextParent;
      });

      await this.emitDownstreamOnly([params.statusChangedEvent, params.parentToolEvent]);
      return updatedParent;
    }

    const updatedParent = await this.options.runStore.updateRun(
      params.parentRun.id,
      {
        status: 'running',
        currentChildRunId: undefined,
      },
      params.parentRun.version,
    );
    await this.emitRunEvent(params.statusChangedEvent);
    await this.emitRunEvent(params.parentToolEvent);
    return updatedParent;
  }

  private async materializeChildTerminalState(childRunId: UUID, result: RunResult): Promise<void> {
    const childRun = await this.options.runStore.getRun(childRunId);
    if (!childRun) {
      throw new Error(`Child run ${childRunId} does not exist`);
    }

    if (TERMINAL_RUN_STATUSES.has(childRun.status)) {
      return;
    }

    if (result.status === 'success') {
      await this.options.runStore.updateRun(
        childRunId,
        {
          status: 'succeeded',
          result: result.output,
        },
        childRun.version,
      );

      await this.emitRunEvent({
        runId: childRunId,
        type: 'run.completed',
        schemaVersion: 1,
        payload: {
          output: result.output,
          stepsUsed: result.stepsUsed,
        },
      });

      this.logLifecycle('info', 'run.completed', {
        ...runLogBindings(childRun),
        output: summarizeValueForLog(result.output),
        stepsUsed: result.stepsUsed,
      });

      return;
    }

    const failure = this.resultFailure(result);
    await this.options.runStore.updateRun(
      childRunId,
      {
        status: 'failed',
        errorCode: failure.code,
        errorMessage: failure.error,
      },
      childRun.version,
    );

    await this.emitRunEvent({
      runId: childRunId,
      type: 'run.failed',
      schemaVersion: 1,
      payload: {
        error: failure.error,
        code: failure.code,
      },
    });

    this.logLifecycle('error', 'run.failed', {
      ...runLogBindings(childRun),
      error: failure.error,
      code: failure.code,
    });
  }

  private async persistAwaitingChildSnapshot(parentRun: AgentRun, childRunId: UUID, delegateName: string): Promise<void> {
    const snapshotEvent = await this.persistAwaitingChildSnapshotWithStores(
      {
        snapshotStore: this.options.snapshotStore,
      },
      parentRun,
      childRunId,
      delegateName,
    );
    if (snapshotEvent) {
      await this.emitRunEvent(snapshotEvent);
    }
  }

  private async persistAwaitingChildSnapshotWithStores(
    stores: Pick<RuntimeStores, 'eventStore' | 'snapshotStore'>,
    parentRun: AgentRun,
    childRunId: UUID,
    delegateName: string,
  ): Promise<Omit<AgentEvent, 'id' | 'seq' | 'createdAt'> | null> {
    if (!stores.snapshotStore) {
      return null;
    }

    const latestSnapshot = await stores.snapshotStore.getLatest(parentRun.id);
    const previousState = isJsonObject(latestSnapshot?.state) ? latestSnapshot.state : {};
    const previousSummary = isJsonObject(latestSnapshot?.summary) ? latestSnapshot.summary : {};
    await stores.snapshotStore.save({
      runId: parentRun.id,
      snapshotSeq: (latestSnapshot?.snapshotSeq ?? 0) + 1,
      status: 'awaiting_subagent',
      currentStepId: parentRun.currentStepId,
      currentPlanId: parentRun.currentPlanId,
      currentPlanExecutionId: parentRun.currentPlanExecutionId,
      summary: {
        ...previousSummary,
        state: 'awaiting_subagent',
        waitingOnDelegateName: delegateName,
      },
      state: {
        ...previousState,
        waitingOnChildRunId: childRunId,
        waitingOnDelegateName: delegateName,
        parentStepId: parentRun.currentStepId ?? null,
      },
    });

    const snapshotEvent = {
      runId: parentRun.id,
      type: 'snapshot.created',
      stepId: parentRun.currentStepId,
      schemaVersion: 1,
      payload: {
        status: 'awaiting_subagent',
        waitingOnChildRunId: childRunId,
        waitingOnDelegateName: delegateName,
      },
    } satisfies Omit<AgentEvent, 'id' | 'seq' | 'createdAt'>;

    await stores.eventStore?.append(snapshotEvent);

    this.logLifecycle('debug', 'snapshot.created', {
      ...runLogBindings(parentRun),
      stepId: parentRun.currentStepId,
      status: 'awaiting_subagent',
      waitingOnChildRunId: childRunId,
      waitingOnDelegateName: delegateName,
    });

    return snapshotEvent;
  }

  private delegateSpawnedEvent(
    runId: UUID,
    stepId: string,
    payload: DelegateSpawnedPayload,
  ): Omit<AgentEvent, 'id' | 'seq' | 'createdAt'> {
    return {
      runId,
      stepId,
      type: 'delegate.spawned',
      schemaVersion: 1,
      payload,
    };
  }

  private childRunCreatedEvent(childRun: AgentRun): Omit<AgentEvent, 'id' | 'seq' | 'createdAt'> {
    return {
      runId: childRun.id,
      type: 'run.created',
      schemaVersion: 1,
      payload: {
        rootRunId: childRun.rootRunId,
        parentRunId: childRun.parentRunId,
        parentStepId: childRun.parentStepId,
        delegateName: childRun.delegateName,
        delegationDepth: childRun.delegationDepth,
      },
    };
  }

  private runStatusChangedEvent(
    run: AgentRun,
    stepId: string | undefined,
    toStatus: RunStatus,
    currentChildRunId: UUID | null,
  ): Omit<AgentEvent, 'id' | 'seq' | 'createdAt'> {
    return {
      runId: run.id,
      stepId,
      type: 'run.status_changed',
      schemaVersion: 1,
      payload: {
        fromStatus: run.status,
        toStatus,
        currentChildRunId,
      },
    };
  }

  private parentToolResolutionEvent(params: {
    parentRunId: UUID;
    stepId?: string;
    delegateName: string;
    toolName: string;
    childRunId: UUID;
    mapped:
      | { kind: 'success'; output: JsonValue }
      | { kind: 'failure'; error: string; code: RunFailureCode };
  }): Omit<AgentEvent, 'id' | 'seq' | 'createdAt'> {
    if (params.mapped.kind === 'success') {
      return {
        runId: params.parentRunId,
        stepId: params.stepId,
        type: 'tool.completed',
        schemaVersion: 1,
        payload: {
          toolName: params.toolName,
          delegateName: params.delegateName,
          childRunId: params.childRunId,
          output: params.mapped.output,
        },
      };
    }

    return {
      runId: params.parentRunId,
      stepId: params.stepId,
      type: 'tool.failed',
      schemaVersion: 1,
      payload: {
        toolName: params.toolName,
        delegateName: params.delegateName,
        childRunId: params.childRunId,
        error: params.mapped.error,
        code: params.mapped.code,
      },
    };
  }

  private async emitDownstreamOnly(events: Array<Omit<AgentEvent, 'id' | 'seq' | 'createdAt'>>): Promise<void> {
    if (!this.options.downstreamEventSink) {
      return;
    }

    for (const event of events) {
      await this.options.downstreamEventSink.emit(event);
    }
  }

  private async getSnapshotChildRunId(runId: UUID): Promise<UUID | undefined> {
    const snapshot = await this.options.snapshotStore?.getLatest(runId);
    if (!snapshot || !isJsonObject(snapshot.state)) {
      return undefined;
    }

    const waitingOnChildRunId = snapshot.state.waitingOnChildRunId;
    return typeof waitingOnChildRunId === 'string' ? waitingOnChildRunId : undefined;
  }

  private async failParentRun(parentRun: AgentRun, message: string): Promise<AgentRun> {
    const failedParent = await this.options.runStore.updateRun(
      parentRun.id,
      {
        status: 'failed',
        currentChildRunId: undefined,
        errorCode: 'TOOL_ERROR',
        errorMessage: message,
      },
      parentRun.version,
    );

    await this.emitRunEvent({
      runId: parentRun.id,
      type: 'run.failed',
      stepId: parentRun.currentStepId,
      schemaVersion: 1,
      payload: {
        error: message,
        code: 'TOOL_ERROR',
      },
    });

    this.logLifecycle('error', 'run.failed', {
      ...runLogBindings(failedParent),
      stepId: failedParent.currentStepId,
      error: message,
      code: 'TOOL_ERROR',
    });

    return failedParent;
  }

  private validateChildLinkage(parentRun: AgentRun, childRun: AgentRun, stepId?: string): string | null {
    if (childRun.parentRunId !== parentRun.id) {
      return `Child run ${childRun.id} is not linked to parent run ${parentRun.id}`;
    }

    if (childRun.rootRunId !== parentRun.rootRunId) {
      return `Child run ${childRun.id} root ${childRun.rootRunId} does not match parent root ${parentRun.rootRunId}`;
    }

    if (stepId && childRun.parentStepId && childRun.parentStepId !== stepId) {
      return `Child run ${childRun.id} parent step ${childRun.parentStepId} does not match parent step ${stepId}`;
    }

    return null;
  }

  private mapChildRun(childRun: AgentRun):
    | { kind: 'success'; output: JsonValue }
    | { kind: 'failure'; error: string; code: RunFailureCode } {
    if (childRun.status === 'succeeded') {
      return {
        kind: 'success',
        output: childRun.result ?? null,
      };
    }

    if (childRun.status === 'replan_required') {
      return {
        kind: 'failure',
        error: childRun.errorMessage ?? 'Child run requires replanning',
        code: 'REPLAN_REQUIRED',
      };
    }

    if (childRun.status === 'interrupted' || childRun.status === 'cancelled') {
      return {
        kind: 'failure',
        error: childRun.errorMessage ?? 'Child run did not complete successfully',
        code: 'INTERRUPTED',
      };
    }

    return {
      kind: 'failure',
      error: childRun.errorMessage ?? 'Child run failed',
      code: (childRun.errorCode as RunFailureCode | undefined) ?? 'TOOL_ERROR',
    };
  }

  private resultFailure(result: Exclude<RunResult, { status: 'success' }>): { error: string; code: RunFailureCode } {
    if (result.status === 'failure') {
      return {
        error: result.error,
        code: result.code,
      };
    }

    if (result.status === 'approval_requested') {
      return {
        error: `Child run requested approval for ${result.toolName}: ${result.message}`,
        code: 'TOOL_ERROR',
      };
    }

    return {
      error: `Child run requested clarification: ${result.message}`,
      code: 'TOOL_ERROR',
    };
  }

  private async assertDelegationAllowed(delegate: DelegateDefinition, parentContext: ToolContext): Promise<void> {
    if (!this.delegatesByName.has(delegate.name)) {
      throw new DelegationError(`Unknown delegate profile ${delegate.name}`);
    }

    if (parentContext.delegationDepth >= this.policy.maxDepth) {
      throw new DelegationError(`Delegation depth limit ${this.policy.maxDepth} exceeded`);
    }

    if (parentContext.delegateName === delegate.name && !this.policy.allowRecursiveDelegation) {
      throw new DelegationError(`Recursive delegation to ${delegate.name} is not allowed`);
    }

    const parentRun = await this.options.runStore.getRun(parentContext.runId);
    if (!parentRun) {
      throw new DelegationError(`Parent run ${parentContext.runId} does not exist`);
    }

    if (parentRun.currentChildRunId) {
      throw new DelegationError(`Parent run ${parentContext.runId} already has an active child run`);
    }

    if ('listChildren' in this.options.runStore) {
      const store = this.options.runStore as HierarchicalRunStore;
      const children = await store.listChildren(parentContext.runId);
      if (children.length >= this.policy.maxChildrenPerRun) {
        throw new DelegationError(
          `Parent run ${parentContext.runId} exceeded maxChildrenPerRun=${this.policy.maxChildrenPerRun}`,
        );
      }
    }
  }

  private async emitParentToolEvent(params: {
    parentContext: AgentRun;
    stepId?: string;
    type: 'tool.completed' | 'tool.failed';
    payload: JsonValue;
  }): Promise<void> {
    await this.emitRunEvent({
      runId: params.parentContext.id,
      stepId: params.stepId,
      type: params.type,
      schemaVersion: 1,
      payload: params.payload,
    });
  }

  private async emitRunEvent(event: {
    runId: UUID;
    type:
      | 'run.created'
      | 'run.status_changed'
      | 'run.completed'
      | 'run.failed'
      | 'snapshot.created'
      | 'delegate.spawned'
      | 'tool.completed'
      | 'tool.failed';
    schemaVersion: number;
    payload: JsonValue;
    stepId?: string;
  }): Promise<void> {
    await this.options.eventSink?.emit(event);
  }

  private pendingReason(status: RunStatus): string {
    switch (status) {
      case 'queued':
      case 'planning':
      case 'running':
        return 'child run is still in progress';
      case 'awaiting_approval':
        return 'child run is awaiting approval';
      case 'awaiting_subagent':
        return 'child run is awaiting its own child run';
      case 'interrupted':
        return 'child run is interrupted and must be resumed cooperatively';
      default:
        return `child run is ${status}`;
    }
  }

  private pickTools(allowedTools: string[]): ToolDefinition[] {
    return allowedTools.map((toolName) => {
      const tool = this.hostToolsByName.get(toolName);
      if (!tool) {
        throw new DelegationError(`Delegate references unavailable tool ${toolName}`);
      }

      return tool;
    });
  }

  private toDelegateToolName(delegateName: string): string {
    return `${DELEGATE_TOOL_NAMESPACE}${delegateName}`;
  }

  private logLifecycle(
    level: 'debug' | 'info' | 'warn' | 'error',
    event: string,
    payload: Record<string, unknown>,
  ): void {
    if (!this.logger) {
      return;
    }

    const entry = {
      event,
      ...payload,
    };

    switch (level) {
      case 'debug':
        this.logger.debug(entry, event);
        return;
      case 'info':
        this.logger.info(entry, event);
        return;
      case 'warn':
        this.logger.warn(entry, event);
        return;
      case 'error':
        this.logger.error(entry, event);
        return;
    }
  }
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toDelegateToolInput(input: JsonValue): DelegateToolInput {
  if (!isJsonObject(input) || typeof input.goal !== 'string') {
    throw new DelegationError('delegate.* tools require a JSON object input with a string goal');
  }

  return input as unknown as DelegateToolInput;
}
