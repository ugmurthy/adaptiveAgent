import type {
  AgentEvent,
  AgentRun,
  ContinuationStrategy,
  FailureClass,
  JsonValue,
  PlanStep,
  RecoveryPolicy,
  RunRecoveryOptions,
  RuntimeStores,
  RunSnapshot,
  UUID,
} from './types.js';

const DEFAULT_CONTINUATION_STRATEGY: ContinuationStrategy = 'hybrid_snapshot_then_step';
const TERMINAL_FAILED_STATUS = 'failed';

export interface RunRecoveryAnalyzerOptions extends RuntimeStores {
  recovery?: RecoveryPolicy;
  defaultProvider?: string;
  defaultModel?: string;
}

interface FailureClassification {
  failureClass: FailureClass;
  reason: string;
}

interface SafeBoundary {
  lastSafeEventSeq?: number;
  lastCompletedStepId?: string;
  nextStepId?: string;
  requiresReconciliation: boolean;
  unsafeReason?: string;
}

export class RunRecoveryAnalyzer {
  constructor(private readonly options: RunRecoveryAnalyzerOptions) {}

  async getRecoveryOptions(runId: UUID): Promise<RunRecoveryOptions> {
    const run = await this.options.runStore.getRun(runId);
    if (!run) {
      throw new Error(`Run ${runId} does not exist`);
    }

    if (run.status !== TERMINAL_FAILED_STATUS) {
      return {
        runId,
        continuable: false,
        decision: run.status === 'interrupted' ? 'retry_same_run' : 'not_recoverable',
        failureClass: 'unknown',
        reason: `Run ${runId} is ${run.status}; continuation requires a failed source run`,
      };
    }

    const snapshot = await this.options.snapshotStore?.getLatest(run.id);
    if (!snapshot) {
      return {
        runId,
        continuable: false,
        decision: 'not_recoverable',
        failureClass: 'unknown',
        reason: `Run ${runId} has no snapshot to use as a continuation base`,
      };
    }

    if (!isCompatibleExecutionSnapshot(snapshot)) {
      return {
        runId,
        continuable: false,
        decision: 'not_recoverable',
        failureClass: 'unknown',
        sourceSnapshotId: snapshot.id,
        sourceSnapshotSeq: snapshot.snapshotSeq,
        reason: `Run ${runId} latest snapshot is not compatible with this runtime`,
      };
    }

    const events = await this.options.eventStore?.listByRun(run.id, 0) ?? [];
    const planSteps = await this.loadPlanSteps(run, snapshot);
    const classification = classifyFailure(run, events);
    const boundary = findSafeBoundary(snapshot, events, planSteps);
    const fallback = selectFallbackModel(this.options.recovery, classification.failureClass, run.errorCode);

    if (boundary.requiresReconciliation) {
      return {
        runId,
        continuable: false,
        decision: 'requires_reconciliation',
        failureClass: 'tool_uncertain',
        reason: boundary.unsafeReason ?? 'Run requires reconciliation before continuation',
        recommendedStrategy: this.defaultStrategy(),
        recommendedProvider: fallback?.provider,
        recommendedModel: fallback?.model,
        sourceSnapshotId: snapshot.id,
        sourceSnapshotSeq: snapshot.snapshotSeq,
        lastSafeEventSeq: boundary.lastSafeEventSeq,
        lastCompletedStepId: boundary.lastCompletedStepId,
        nextStepId: boundary.nextStepId,
        requiresReconciliation: true,
        unsafeReason: boundary.unsafeReason,
      };
    }

    return {
      runId,
      continuable: this.options.recovery?.continuation?.enabled !== false,
      decision: this.options.recovery?.continuation?.enabled === false ? 'not_recoverable' : 'continue_new_run',
      failureClass: classification.failureClass,
      reason: classification.reason,
      recommendedStrategy: this.defaultStrategy(),
      recommendedProvider: fallback?.provider,
      recommendedModel: fallback?.model,
      sourceSnapshotId: snapshot.id,
      sourceSnapshotSeq: snapshot.snapshotSeq,
      lastSafeEventSeq: boundary.lastSafeEventSeq,
      lastCompletedStepId: boundary.lastCompletedStepId,
      nextStepId: boundary.nextStepId,
      requiresReconciliation: false,
    };
  }

  private async loadPlanSteps(run: AgentRun, snapshot: RunSnapshot): Promise<PlanStep[]> {
    const planId = run.currentPlanId ?? snapshot.currentPlanId;
    if (!planId || !this.options.planStore) {
      return [];
    }

    return this.options.planStore.listSteps(planId);
  }

  private defaultStrategy(): ContinuationStrategy {
    return this.options.recovery?.continuation?.defaultStrategy ?? DEFAULT_CONTINUATION_STRATEGY;
  }
}

function classifyFailure(run: AgentRun, events: AgentEvent[]): FailureClassification {
  const errorCode = (run.errorCode ?? '').toLowerCase();
  const errorMessage = (run.errorMessage ?? '').toLowerCase();
  const latestFailedEvent = [...events].reverse().find((event) => event.type === 'model.failed' || event.type === 'tool.failed');
  const failedPayload = isJsonObject(latestFailedEvent?.payload) ? latestFailedEvent.payload : undefined;
  const failedPayloadError = typeof failedPayload?.error === 'string' ? failedPayload.error.toLowerCase() : '';
  const combined = [errorCode, errorMessage, failedPayloadError].join(' ');

  if (combined.includes('approval') || combined.includes('clarification') || run.errorCode === 'APPROVAL_REJECTED') {
    return {
      failureClass: 'user_action_required',
      reason: 'Run failed because user action is required',
    };
  }

  if (
    combined.includes('timeout') ||
    combined.includes('timed out') ||
    combined.includes('524') ||
    combined.includes('rate limit') ||
    combined.includes('429') ||
    combined.includes('5xx') ||
    /\b5\d\d\b/.test(combined)
  ) {
    return {
      failureClass: 'provider_transient',
      reason: 'Run failed due to a retryable provider or network condition',
    };
  }

  if (run.errorCode === 'MODEL_ERROR') {
    return {
      failureClass: 'agent_invalid_output',
      reason: 'Run failed while interacting with the model',
    };
  }

  if (run.errorCode === 'TOOL_ERROR') {
    return {
      failureClass: 'tool_failed',
      reason: 'Run failed while executing a tool',
    };
  }

  if (run.errorCode === 'REPLAN_REQUIRED') {
    return {
      failureClass: 'policy_blocked',
      reason: 'Run failed because the existing plan is no longer compatible',
    };
  }

  return {
    failureClass: 'unknown',
    reason: run.errorMessage ?? 'Run failed for an unknown reason',
  };
}

function findSafeBoundary(snapshot: RunSnapshot, events: AgentEvent[], planSteps: PlanStep[]): SafeBoundary {
  const completedStepIds = new Set<string>();
  const startedToolCalls = new Map<string, AgentEvent>();
  const closedToolCalls = new Set<string>();
  let lastSafeEventSeq: number | undefined;
  let lastCompletedStepId: string | undefined;

  for (const event of events) {
    if (event.type === 'tool.started' && event.toolCallId) {
      startedToolCalls.set(event.toolCallId, event);
    }

    if ((event.type === 'tool.completed' || event.type === 'tool.failed') && event.toolCallId) {
      closedToolCalls.add(event.toolCallId);
    }

    if (event.type === 'step.completed' && event.stepId) {
      completedStepIds.add(event.stepId);
      lastCompletedStepId = event.stepId;
      lastSafeEventSeq = event.seq;
    }
  }

  const unresolvedToolCall = Array.from(startedToolCalls.entries()).find(
    ([toolCallId]) => !closedToolCalls.has(toolCallId),
  );
  if (unresolvedToolCall) {
    const [, event] = unresolvedToolCall;
    return {
      lastSafeEventSeq,
      lastCompletedStepId,
      nextStepId: findNextStepId(snapshot, completedStepIds, planSteps),
      requiresReconciliation: true,
      unsafeReason: `Tool call ${event.toolCallId ?? 'unknown'} started but no durable tool completion was recorded`,
    };
  }

  return {
    lastSafeEventSeq,
    lastCompletedStepId,
    nextStepId: findNextStepId(snapshot, completedStepIds, planSteps),
    requiresReconciliation: false,
  };
}

function findNextStepId(snapshot: RunSnapshot, completedStepIds: Set<string>, planSteps: PlanStep[]): string | undefined {
  if (planSteps.length > 0) {
    return planSteps.find((step) => !completedStepIds.has(step.id))?.id;
  }

  const state = isJsonObject(snapshot.state) ? snapshot.state : undefined;
  const stepsUsed = typeof state?.stepsUsed === 'number' ? state.stepsUsed : undefined;
  return stepsUsed === undefined ? snapshot.currentStepId : `step-${stepsUsed + 1}`;
}

function selectFallbackModel(
  policy: RecoveryPolicy | undefined,
  failureClass: FailureClass,
  errorCode: string | undefined,
): { provider: string; model: string } | undefined {
  return policy?.fallbackModels?.find((fallback) => {
    const classMatches = !fallback.whenFailureClass || fallback.whenFailureClass.includes(failureClass);
    const codeMatches = !fallback.whenErrorCode || (errorCode ? fallback.whenErrorCode.includes(errorCode) : false);
    return classMatches && codeMatches;
  });
}

function isCompatibleExecutionSnapshot(snapshot: RunSnapshot): boolean {
  if (!isJsonObject(snapshot.state)) {
    return false;
  }

  return snapshot.state.schemaVersion === undefined || snapshot.state.schemaVersion === 1;
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
