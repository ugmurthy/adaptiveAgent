import type { Logger } from 'pino';

import { DelegationError, DelegationExecutor, type ExecuteChildRunRequest, type ParentResumeResult } from './delegation-executor.js';
import {
  captureToolInputForLog,
  captureToolOutputForLog,
  runLogBindings,
  summarizeModelRequestForLog,
  summarizeModelResponseForLog,
} from './logging.js';
import { captureValueForLog, errorForLog, summarizeValueForLog } from './logger.js';
import type {
  AdaptiveAgentOptions,
  AgentEvent,
  AgentRun,
  CaptureMode,
  ChatMessage,
  ChatRequest,
  ChatResult,
  ExecutePlanRequest,
  EventSink,
  JsonObject,
  JsonSchema,
  JsonValue,
  ModelMessage,
  ModelResponse,
  PlanCondition,
  PlanExecution,
  PlanRequest,
  PlanStep,
  RunFailureCode,
  RunRequest,
  RunResult,
  RunSnapshot,
  RunStatus,
  ToolContext,
  ToolDefinition,
  UsageSummary,
  UUID,
} from './types.js';

interface PendingToolCallState {
  id: string;
  name: string;
  input: JsonValue;
  stepId: string;
  needsStepStarted: boolean;
}

interface ExecutionState {
  messages: ModelMessage[];
  stepsUsed: number;
  outputSchema?: JsonSchema;
  pendingToolCalls: PendingToolCallState[];
  approvedToolCallIds: string[];
  waitingOnChildRunId?: UUID;
}

interface RunContinuationOptions {
  outputSchema?: JsonSchema;
}

const DEFAULT_AGENT_DEFAULTS = {
  maxSteps: 30,
  toolTimeoutMs: 60_000,
  modelTimeoutMs: 90_000,
  maxRetriesPerStep: 0,
} as const;

const OLLAMA_MODEL_TIMEOUT_MULTIPLIER = 4;

const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  'succeeded',
  'failed',
  'clarification_requested',
  'replan_required',
  'cancelled',
]);

const RESERVED_DELEGATE_PREFIX = 'delegate.';
const CHAT_GOAL_MAX_LENGTH = 120;

export class AdaptiveAgent {
  private readonly toolRegistry = new Map<string, ToolDefinition>();
  private readonly defaults: {
    maxSteps: number;
    toolTimeoutMs: number;
    modelTimeoutMs: number;
    maxRetriesPerStep: number;
  };
  private readonly defaultCaptureMode: CaptureMode;
  private readonly leaseOwner = `adaptive-agent:${crypto.randomUUID()}`;
  private readonly eventEmitter: EventSink;
  private readonly delegationExecutor: DelegationExecutor;
  private readonly logger?: Logger;

  constructor(private readonly options: AdaptiveAgentOptions) {
    this.defaults = {
      maxSteps: options.defaults?.maxSteps ?? DEFAULT_AGENT_DEFAULTS.maxSteps,
      toolTimeoutMs: options.defaults?.toolTimeoutMs ?? DEFAULT_AGENT_DEFAULTS.toolTimeoutMs,
      modelTimeoutMs: options.defaults?.modelTimeoutMs ?? resolveDefaultModelTimeoutMs(options.model.provider),
      maxRetriesPerStep: options.defaults?.maxRetriesPerStep ?? DEFAULT_AGENT_DEFAULTS.maxRetriesPerStep,
    };
    this.defaultCaptureMode = options.defaults?.capture ?? 'summary';
    this.logger = options.logger?.child({
      component: 'adaptive-agent',
      provider: options.model.provider,
      model: options.model.model,
    });
    this.eventEmitter = createCompositeEventSink(options.eventStore, options.eventSink);
    this.delegationExecutor = new DelegationExecutor({
      model: options.model,
      tools: options.tools,
      delegates: options.delegates,
      delegation: options.delegation,
      defaults: options.defaults,
      runStore: options.runStore,
      eventSink: this.eventEmitter,
      logger: this.logger,
      snapshotStore: options.snapshotStore,
      executeChildRun: (request) => this.executeChildRun(request),
    });

    for (const tool of this.delegationExecutor.getTools()) {
      if (this.toolRegistry.has(tool.name)) {
        throw new Error(`Duplicate tool name ${tool.name}`);
      }

      this.toolRegistry.set(tool.name, tool);
    }

    this.logLifecycle('debug', 'agent.initialized', {
      toolNames: Array.from(this.toolRegistry.keys()),
      delegateNames: (options.delegates ?? []).map((delegate) => delegate.name),
      defaults: this.defaults,
    });
  }

  async run(request: RunRequest): Promise<RunResult> {
    const createdRun = await this.options.runStore.createRun({
      goal: request.goal,
      input: request.input,
      context: request.context,
      metadata: request.metadata,
      status: 'queued',
    });

    this.logLifecycle('info', 'run.created', {
      ...runLogBindings(createdRun),
      goal: summarizeValueForLog(request.goal),
      input: captureValueForLog(request.input, { mode: this.defaultCaptureMode }),
      context: captureValueForLog(request.context, { mode: this.defaultCaptureMode }),
      metadata: captureValueForLog(request.metadata, { mode: 'summary' }),
      outputSchema: request.outputSchema ? summarizeValueForLog(request.outputSchema) : undefined,
    });

    await this.emit({
      runId: createdRun.id,
      type: 'run.created',
      schemaVersion: 1,
      payload: {
        goal: createdRun.goal,
        rootRunId: createdRun.rootRunId,
        delegationDepth: createdRun.delegationDepth,
      },
    });

    const initialState = this.createInitialExecutionState(createdRun, request.outputSchema);
    await this.saveExecutionSnapshot(createdRun, initialState, createdRun.status);
    return this.runWithExistingRun(createdRun.id, { outputSchema: request.outputSchema });
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const initialMessages = buildInitialChatMessages(request.messages, request.context, this.options.systemInstructions);
    const goal = summarizeChatGoal(request.messages);
    const createdRun = await this.options.runStore.createRun({
      goal,
      context: request.context,
      metadata: request.metadata,
      status: 'queued',
    });

    this.logLifecycle('info', 'run.created', {
      ...runLogBindings(createdRun),
      goal: summarizeValueForLog(goal),
      context: captureValueForLog(request.context, { mode: this.defaultCaptureMode }),
      metadata: captureValueForLog(request.metadata, { mode: 'summary' }),
      outputSchema: request.outputSchema ? summarizeValueForLog(request.outputSchema) : undefined,
      chat: true,
      messageCount: request.messages.length,
    });

    await this.emit({
      runId: createdRun.id,
      type: 'run.created',
      schemaVersion: 1,
      payload: {
        goal: createdRun.goal,
        rootRunId: createdRun.rootRunId,
        delegationDepth: createdRun.delegationDepth,
      },
    });

    const initialState = this.createExecutionState(initialMessages, request.outputSchema);
    await this.saveExecutionSnapshot(createdRun, initialState, createdRun.status);
    return this.runWithExistingRun(createdRun.id, { outputSchema: request.outputSchema });
  }

  async plan(_request: PlanRequest): Promise<never> {
    throw new Error('plan() is not implemented in this scaffold yet');
  }

  async executePlan(request: ExecutePlanRequest): Promise<RunResult> {
    const planStore = this.options.planStore;
    if (!planStore) {
      throw new Error('executePlan() requires a configured planStore');
    }

    const plan = await planStore.getPlan(request.planId);
    if (!plan) {
      throw new Error(`Plan ${request.planId} does not exist`);
    }

    const steps = await planStore.listSteps(plan.id);
    const createdRun = await this.options.runStore.createRun({
      goal: plan.goal,
      input: request.input,
      context: request.context,
      metadata: mergeMetadata(plan.metadata, request.metadata),
      status: 'queued',
    });
    const planExecution = await planStore.createExecution({
      id: crypto.randomUUID(),
      planId: plan.id,
      runId: createdRun.id,
      attempt: 1,
      status: 'queued',
      input: request.input,
      context: request.context,
    });

    let currentRun = await this.options.runStore.updateRun(
      createdRun.id,
      {
        currentPlanId: plan.id,
        currentPlanExecutionId: planExecution.id,
      },
      createdRun.version,
    );

    this.logLifecycle('info', 'plan.execution_started', {
      ...runLogBindings(currentRun),
      planId: plan.id,
      planExecutionId: planExecution.id,
      goal: summarizeValueForLog(plan.goal),
      input: captureValueForLog(request.input, { mode: this.defaultCaptureMode }),
      context: captureValueForLog(request.context, { mode: this.defaultCaptureMode }),
      metadata: captureValueForLog(request.metadata, { mode: 'summary' }),
      stepCount: steps.length,
    });

    await this.emit({
      runId: currentRun.id,
      planExecutionId: planExecution.id,
      type: 'run.created',
      schemaVersion: 1,
      payload: {
        goal: currentRun.goal,
        rootRunId: currentRun.rootRunId,
        delegationDepth: currentRun.delegationDepth,
        planId: plan.id,
        planExecutionId: planExecution.id,
      },
    });

    await this.emit({
      runId: currentRun.id,
      planExecutionId: planExecution.id,
      type: 'plan.execution_started',
      schemaVersion: 1,
      payload: {
        planId: plan.id,
        planExecutionId: planExecution.id,
      },
    });

    await this.acquireLeaseOrThrow(currentRun.id);

    try {
      currentRun = await this.refreshRun(currentRun.id);
      currentRun = await this.transitionRun(currentRun, 'running');
      let currentExecution = await planStore.updateExecution(planExecution.id, { status: 'running' });

      const compatibilityError = this.planCompatibilityError(steps);
      if (compatibilityError) {
        return this.failPlanExecution(currentRun, currentExecution, 0, compatibilityError, 'REPLAN_REQUIRED');
      }

      const resolvedStepOutputs = new Map<string, JsonValue>();
      let stepsUsed = 0;
      let lastOutput: JsonValue = null;

      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index];
        currentRun = await this.ensureRunStep(currentRun, step.id);
        currentExecution = await planStore.updateExecution(currentExecution.id, {
          currentStepId: step.id,
          currentStepIndex: index,
        });

        if (!planStepPreconditionsMet(step, request.input, request.context, resolvedStepOutputs)) {
          this.logLifecycle('debug', 'step.completed', {
            ...runLogBindings(currentRun),
            planExecutionId: currentExecution.id,
            stepId: step.id,
            skipped: true,
          });
          await this.emit({
            runId: currentRun.id,
            planExecutionId: currentExecution.id,
            stepId: step.id,
            type: 'step.completed',
            schemaVersion: 1,
            payload: {
              stepId: step.id,
              skipped: true,
            },
          });
          continue;
        }

        const tool = this.toolRegistry.get(step.toolName);
        if (!tool) {
          return this.failPlanExecution(
            currentRun,
            currentExecution,
            stepsUsed,
            `Persisted plan step ${step.id} references unavailable tool ${step.toolName}`,
            'REPLAN_REQUIRED',
          );
        }

        this.logLifecycle('debug', 'step.started', {
          ...runLogBindings(currentRun),
          planExecutionId: currentExecution.id,
          stepId: step.id,
          toolName: tool.name,
          stepIndex: index,
        });

        await this.emit({
          runId: currentRun.id,
          planExecutionId: currentExecution.id,
          stepId: step.id,
          type: 'step.started',
          schemaVersion: 1,
          payload: {
            stepId: step.id,
            planId: plan.id,
            planExecutionId: currentExecution.id,
          },
        });

        if ((tool.requiresApproval || step.requiresApproval) && !this.options.defaults?.autoApproveAll) {
          currentRun = await this.transitionRun(currentRun, 'awaiting_approval');
          currentExecution = await planStore.updateExecution(currentExecution.id, {
            status: 'awaiting_approval',
            currentStepId: step.id,
            currentStepIndex: index,
          });

          this.logLifecycle('warn', 'approval.requested', {
            ...runLogBindings(currentRun),
            planExecutionId: currentExecution.id,
            stepId: step.id,
            toolName: tool.name,
            input: captureToolInputForLog(tool, resolvePlanTemplate(step.inputTemplate, request.input, request.context, resolvedStepOutputs), this.defaultCaptureMode),
          });

          await this.emit({
            runId: currentRun.id,
            planExecutionId: currentExecution.id,
            stepId: step.id,
            type: 'approval.requested',
            schemaVersion: 1,
            payload: {
              toolName: tool.name,
              planId: plan.id,
              planExecutionId: currentExecution.id,
            },
          });

          return {
            status: 'approval_requested',
            runId: currentRun.id,
            message: `Approval required before invoking ${tool.name}`,
            toolName: tool.name,
          };
        }

        const input = resolvePlanTemplate(step.inputTemplate, request.input, request.context, resolvedStepOutputs);
        const toolContext = this.createToolContext(currentRun, step.id, `plan:${currentExecution.id}:${step.id}`);
        const toolStartedAt = Date.now();
        let recoveredToolFailure = false;

        this.logToolStarted(currentRun, step.id, tool, input, {
          planId: plan.id,
          planExecutionId: currentExecution.id,
          stepIndex: index,
        });

        await this.emit({
          runId: currentRun.id,
          planExecutionId: currentExecution.id,
          stepId: step.id,
          type: 'tool.started',
          schemaVersion: 1,
          payload: {
            toolName: tool.name,
            planId: plan.id,
            planExecutionId: currentExecution.id,
          },
        });

        try {
          lastOutput = await runWithTimeout(tool.timeoutMs ?? this.defaults.toolTimeoutMs, toolContext.signal, () =>
            tool.execute(input, toolContext),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const recoveredOutput = recoverToolError(tool, error, input);
          this.logToolFailed(currentRun, step.id, tool, input, error, Date.now() - toolStartedAt, {
            planId: plan.id,
            planExecutionId: currentExecution.id,
            stepIndex: index,
            recoverable: recoveredOutput !== undefined,
            recoveredOutput:
              recoveredOutput === undefined
                ? undefined
                : captureToolOutputForLog(tool, recoveredOutput, this.defaultCaptureMode),
          });
          await this.emit({
            runId: currentRun.id,
            planExecutionId: currentExecution.id,
            stepId: step.id,
            type: 'tool.failed',
            schemaVersion: 1,
            payload: {
              toolName: tool.name,
              error: message,
              recoverable: recoveredOutput !== undefined,
              output:
                recoveredOutput === undefined
                  ? undefined
                  : tool.summarizeResult
                    ? tool.summarizeResult(recoveredOutput)
                    : recoveredOutput,
            },
          });

          if (recoveredOutput !== undefined) {
            recoveredToolFailure = true;
            lastOutput = recoveredOutput;
          } else {
            if (step.onFailure === 'skip') {
              await this.emit({
                runId: currentRun.id,
                planExecutionId: currentExecution.id,
                stepId: step.id,
                type: 'step.completed',
                schemaVersion: 1,
                payload: {
                  stepId: step.id,
                  skipped: true,
                  error: message,
                },
              });
              continue;
            }

            const failureCode = step.onFailure === 'replan' ? 'REPLAN_REQUIRED' : 'TOOL_ERROR';
            return this.failPlanExecution(currentRun, currentExecution, stepsUsed, message, failureCode);
          }
        }

        stepsUsed += 1;
        resolvedStepOutputs.set(step.id, lastOutput);
        if (step.outputKey) {
          resolvedStepOutputs.set(step.outputKey, lastOutput);
        }

        if (!recoveredToolFailure) {
          this.logToolCompleted(currentRun, step.id, tool, input, lastOutput, Date.now() - toolStartedAt, {
            planId: plan.id,
            planExecutionId: currentExecution.id,
            stepIndex: index,
          });

          await this.emit({
            runId: currentRun.id,
            planExecutionId: currentExecution.id,
            stepId: step.id,
            type: 'tool.completed',
            schemaVersion: 1,
            payload: {
              toolName: tool.name,
              output: tool.summarizeResult ? tool.summarizeResult(lastOutput) : lastOutput,
            },
          });
        }
        this.logLifecycle('debug', 'step.completed', {
          ...runLogBindings(currentRun),
          planExecutionId: currentExecution.id,
          stepId: step.id,
          toolName: tool.name,
        });
        await this.emit({
          runId: currentRun.id,
          planExecutionId: currentExecution.id,
          stepId: step.id,
          type: 'step.completed',
          schemaVersion: 1,
          payload: {
            stepId: step.id,
            toolName: tool.name,
          },
        });
      }

      currentExecution = await planStore.updateExecution(currentExecution.id, {
        status: 'succeeded',
        output: lastOutput,
      });
      const completedRun = await this.options.runStore.updateRun(
        currentRun.id,
        {
          status: 'succeeded',
          result: lastOutput,
        },
        currentRun.version,
      );

      await this.emit({
        runId: completedRun.id,
        planExecutionId: currentExecution.id,
        stepId: completedRun.currentStepId,
        type: 'run.completed',
        schemaVersion: 1,
        payload: {
          output: lastOutput,
          stepsUsed,
          planId: plan.id,
          planExecutionId: currentExecution.id,
        },
      });

      return {
        status: 'success',
        runId: completedRun.id,
        planId: plan.id,
        output: lastOutput,
        stepsUsed,
        usage: completedRun.usage,
      };
    } finally {
      await this.releaseLeaseQuietly(currentRun.id);
    }
  }

  async interrupt(runId: UUID): Promise<void> {
    const run = await this.options.runStore.getRun(runId);
    if (!run || TERMINAL_RUN_STATUSES.has(run.status) || run.status === 'interrupted') {
      return;
    }

    const interruptedRun = await this.transitionRun(run, 'interrupted');
    this.logLifecycle('warn', 'run.interrupted', {
      ...runLogBindings(interruptedRun),
      stepId: interruptedRun.currentStepId,
    });
    await this.emit({
      runId,
      stepId: interruptedRun.currentStepId,
      type: 'run.interrupted',
      schemaVersion: 1,
      payload: {
        status: 'interrupted',
      },
    });

    const state = await this.loadExecutionState(interruptedRun);
    await this.saveExecutionSnapshot(interruptedRun, state, 'interrupted');

    if (interruptedRun.currentChildRunId) {
      await this.interrupt(interruptedRun.currentChildRunId);
    }
  }

  async resolveApproval(runId: UUID, approved: boolean): Promise<void> {
    const run = await this.options.runStore.getRun(runId);
    if (!run) {
      throw new Error(`Run ${runId} does not exist`);
    }

    if (run.status !== 'awaiting_approval') {
      throw new Error(`Run ${runId} is not awaiting approval`);
    }

    const state = await this.loadExecutionState(run);
    const pendingToolCall = state.pendingToolCalls[0];
    if (!pendingToolCall) {
      throw new Error(
        `Run ${runId} is awaiting approval, but no pending tool call was found. Persisted plan approval resolution is not implemented yet.`,
      );
    }

    await this.emit({
      runId: run.id,
      stepId: pendingToolCall.stepId,
      type: 'approval.resolved',
      schemaVersion: 1,
      payload: {
        toolName: pendingToolCall.name,
        approved,
      },
    });

    this.logLifecycle('info', 'approval.resolved', {
      ...runLogBindings(run),
      stepId: pendingToolCall.stepId,
      toolName: pendingToolCall.name,
      approved,
    });

    if (!approved) {
      await this.failRun(run, state, `Approval rejected for ${pendingToolCall.name}`, 'APPROVAL_REJECTED');
      return;
    }

    state.approvedToolCallIds = addApprovedToolCallId(state.approvedToolCallIds, pendingToolCall.id);
    const resumedRun = await this.transitionRun(run, 'running');
    await this.saveExecutionSnapshot(resumedRun, state, resumedRun.status);
  }

  async resume(runId: UUID): Promise<RunResult> {
    const run = await this.options.runStore.getRun(runId);
    if (!run) {
      throw new Error(`Run ${runId} does not exist`);
    }

    this.logLifecycle('info', 'run.resume_requested', {
      ...runLogBindings(run),
      status: run.status,
      stepId: run.currentStepId,
    });

    const state = await this.loadExecutionState(run);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      return this.resultFromStoredRun(run, state.stepsUsed);
    }

    if (run.status === 'awaiting_approval') {
      const pendingTool = state.pendingToolCalls[0];
      return {
        status: 'approval_requested',
        runId: run.id,
        message: pendingTool ? `Approval required before invoking ${pendingTool.name}` : 'Approval required',
        toolName: pendingTool?.name ?? 'unknown',
      };
    }

    let currentRun = run;
    if (run.status === 'awaiting_subagent') {
      try {
        currentRun = await this.resumeAwaitingParent(run, state);
      } catch (error) {
        if (error instanceof DelegationError) {
          return this.failRun(run, state, error.message, error.code);
        }

        return interruptResult(run.id, state.stepsUsed, run.usage, error instanceof Error ? error.message : String(error));
      }
    }

    if (currentRun.status === 'interrupted') {
      currentRun = await this.transitionRun(currentRun, 'running');
      this.logLifecycle('info', 'run.resumed', {
        ...runLogBindings(currentRun),
        stepId: currentRun.currentStepId,
      });
      await this.emit({
        runId,
        stepId: currentRun.currentStepId,
        type: 'run.resumed',
        schemaVersion: 1,
        payload: {
          status: 'running',
        },
      });
    }

    return this.runWithExistingRun(runId, { outputSchema: state.outputSchema });
  }

  private async runWithExistingRun(runId: UUID, options: RunContinuationOptions): Promise<RunResult> {
    const run = await this.options.runStore.getRun(runId);
    if (!run) {
      throw new Error(`Run ${runId} does not exist`);
    }

    const state = await this.loadExecutionState(run, options.outputSchema);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      return this.resultFromStoredRun(run, state.stepsUsed);
    }

    await this.acquireLeaseOrThrow(run.id);

    let currentRun = await this.refreshRun(run.id);
    if (currentRun.status !== 'running') {
      currentRun = await this.transitionRun(currentRun, 'running');
    }

    try {
      return await this.executionLoop(currentRun, state);
    } finally {
      await this.releaseLeaseQuietly(run.id);
    }
  }

  private async executionLoop(run: AgentRun, state: ExecutionState): Promise<RunResult> {
    let currentRun = run;

    while (state.stepsUsed < this.defaults.maxSteps) {
      await this.options.runStore.heartbeatLease({
        runId: currentRun.id,
        owner: this.leaseOwner,
        ttlMs: this.defaults.modelTimeoutMs,
        now: new Date(),
      });

      currentRun = await this.refreshRun(currentRun.id);
      if (currentRun.status === 'interrupted') {
        return interruptResult(currentRun.id, state.stepsUsed, currentRun.usage, 'Run interrupted cooperatively');
      }

      const pendingToolCall = state.pendingToolCalls[0];
      const stepId = pendingToolCall?.stepId ?? `step-${state.stepsUsed + 1}`;
      currentRun = await this.ensureRunStep(currentRun, stepId);

      if (pendingToolCall) {
        if (pendingToolCall.needsStepStarted) {
          this.logLifecycle('debug', 'step.started', {
            ...runLogBindings(currentRun),
            stepId,
            toolName: pendingToolCall.name,
          });
          await this.emit({
            runId: currentRun.id,
            stepId,
            type: 'step.started',
            schemaVersion: 1,
            payload: {
              stepId,
            },
          });
          pendingToolCall.needsStepStarted = false;
        }

        let toolOutput: JsonValue;
        try {
          toolOutput = await this.executePendingToolCall(currentRun, state, pendingToolCall);
        } catch (error) {
          if (error instanceof ApprovalRequiredError) {
            return {
              status: 'approval_requested',
              runId: currentRun.id,
              message: error.message,
              toolName: error.toolName,
            };
          }

          if (error instanceof DelegationError) {
            return this.failRun(currentRun, state, error.message, error.code);
          }

          return this.failRun(
            currentRun,
            state,
            error instanceof Error ? error.message : String(error),
            'TOOL_ERROR',
          );
        }

        state.messages.push(toolResultMessage(pendingToolCall, toolOutput));
        state.pendingToolCalls.shift();
        state.approvedToolCallIds = removeApprovedToolCallId(state.approvedToolCallIds, pendingToolCall.id);
        state.waitingOnChildRunId = undefined;
        state.stepsUsed += 1;

        this.logLifecycle('debug', 'step.completed', {
          ...runLogBindings(currentRun),
          stepId,
          toolName: pendingToolCall.name,
        });

        await this.emit({
          runId: currentRun.id,
          stepId,
          type: 'step.completed',
          schemaVersion: 1,
          payload: {
            stepId,
            toolName: pendingToolCall.name,
          },
        });

        currentRun = await this.refreshRun(currentRun.id);
        await this.saveExecutionSnapshot(currentRun, state, currentRun.status);
        continue;
      }

      this.logLifecycle('debug', 'step.started', {
        ...runLogBindings(currentRun),
        stepId,
      });

      await this.emit({
        runId: currentRun.id,
        stepId,
        type: 'step.started',
        schemaVersion: 1,
        payload: {
          stepId,
        },
      });

      let response: ModelResponse;
      try {
        response = await this.generateModelResponse(currentRun, state);
      } catch (error) {
        currentRun = await this.refreshRun(currentRun.id);
        return this.failRun(
          currentRun,
          state,
          error instanceof Error ? error.message : String(error),
          'MODEL_ERROR',
        );
      }

      currentRun = await this.refreshRun(currentRun.id);

      if (response.finishReason === 'error') {
        return this.failRun(currentRun, state, 'Model returned finishReason=error', 'MODEL_ERROR');
      }

      const assistantMessage = assistantMessageFromResponse(response);
      if (assistantMessage) {
        state.messages.push(assistantMessage);
      }

      if (response.toolCalls && response.toolCalls.length > 0) {
        state.pendingToolCalls.push(...createPendingToolCalls(response.toolCalls, state.stepsUsed + 1));

        this.logLifecycle('debug', 'model.tool_calls_queued', {
          ...runLogBindings(currentRun),
          stepId,
          toolCalls: response.toolCalls.map((toolCall) => ({
            id: toolCall.id,
            name: toolCall.name,
            input: summarizeValueForLog(toolCall.input),
          })),
        });

        await this.saveExecutionSnapshot(currentRun, state, currentRun.status);
        continue;
      }

      const output = response.structuredOutput ?? response.text ?? null;
      state.stepsUsed += 1;

      this.logLifecycle('debug', 'step.completed', {
        ...runLogBindings(currentRun),
        stepId,
        output: summarizeValueForLog(output),
      });

      await this.emit({
        runId: currentRun.id,
        stepId,
        type: 'step.completed',
        schemaVersion: 1,
        payload: {
          stepId,
        },
      });

      return this.completeRun(currentRun, state, output);
    }

    const latestRun = await this.refreshRun(run.id);
    return this.failRun(latestRun, state, 'Maximum steps exceeded', 'MAX_STEPS');
  }

  private async executePendingToolCall(
    run: AgentRun,
    state: ExecutionState,
    pendingToolCall: PendingToolCallState,
  ): Promise<JsonValue> {
    const tool = this.toolRegistry.get(pendingToolCall.name);
    if (!tool) {
      throw new Error(`Unknown tool ${pendingToolCall.name}`);
    }

    if (tool.requiresApproval && !this.options.defaults?.autoApproveAll && !state.approvedToolCallIds.includes(pendingToolCall.id)) {
      const awaitingApprovalRun = await this.transitionRun(run, 'awaiting_approval');
      this.logLifecycle('warn', 'approval.requested', {
        ...runLogBindings(awaitingApprovalRun),
        stepId: pendingToolCall.stepId,
        toolName: tool.name,
        input: captureToolInputForLog(tool, pendingToolCall.input, this.defaultCaptureMode),
      });
      await this.emit({
        runId: run.id,
        stepId: pendingToolCall.stepId,
        type: 'approval.requested',
        schemaVersion: 1,
        payload: {
          toolName: tool.name,
        },
      });

      await this.saveExecutionSnapshot(awaitingApprovalRun, state, 'awaiting_approval');
      throw new ApprovalRequiredError(tool.name);
    }

    state.approvedToolCallIds = removeApprovedToolCallId(state.approvedToolCallIds, pendingToolCall.id);

    const toolContext = this.createToolContext(run, pendingToolCall.stepId, pendingToolCall.id);
    const emitsToolLifecycle = tool.name.startsWith(RESERVED_DELEGATE_PREFIX);
    const toolStartedAt = Date.now();

    if (!emitsToolLifecycle) {
      this.logToolStarted(run, pendingToolCall.stepId, tool, pendingToolCall.input);
      await this.emit({
        runId: run.id,
        stepId: pendingToolCall.stepId,
        type: 'tool.started',
        schemaVersion: 1,
        payload: {
          toolName: tool.name,
        },
      });
    }

    try {
      const output = await runWithTimeout(
        tool.timeoutMs ?? this.defaults.toolTimeoutMs,
        toolContext.signal,
        () => tool.execute(pendingToolCall.input, toolContext),
      );

      if (!emitsToolLifecycle) {
        this.logToolCompleted(
          run,
          pendingToolCall.stepId,
          tool,
          pendingToolCall.input,
          output,
          Date.now() - toolStartedAt,
        );
        await this.emit({
          runId: run.id,
          stepId: pendingToolCall.stepId,
          type: 'tool.completed',
          schemaVersion: 1,
          payload: {
            toolName: tool.name,
            output: tool.summarizeResult ? tool.summarizeResult(output) : output,
          },
        });
      }

      return output;
    } catch (error) {
      if (error instanceof ApprovalRequiredError) {
        throw error;
      }

      const recoveredOutput = recoverToolError(tool, error, pendingToolCall.input);

      if (!emitsToolLifecycle) {
        this.logToolFailed(
          run,
          pendingToolCall.stepId,
          tool,
          pendingToolCall.input,
          error,
          Date.now() - toolStartedAt,
          {
            recoverable: recoveredOutput !== undefined,
            recoveredOutput:
              recoveredOutput === undefined
                ? undefined
                : captureToolOutputForLog(tool, recoveredOutput, this.defaultCaptureMode),
          },
        );
        await this.emit({
          runId: run.id,
          stepId: pendingToolCall.stepId,
          type: 'tool.failed',
          schemaVersion: 1,
          payload: {
            toolName: tool.name,
            error: error instanceof Error ? error.message : String(error),
            recoverable: recoveredOutput !== undefined,
            output:
              recoveredOutput === undefined
                ? undefined
                : tool.summarizeResult
                  ? tool.summarizeResult(recoveredOutput)
                  : recoveredOutput,
          },
        });
      }

      if (recoveredOutput !== undefined) {
        return recoveredOutput;
      }

      if (error instanceof DelegationError) {
        throw error;
      }

      throw new ToolExecutionError(error instanceof Error ? error.message : String(error));
    }
  }

  private async executeChildRun(request: ExecuteChildRunRequest): Promise<RunResult> {
    const childAgent = this.createScopedAgent(request.delegate);
    return childAgent.runWithExistingRun(request.runId, { outputSchema: request.outputSchema });
  }

  private async resumeAwaitingParent(run: AgentRun, state: ExecutionState): Promise<AgentRun> {
    const childRunId = run.currentChildRunId ?? extractWaitingChildRunId(state);
    if (childRunId) {
      const childRun = await this.options.runStore.getRun(childRunId);
      if (childRun && !TERMINAL_RUN_STATUSES.has(childRun.status)) {
        const childAgent = this.createAgentForChildRun(childRun);
        await childAgent.resume(childRun.id);
      }
    }

    const resolution = await this.delegationExecutor.resumeParentRun(run.id);
    return this.applyParentResumeResolution(run, state, resolution);
  }

  private async applyParentResumeResolution(
    run: AgentRun,
    state: ExecutionState,
    resolution: ParentResumeResult,
  ): Promise<AgentRun> {
    if (resolution.kind === 'not_waiting') {
      return resolution.parentRun;
    }

    if (resolution.kind === 'waiting') {
      throw new Error(`Parent run ${run.id} is still waiting: ${resolution.reason}`);
    }

    if (resolution.kind === 'failed') {
      throw new DelegationError(resolution.error, resolution.code);
    }

    const pendingToolCall = state.pendingToolCalls[0];
    if (pendingToolCall) {
      state.messages.push(toolResultMessage(pendingToolCall, resolution.output));
      state.pendingToolCalls.shift();
      state.waitingOnChildRunId = undefined;
      state.stepsUsed += 1;

      await this.emit({
        runId: run.id,
        stepId: pendingToolCall.stepId,
        type: 'step.completed',
        schemaVersion: 1,
        payload: {
          stepId: pendingToolCall.stepId,
          toolName: pendingToolCall.name,
        },
      });

      await this.saveExecutionSnapshot(resolution.parentRun, state, resolution.parentRun.status);
    }

    return resolution.parentRun;
  }

  private createScopedAgent(delegate: NonNullable<AdaptiveAgentOptions['delegates']>[number]): AdaptiveAgent {
    const recursiveDelegates = this.options.delegation?.allowRecursiveDelegation ? this.options.delegates : [];
    const hostTools = this.pickHostTools(delegate.allowedTools);
    const tools = delegate.handlerTools ? [...hostTools, ...delegate.handlerTools] : hostTools;
    return new AdaptiveAgent({
      model: delegate.model ?? this.options.model,
      tools,
      delegates: recursiveDelegates,
      delegation: this.options.delegation,
      runStore: this.options.runStore,
      eventStore: this.options.eventStore,
      snapshotStore: this.options.snapshotStore,
      planStore: this.options.planStore,
      eventSink: this.options.eventSink,
      logger: this.options.logger,
      defaults: { ...this.options.defaults, ...delegate.defaults },
      systemInstructions: delegate.instructions,
    });
  }

  private createAgentForChildRun(childRun: AgentRun): AdaptiveAgent {
    if (!childRun.delegateName) {
      return this;
    }

    const delegate = (this.options.delegates ?? []).find((candidate) => candidate.name === childRun.delegateName);
    if (!delegate) {
      throw new Error(`Missing delegate profile ${childRun.delegateName} for child resume`);
    }

    return this.createScopedAgent(delegate);
  }

  private pickHostTools(toolNames: string[]): ToolDefinition[] {
    const hostTools = new Map(this.options.tools.map((tool) => [tool.name, tool] as const));
    return toolNames.map((toolName) => {
      const tool = hostTools.get(toolName);
      if (!tool) {
        throw new Error(`Unknown host tool ${toolName}`);
      }

      return tool;
    });
  }

  private createToolContext(run: AgentRun, stepId: string, toolCallId: string): ToolContext {
    const controller = new AbortController();
    return {
      runId: run.id,
      rootRunId: run.rootRunId,
      parentRunId: run.parentRunId,
      parentStepId: run.parentStepId,
      delegateName: run.delegateName,
      delegationDepth: run.delegationDepth,
      stepId,
      planId: run.currentPlanId,
      planExecutionId: run.currentPlanExecutionId,
      input: run.input,
      context: run.context,
      idempotencyKey: `${run.id}:${stepId}:${toolCallId}`,
      signal: controller.signal,
      emit: (event) => Promise.resolve(this.emit(event)),
    };
  }

  private createExecutionState(messages: ModelMessage[], outputSchema?: JsonSchema): ExecutionState {
    return {
      messages,
      stepsUsed: 0,
      pendingToolCalls: [],
      approvedToolCallIds: [],
      outputSchema,
    };
  }

  private createInitialExecutionState(run: AgentRun, outputSchema?: JsonSchema): ExecutionState {
    return this.createExecutionState(buildInitialMessages(run, outputSchema, this.options.systemInstructions), outputSchema);
  }

  private async loadExecutionState(run: AgentRun, outputSchema?: JsonSchema): Promise<ExecutionState> {
    const snapshot = await this.options.snapshotStore?.getLatest(run.id);
    const parsed = snapshot ? deserializeExecutionState(snapshot.state) : null;
    return parsed ?? this.createInitialExecutionState(run, outputSchema);
  }

  private async saveExecutionSnapshot(run: AgentRun, state: ExecutionState, status: RunStatus): Promise<void> {
    if (!this.options.snapshotStore) {
      return;
    }

    const latestSnapshot = await this.options.snapshotStore.getLatest(run.id);
    const snapshot = await this.options.snapshotStore.save({
      runId: run.id,
      snapshotSeq: (latestSnapshot?.snapshotSeq ?? 0) + 1,
      status,
      currentStepId: run.currentStepId,
      currentPlanId: run.currentPlanId,
      currentPlanExecutionId: run.currentPlanExecutionId,
      summary: {
        status,
        stepsUsed: state.stepsUsed,
      },
      state: serializeExecutionState(state),
    });

    await this.emit({
      runId: run.id,
      stepId: run.currentStepId,
      type: 'snapshot.created',
      schemaVersion: 1,
      payload: {
        snapshotSeq: snapshot.snapshotSeq,
        status,
      },
    });

    this.logLifecycle('debug', 'snapshot.created', {
      ...runLogBindings(run),
      stepId: run.currentStepId,
      snapshotSeq: snapshot.snapshotSeq,
      status,
      stepsUsed: state.stepsUsed,
    });
  }

  private async generateModelResponse(run: AgentRun, state: ExecutionState): Promise<ModelResponse> {
    const modelRequest = {
      messages: structuredClone(state.messages),
      tools: this.plannerVisibleTools(),
      outputSchema: state.outputSchema,
      metadata: run.metadata,
    };
    const startedAt = Date.now();
    const timeoutContext = createAbortTimeoutContext(this.defaults.modelTimeoutMs);

    this.logLifecycle('debug', 'model.request', {
      ...runLogBindings(run),
      stepId: run.currentStepId,
      ...summarizeModelRequestForLog(modelRequest),
    });

    let response: ModelResponse;
    try {
      response = await this.options.model.generate({
        ...modelRequest,
        signal: timeoutContext.signal,
      });
    } catch (error) {
      const modelError = timeoutContext.didTimeout()
        ? createModelTimeoutError(this.defaults.modelTimeoutMs, error)
        : error;
      this.logLifecycle('error', 'model.failed', {
        ...runLogBindings(run),
        stepId: run.currentStepId,
        durationMs: Date.now() - startedAt,
        error: errorForLog(modelError),
      });
      throw modelError;
    } finally {
      timeoutContext.dispose();
    }

    this.logLifecycle('debug', 'model.response', {
      ...runLogBindings(run),
      stepId: run.currentStepId,
      durationMs: Date.now() - startedAt,
      ...summarizeModelResponseForLog(response),
    });

    if (response.usage) {
      await this.applyUsage(run, response.usage);
    }

    return response;
  }

  private async applyUsage(run: AgentRun, usageDelta: UsageSummary): Promise<AgentRun> {
    const nextUsage = mergeUsage(run.usage, usageDelta);
    const updatedRun = await this.options.runStore.updateRun(
      run.id,
      {
        usage: nextUsage,
      },
      run.version,
    );

    await this.emit({
      runId: run.id,
      stepId: updatedRun.currentStepId,
      type: 'usage.updated',
      schemaVersion: 1,
      payload: {
        usage: nextUsage as unknown as JsonValue,
      },
    });

    this.logLifecycle('debug', 'usage.updated', {
      ...runLogBindings(updatedRun),
      stepId: updatedRun.currentStepId,
      usage: captureValueForLog(nextUsage, { mode: 'full' }),
    });

    return updatedRun;
  }

  private plannerVisibleTools(): Array<Pick<ToolDefinition, 'name' | 'description' | 'inputSchema'>> {
    return Array.from(this.toolRegistry.values(), (tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  private async ensureRunStep(run: AgentRun, stepId: string): Promise<AgentRun> {
    if (run.currentStepId === stepId && run.status === 'running') {
      return run;
    }

    return this.options.runStore.updateRun(
      run.id,
      {
        status: 'running',
        currentStepId: stepId,
      },
      run.version,
    );
  }

  private async completeRun(run: AgentRun, state: ExecutionState, output: JsonValue): Promise<RunResult> {
    const completedRun = await this.options.runStore.updateRun(
      run.id,
      {
        status: 'succeeded',
        result: output,
      },
      run.version,
    );

    await this.saveExecutionSnapshot(completedRun, state, 'succeeded');
    await this.emit({
      runId: completedRun.id,
      stepId: completedRun.currentStepId,
      type: 'run.completed',
      schemaVersion: 1,
      payload: {
        output,
        stepsUsed: state.stepsUsed,
      },
    });

    this.logLifecycle('info', 'run.completed', {
      ...runLogBindings(completedRun),
      stepId: completedRun.currentStepId,
      durationMs: this.runDurationMs(completedRun),
      output: summarizeValueForLog(output),
      stepsUsed: state.stepsUsed,
      usage: captureValueForLog(completedRun.usage, { mode: 'full' }),
    });

    return {
      status: 'success',
      runId: completedRun.id,
      output,
      stepsUsed: state.stepsUsed,
      usage: completedRun.usage,
    };
  }

  private async failRun(
    run: AgentRun,
    state: ExecutionState,
    error: string,
    code: RunFailureCode,
  ): Promise<RunResult> {
    const currentRun = await this.refreshRun(run.id);
    const failedRun = await this.options.runStore.updateRun(
      currentRun.id,
      {
        status: code === 'REPLAN_REQUIRED' ? 'replan_required' : 'failed',
        errorCode: code,
        errorMessage: error,
      },
      currentRun.version,
    );

    await this.saveExecutionSnapshot(failedRun, state, failedRun.status);
    await this.emit({
      runId: failedRun.id,
      stepId: failedRun.currentStepId,
      type: code === 'REPLAN_REQUIRED' ? 'replan.required' : 'run.failed',
      schemaVersion: 1,
      payload: {
        error,
        code,
      },
    });

    this.logLifecycle(code === 'REPLAN_REQUIRED' ? 'warn' : 'error', code === 'REPLAN_REQUIRED' ? 'replan.required' : 'run.failed', {
      ...runLogBindings(failedRun),
      stepId: failedRun.currentStepId,
      durationMs: this.runDurationMs(failedRun),
      error,
      code,
      stepsUsed: state.stepsUsed,
      usage: captureValueForLog(failedRun.usage, { mode: 'full' }),
    });

    return {
      status: 'failure',
      runId: failedRun.id,
      error,
      code,
      stepsUsed: state.stepsUsed,
      usage: failedRun.usage,
    };
  }

  private resultFromStoredRun(run: AgentRun, stepsUsed: number): RunResult {
    if (run.status === 'succeeded') {
      return {
        status: 'success',
        runId: run.id,
        output: run.result ?? null,
        stepsUsed,
        usage: run.usage,
      };
    }

    if (run.status === 'clarification_requested') {
      return {
        status: 'clarification_requested',
        runId: run.id,
        message: run.errorMessage ?? 'Clarification requested',
      };
    }

    return {
      status: 'failure',
      runId: run.id,
      error: run.errorMessage ?? 'Run failed',
      code: (run.errorCode as RunFailureCode | undefined) ?? 'TOOL_ERROR',
      stepsUsed,
      usage: run.usage,
    };
  }

  private async transitionRun(run: AgentRun, status: RunStatus): Promise<AgentRun> {
    if (run.status === status) {
      return run;
    }

    const updatedRun = await this.options.runStore.updateRun(
      run.id,
      {
        status,
      },
      run.version,
    );

    await this.emit({
      runId: run.id,
      stepId: updatedRun.currentStepId,
      type: 'run.status_changed',
      schemaVersion: 1,
      payload: {
        fromStatus: run.status,
        toStatus: status,
      },
    });

    this.logLifecycle('info', 'run.status_changed', {
      ...runLogBindings(updatedRun),
      stepId: updatedRun.currentStepId,
      fromStatus: run.status,
      toStatus: status,
    });

    return updatedRun;
  }

  private planCompatibilityError(steps: PlanStep[]): string | null {
    for (const step of steps) {
      if (step.toolName.startsWith(RESERVED_DELEGATE_PREFIX)) {
        return `Persisted plan step ${step.id} uses reserved tool ${step.toolName}; emit replan.required instead of executing delegate steps`;
      }

      if (!this.toolRegistry.has(step.toolName)) {
        return `Persisted plan step ${step.id} references unavailable tool ${step.toolName}`;
      }
    }

    return null;
  }

  private async failPlanExecution(
    run: AgentRun,
    planExecution: PlanExecution,
    stepsUsed: number,
    error: string,
    code: RunFailureCode,
  ): Promise<RunResult> {
    if (!this.options.planStore) {
      throw new Error('executePlan() requires a configured planStore');
    }

    const currentRun = await this.refreshRun(run.id);
    await this.options.planStore.updateExecution(planExecution.id, {
      status: code === 'REPLAN_REQUIRED' ? 'replan_required' : 'failed',
      replanReason: code === 'REPLAN_REQUIRED' ? error : undefined,
    });
    const failedRun = await this.options.runStore.updateRun(
      currentRun.id,
      {
        status: code === 'REPLAN_REQUIRED' ? 'replan_required' : 'failed',
        errorCode: code,
        errorMessage: error,
      },
    );

    await this.emit({
      runId: failedRun.id,
      planExecutionId: planExecution.id,
      stepId: failedRun.currentStepId,
      type: code === 'REPLAN_REQUIRED' ? 'replan.required' : 'run.failed',
      schemaVersion: 1,
      payload: {
        error,
        code,
        planId: failedRun.currentPlanId,
        planExecutionId: planExecution.id,
      },
    });

    this.logLifecycle(code === 'REPLAN_REQUIRED' ? 'warn' : 'error', code === 'REPLAN_REQUIRED' ? 'replan.required' : 'run.failed', {
      ...runLogBindings(failedRun),
      stepId: failedRun.currentStepId,
      planId: failedRun.currentPlanId,
      planExecutionId: planExecution.id,
      error,
      code,
      stepsUsed,
    });

    return {
      status: 'failure',
      runId: failedRun.id,
      error,
      code,
      stepsUsed,
      usage: failedRun.usage,
    };
  }

  private async acquireLeaseOrThrow(runId: UUID): Promise<void> {
    const acquired = await this.options.runStore.tryAcquireLease({
      runId,
      owner: this.leaseOwner,
      ttlMs: this.defaults.modelTimeoutMs,
      now: new Date(),
    });

    if (!acquired) {
      throw new Error(`Could not acquire lease for run ${runId}`);
    }
  }

  private async releaseLeaseQuietly(runId: UUID): Promise<void> {
    try {
      await this.options.runStore.releaseLease(runId, this.leaseOwner);
    } catch {
      // Release is best effort in this scaffold so resumed/terminal paths remain simple.
    }
  }

  private async refreshRun(runId: UUID): Promise<AgentRun> {
    const run = await this.options.runStore.getRun(runId);
    if (!run) {
      throw new Error(`Run ${runId} does not exist`);
    }

    return run;
  }

  private logToolStarted(
    run: AgentRun,
    stepId: string,
    tool: ToolDefinition,
    input: JsonValue,
    extra: Record<string, unknown> = {},
  ): void {
    this.logLifecycle('info', 'tool.started', {
      ...runLogBindings(run),
      stepId,
      toolName: tool.name,
      timeoutMs: tool.timeoutMs ?? this.defaults.toolTimeoutMs,
      requiresApproval: tool.requiresApproval ?? false,
      input: captureToolInputForLog(tool, input, this.defaultCaptureMode),
      ...extra,
    });
  }

  private logToolCompleted(
    run: AgentRun,
    stepId: string,
    tool: ToolDefinition,
    input: JsonValue,
    output: JsonValue,
    durationMs: number,
    extra: Record<string, unknown> = {},
  ): void {
    this.logLifecycle('info', 'tool.completed', {
      ...runLogBindings(run),
      stepId,
      toolName: tool.name,
      durationMs,
      input: captureToolInputForLog(tool, input, this.defaultCaptureMode),
      output: captureToolOutputForLog(tool, output, this.defaultCaptureMode),
      ...extra,
    });
  }

  private logToolFailed(
    run: AgentRun,
    stepId: string,
    tool: ToolDefinition,
    input: JsonValue,
    error: unknown,
    durationMs: number,
    extra: Record<string, unknown> = {},
  ): void {
    this.logLifecycle('error', 'tool.failed', {
      ...runLogBindings(run),
      stepId,
      toolName: tool.name,
      durationMs,
      input: captureToolInputForLog(tool, input, this.defaultCaptureMode),
      error: errorForLog(error),
      ...extra,
    });
  }

  private runDurationMs(run: Pick<AgentRun, 'createdAt'>): number {
    return Date.now() - new Date(run.createdAt).getTime();
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

  private async emit(event: Omit<AgentEvent, 'id' | 'seq' | 'createdAt'>): Promise<void> {
    await this.eventEmitter.emit(event);
  }
}

class ApprovalRequiredError extends Error {
  constructor(readonly toolName: string) {
    super(`Approval required for ${toolName}`);
    this.name = 'ApprovalRequiredError';
  }
}

class ToolExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}

class ModelTimeoutError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TimeoutError';
  }
}

function createCompositeEventSink(
  eventStore: AdaptiveAgentOptions['eventStore'],
  downstreamSink: AdaptiveAgentOptions['eventSink'],
): EventSink {
  return {
    emit: async (event) => {
      if (eventStore) {
        await eventStore.append(event);
      }

      if (downstreamSink && downstreamSink !== (eventStore as unknown as EventSink | undefined)) {
        await downstreamSink.emit(event);
      }
    },
  };
}

function resolveDefaultModelTimeoutMs(provider: string): number {
  if (provider === 'ollama') {
    return DEFAULT_AGENT_DEFAULTS.modelTimeoutMs * OLLAMA_MODEL_TIMEOUT_MULTIPLIER;
  }

  return DEFAULT_AGENT_DEFAULTS.modelTimeoutMs;
}

function buildAgentSystemMessage(systemInstructions?: string): ModelMessage {
  const baseSystemPrompt =
    'You are AdaptiveAgent. Use the available tools when needed. Keep execution linear. When the task is complete, return the final answer directly. If a tool has already completed the requested save or write action, do not call more tools just to verify or restate success unless the user explicitly asked for verification. When reporting saved artifacts, preserve the exact path returned by the tool.';

  const systemContent = systemInstructions
    ? `${baseSystemPrompt}\n\n## Skill Instructions\n\n${systemInstructions}`
    : baseSystemPrompt;

  return {
    role: 'system',
    content: systemContent,
  };
}

function buildInitialMessages(run: AgentRun, outputSchema?: JsonSchema, systemInstructions?: string): ModelMessage[] {
  const requestPayload: JsonObject = {
    goal: run.goal,
    input: run.input ?? null,
    context: run.context ?? {},
  };

  if (outputSchema) {
    requestPayload.outputSchema = outputSchema as unknown as JsonValue;
  }

  return [
    buildAgentSystemMessage(systemInstructions),
    {
      role: 'user',
      content: JSON.stringify(requestPayload, null, 2),
    },
  ];
}

function buildInitialChatMessages(
  messages: ChatMessage[],
  context?: Record<string, JsonValue>,
  systemInstructions?: string,
): ModelMessage[] {
  if (messages.length === 0) {
    throw new Error('chat() requires at least one message');
  }

  const contextMessage =
    context && Object.keys(context).length > 0
      ? [
          {
            role: 'system' as const,
            content: `## Additional Context\n\n${JSON.stringify(context, null, 2)}`,
          },
        ]
      : [];

  return [
    buildAgentSystemMessage(systemInstructions),
    ...contextMessage,
    ...messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  ];
}

function summarizeChatGoal(messages: ChatMessage[]): string {
  if (messages.length === 0) {
    return 'Continue the conversation.';
  }

  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === 'user' && message.content.trim().length > 0);
  const basis = latestUserMessage?.content.trim() || messages[messages.length - 1]?.content.trim() || '';
  if (!basis) {
    return 'Continue the conversation.';
  }

  return basis.length > CHAT_GOAL_MAX_LENGTH ? `${basis.slice(0, CHAT_GOAL_MAX_LENGTH - 3)}...` : basis;
}

function serializeExecutionState(state: ExecutionState): JsonObject {
  const serialized: JsonObject = {
    messages: state.messages as unknown as JsonValue,
    stepsUsed: state.stepsUsed,
  };

  if (state.outputSchema) {
    serialized.outputSchema = state.outputSchema as unknown as JsonValue;
  }

  if (state.pendingToolCalls.length > 0) {
    serialized.pendingToolCalls = state.pendingToolCalls.map((pendingToolCall) =>
      serializePendingToolCall(pendingToolCall),
    );
    serialized.pendingToolCall = serializePendingToolCall(state.pendingToolCalls[0]);
  }

  if (state.approvedToolCallIds.length > 0) {
    serialized.approvedToolCallIds = state.approvedToolCallIds;
  }

  if (state.waitingOnChildRunId) {
    serialized.waitingOnChildRunId = state.waitingOnChildRunId;
  }

  return serialized;
}

function deserializeExecutionState(value: JsonValue): ExecutionState | null {
  if (!isJsonObject(value) || !Array.isArray(value.messages) || typeof value.stepsUsed !== 'number') {
    return null;
  }

  const pendingToolCalls = deserializePendingToolCalls(value.pendingToolCalls, value.pendingToolCall);
  return {
    messages: value.messages.reduce<ModelMessage[]>((messages, entry) => {
      if (isModelMessage(entry)) {
        messages.push(entry);
      }

      return messages;
    }, []),
    stepsUsed: value.stepsUsed,
    outputSchema: isJsonObject(value.outputSchema) ? (value.outputSchema as unknown as JsonSchema) : undefined,
    pendingToolCalls,
    approvedToolCallIds: deserializeApprovedToolCallIds(value.approvedToolCallIds),
    waitingOnChildRunId: typeof value.waitingOnChildRunId === 'string' ? value.waitingOnChildRunId : undefined,
  };
}

function serializePendingToolCall(pendingToolCall: PendingToolCallState): JsonObject {
  return {
    id: pendingToolCall.id,
    name: pendingToolCall.name,
    input: pendingToolCall.input,
    stepId: pendingToolCall.stepId,
    needsStepStarted: pendingToolCall.needsStepStarted,
  };
}

function deserializePendingToolCalls(
  value: JsonValue | undefined,
  legacyValue: JsonValue | undefined,
): PendingToolCallState[] {
  if (Array.isArray(value)) {
    return value.reduce<PendingToolCallState[]>((pendingToolCalls, entry) => {
      const pendingToolCall = deserializePendingToolCall(entry);
      if (pendingToolCall) {
        pendingToolCalls.push(pendingToolCall);
      }

      return pendingToolCalls;
    }, []);
  }

  const pendingToolCall = deserializePendingToolCall(legacyValue);
  return pendingToolCall ? [pendingToolCall] : [];
}

function deserializePendingToolCall(value: JsonValue | undefined): PendingToolCallState | null {
  if (!isJsonObject(value)) {
    return null;
  }

  if (typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.stepId !== 'string') {
    return null;
  }

  return {
    id: value.id,
    name: value.name,
    input: value.input ?? null,
    stepId: value.stepId,
    needsStepStarted: value.needsStepStarted === true,
  };
}

function deserializeApprovedToolCallIds(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === 'string');
}

function addApprovedToolCallId(approvedToolCallIds: string[], toolCallId: string): string[] {
  if (approvedToolCallIds.includes(toolCallId)) {
    return approvedToolCallIds;
  }

  return [...approvedToolCallIds, toolCallId];
}

function removeApprovedToolCallId(approvedToolCallIds: string[], toolCallId: string): string[] {
  return approvedToolCallIds.filter((approvedToolCallId) => approvedToolCallId !== toolCallId);
}

function isModelMessage(value: unknown): value is ModelMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.role === 'string' &&
    typeof candidate.content === 'string' &&
    ['system', 'user', 'assistant', 'tool'].includes(candidate.role) &&
    (candidate.toolCalls === undefined || isModelToolCallArray(candidate.toolCalls))
  );
}

function assistantMessageFromResponse(response: ModelResponse): ModelMessage | null {
  const content = response.text ?? response.summary ?? '';
  if (!content && (!response.toolCalls || response.toolCalls.length === 0)) {
    return null;
  }

  return {
    role: 'assistant',
    content,
    toolCalls: response.toolCalls,
  };
}

function isModelToolCallArray(value: unknown): value is ModelMessage['toolCalls'] {
  return Array.isArray(value) && value.every(isModelToolCall);
}

function isModelToolCall(value: unknown): value is ModelMessage['toolCalls'][number] {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string' && typeof candidate.name === 'string' && 'input' in candidate;
}

function createPendingToolCalls(toolCalls: ModelResponse['toolCalls'], nextStepNumber: number): PendingToolCallState[] {
  if (!toolCalls) {
    return [];
  }

  return toolCalls.map((toolCall, index) => ({
    id: toolCall.id,
    name: toolCall.name,
    input: toolCall.input,
    stepId: `step-${nextStepNumber + index}`,
    needsStepStarted: index > 0,
  }));
}

function toolResultMessage(pendingToolCall: PendingToolCallState, output: JsonValue): ModelMessage {
  return {
    role: 'tool',
    name: pendingToolCall.name,
    toolCallId: pendingToolCall.id,
    content: JSON.stringify(output),
  };
}

function mergeUsage(current: UsageSummary, delta: UsageSummary): UsageSummary {
  const promptTokens = current.promptTokens + delta.promptTokens;
  const completionTokens = current.completionTokens + delta.completionTokens;
  const reasoningTokens = (current.reasoningTokens ?? 0) + (delta.reasoningTokens ?? 0);
  const currentTotalTokens =
    current.totalTokens ??
    current.promptTokens + current.completionTokens + (current.reasoningTokens ?? 0);
  const deltaTotalTokens =
    delta.totalTokens ?? delta.promptTokens + delta.completionTokens + (delta.reasoningTokens ?? 0);
  const totalTokens = currentTotalTokens + deltaTotalTokens;

  return {
    promptTokens,
    completionTokens,
    reasoningTokens: reasoningTokens || undefined,
    totalTokens,
    estimatedCostUSD: current.estimatedCostUSD + delta.estimatedCostUSD,
    provider: delta.provider ?? current.provider,
    model: delta.model ?? current.model,
  };
}

function mergeMetadata(
  base: Record<string, JsonValue> | undefined,
  override: Record<string, JsonValue> | undefined,
): Record<string, JsonValue> | undefined {
  if (!base && !override) {
    return undefined;
  }

  return {
    ...(base ?? {}),
    ...(override ?? {}),
  };
}

function interruptResult(runId: UUID, stepsUsed: number, usage: UsageSummary, error: string): RunResult {
  return {
    status: 'failure',
    runId,
    error,
    code: 'INTERRUPTED',
    stepsUsed,
    usage,
  };
}

function extractWaitingChildRunId(state: ExecutionState): UUID | undefined {
  return state.waitingOnChildRunId;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function planStepPreconditionsMet(
  step: PlanStep,
  input: JsonValue | undefined,
  context: Record<string, JsonValue> | undefined,
  resolvedStepOutputs: Map<string, JsonValue>,
): boolean {
  return (step.preconditions ?? []).every((condition) =>
    evaluatePlanCondition(condition, input, context, resolvedStepOutputs),
  );
}

function evaluatePlanCondition(
  condition: PlanCondition,
  input: JsonValue | undefined,
  context: Record<string, JsonValue> | undefined,
  resolvedStepOutputs: Map<string, JsonValue>,
): boolean {
  const left = resolvePlanTemplateRaw(condition.left, input, context, resolvedStepOutputs);
  const right = condition.right
    ? resolvePlanTemplateRaw(condition.right, input, context, resolvedStepOutputs)
    : undefined;

  switch (condition.kind) {
    case 'exists':
      return left !== undefined && left !== null;
    case 'equals':
      return stableJsonStringify(left) === stableJsonStringify(right);
    case 'not_equals':
      return stableJsonStringify(left) !== stableJsonStringify(right);
    default:
      return false;
  }
}

function resolvePlanTemplate(
  template: unknown,
  input: JsonValue | undefined,
  context: Record<string, JsonValue> | undefined,
  resolvedStepOutputs: Map<string, JsonValue>,
): JsonValue {
  const resolved = resolvePlanTemplateRaw(template, input, context, resolvedStepOutputs);
  return resolved === undefined ? null : resolved;
}

function resolvePlanTemplateRaw(
  template: unknown,
  input: JsonValue | undefined,
  context: Record<string, JsonValue> | undefined,
  resolvedStepOutputs: Map<string, JsonValue>,
): JsonValue | undefined {
  if (isTemplateReference(template)) {
    return resolveTemplateReference(template.$ref, input, context, resolvedStepOutputs);
  }

  if (Array.isArray(template)) {
    return template.map((entry) => resolvePlanTemplate(entry, input, context, resolvedStepOutputs));
  }

  if (isJsonObject(template as JsonValue | undefined)) {
    const resolvedObject: JsonObject = {};
    for (const [key, value] of Object.entries(template)) {
      resolvedObject[key] = resolvePlanTemplate(value, input, context, resolvedStepOutputs);
    }

    return resolvedObject;
  }

  return isJsonValue(template) ? template : null;
}

function isTemplateReference(value: unknown): value is { $ref: string } {
  return isJsonObject(value as JsonValue | undefined) && typeof (value as { $ref?: unknown }).$ref === 'string';
}

function resolveTemplateReference(
  ref: string,
  input: JsonValue | undefined,
  context: Record<string, JsonValue> | undefined,
  resolvedStepOutputs: Map<string, JsonValue>,
): JsonValue | undefined {
  if (ref === '$input') {
    return input;
  }

  if (ref.startsWith('$input.')) {
    return getJsonPathValue(input, ref.slice('$input.'.length).split('.'));
  }

  if (ref === '$context') {
    return (context ?? {}) as JsonObject;
  }

  if (ref.startsWith('$context.')) {
    return getJsonPathValue((context ?? {}) as JsonObject, ref.slice('$context.'.length).split('.'));
  }

  if (ref.startsWith('$steps.')) {
    const [binding, ...path] = ref.slice('$steps.'.length).split('.');
    const stepOutput = resolvedStepOutputs.get(binding);
    return path.length === 0 ? stepOutput : getJsonPathValue(stepOutput, path);
  }

  return undefined;
}

function getJsonPathValue(value: JsonValue | undefined, path: string[]): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const segment of path) {
    if (!segment) {
      continue;
    }

    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) {
        return undefined;
      }

      current = current[index];
      continue;
    }

    if (!isJsonObject(current)) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) {
    return true;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry));
  }

  if (typeof value !== 'object') {
    return false;
  }

  return Object.values(value as Record<string, unknown>).every((entry) => isJsonValue(entry));
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function recoverToolError<O extends JsonValue>(
  tool: ToolDefinition<JsonValue, O>,
  error: unknown,
  input: JsonValue,
): O | undefined {
  return tool.recoverError?.(error, input);
}

function createAbortTimeoutContext(timeoutMs: number): {
  signal: AbortSignal | undefined;
  didTimeout: () => boolean;
  dispose: () => void;
} {
  if (!timeoutMs || timeoutMs <= 0) {
    return {
      signal: undefined,
      didTimeout: () => false,
      dispose: () => undefined,
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort(createModelTimeoutError(timeoutMs));
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => clearTimeout(timeoutId),
  };
}

function createModelTimeoutError(timeoutMs: number, cause?: unknown): ModelTimeoutError {
  return new ModelTimeoutError(`Model timed out after ${timeoutMs}ms`, cause === undefined ? undefined : { cause });
}

async function runWithTimeout<T>(timeoutMs: number, _signal: AbortSignal, task: () => Promise<T>): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) {
    return task();
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task(),
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new ToolExecutionError(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
