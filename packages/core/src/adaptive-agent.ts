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
import { RunRecoveryAnalyzer } from './run-recovery-analyzer.js';
import { resolveResearchPolicy, resolveToolBudgets, type ResolvedResearchPolicy } from './tool-budget-policy.js';
import type {
  AdaptiveAgentOptions,
  AgentEvent,
  AgentRun,
  CaptureMode,
  ChatMessage,
  ChatRequest,
  ChatResult,
  ContinueRunOptions,
  ContinueRunResult,
  ContinuationStrategy,
  ExecutePlanRequest,
  EventSink,
  FailureKind,
  ImageInput,
  JsonObject,
  JsonSchema,
  JsonValue,
  ModelContentPart,
  ModelMessage,
  ModelMessageContent,
  ModelToolCall,
  ModelResponse,
  PlanCondition,
  PlanExecution,
  PlanRequest,
  PlanStep,
  RunRecoveryOptions,
  RuntimeStores,
  RunFailureCode,
  RunRequest,
  RunResult,
  RunSnapshot,
  RunStatus,
  ToolBudget,
  ToolContext,
  ToolDefinition,
  UsageSummary,
  UUID,
} from './types.js';

interface PendingToolCallState {
  id: string;
  name: string;
  input: JsonValue;
  assistantContent?: string;
  stepId: string;
  needsStepStarted: boolean;
}

interface PendingToolCallExecutionResult {
  output: JsonValue;
  completion?: ToolExecutionCompletionPersistence;
}

interface ToolExecutionCompletionPersistence {
  idempotencyKey: string;
  output: JsonValue;
  event?: Omit<AgentEvent, 'id' | 'seq' | 'createdAt'>;
}

interface ExecutionState {
  messages: ModelMessage[];
  stepsUsed: number;
  outputSchema?: JsonSchema;
  pendingToolCalls: PendingToolCallState[];
  approvedToolCallIds: string[];
  waitingOnChildRunId?: UUID;
  toolBudgetUsage: Record<string, ToolBudgetUsage>;
  pendingRuntimeMessages: ModelMessage[];
}

interface ToolBudgetUsage {
  calls: number;
  consecutiveCalls: number;
  checkpointEmitted: boolean;
}

interface RunContinuationOptions {
  outputSchema?: JsonSchema;
  retryFailedChild?: boolean;
  initialState?: ExecutionState;
}

type FailedRunRetryability =
  | { retryable: true; failureKind: FailureKind }
  | { retryable: false; reason: string; failureKind: FailureKind };

type LinkedDelegateChildRun =
  | { kind: 'linked'; childRun: AgentRun }
  | { kind: 'missing'; reason: string }
  | { kind: 'invalid'; reason: string; childRun?: AgentRun };

const DEFAULT_AGENT_DEFAULTS = {
  maxSteps: 30,
  toolTimeoutMs: 60_000,
  modelTimeoutMs: 90_000,
  maxRetriesPerStep: 0,
} as const;

const OLLAMA_MODEL_TIMEOUT_MULTIPLIER = 4;
const EXECUTION_STATE_SCHEMA_VERSION = 1;
const DEFAULT_TOOL_TERMINAL_RETRY_LIMIT = 1;

const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  'succeeded',
  'failed',
  'clarification_requested',
  'replan_required',
  'cancelled',
]);

const RESERVED_DELEGATE_PREFIX = 'delegate.';
const CHAT_GOAL_MAX_LENGTH = 120;

const STEER_METADATA_KEY = 'pendingSteerMessages';
const STEER_UPDATE_MAX_ATTEMPTS = 5;
const STEER_TOOL_HINTS = [
  {
    toolName: 'write_file',
    patterns: [
      /\b(?:write|save|store|export|persist)\b[\s\S]{0,120}\b(?:to|into|as)\s+[`"']?[^`"'\s]+\.(?:html?|md|markdown|txt|jsonl?|csv|tsv|xml|ya?ml)\b/i,
      /\b(?:save|store|export|persist)\b[\s\S]{0,80}\b(?:file|document|artifact|output)\b/i,
    ],
  },
  {
    toolName: 'read_file',
    patterns: [
      /\b(?:read|open|load|inspect|view)\b[\s\S]{0,80}\b(?:file|document)\b/i,
    ],
  },
  {
    toolName: 'list_directory',
    patterns: [
      /\b(?:list|show|scan|inspect)\b[\s\S]{0,80}\b(?:directory|folder)\b/i,
    ],
  },
  {
    toolName: 'shell_exec',
    patterns: [
      /\b(?:run|execute|launch)\b[\s\S]{0,80}\b(?:command|script|shell)\b/i,
    ],
  },
] as const;

export interface SteerInput {
  message: string;
  role?: 'user' | 'system';
  metadata?: JsonObject;
}

interface PendingSteerMessage {
  role: 'user' | 'system';
  content: string;
  enqueuedAt: string;
  metadata?: JsonObject;
}

export class AdaptiveAgent {
  private readonly toolRegistry = new Map<string, ToolDefinition>();
  private readonly plannerTools: Array<Pick<ToolDefinition, 'name' | 'description' | 'inputSchema'>>;
  private readonly resolvedToolBudgets?: Record<string, ToolBudget>;
  private readonly resolvedResearchPolicy?: ResolvedResearchPolicy;
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
  private readonly recoveryAnalyzer: RunRecoveryAnalyzer;
  private readonly logger?: Logger;

  constructor(private readonly options: AdaptiveAgentOptions) {
    this.defaults = {
      maxSteps: options.defaults?.maxSteps ?? DEFAULT_AGENT_DEFAULTS.maxSteps,
      toolTimeoutMs: options.defaults?.toolTimeoutMs ?? DEFAULT_AGENT_DEFAULTS.toolTimeoutMs,
      modelTimeoutMs: options.defaults?.modelTimeoutMs ?? resolveDefaultModelTimeoutMs(options.model.provider),
      maxRetriesPerStep: options.defaults?.maxRetriesPerStep ?? DEFAULT_AGENT_DEFAULTS.maxRetriesPerStep,
    };
    this.defaultCaptureMode = options.defaults?.capture ?? 'summary';
    this.resolvedResearchPolicy = resolveResearchPolicy(options.defaults?.researchPolicy);
    this.resolvedToolBudgets = resolveToolBudgets(options.defaults);
    this.logger = options.logger?.child({
      component: 'adaptive-agent',
      provider: options.model.provider,
      model: options.model.model,
    });
    this.eventEmitter = createCompositeEventSink(options.eventStore, options.eventSink);
    this.recoveryAnalyzer = new RunRecoveryAnalyzer({
      recovery: options.recovery,
      runStore: options.runStore,
      eventStore: options.eventStore,
      snapshotStore: options.snapshotStore,
      planStore: options.planStore,
      continuationStore: options.continuationStore,
      toolExecutionStore: options.toolExecutionStore,
      defaultProvider: options.model.provider,
      defaultModel: options.model.model,
    });
    this.delegationExecutor = new DelegationExecutor({
      model: options.model,
      tools: options.tools,
      delegates: options.delegates,
      delegation: options.delegation,
      defaults: options.defaults,
      runStore: options.runStore,
      eventSink: this.eventEmitter,
      downstreamEventSink: options.eventSink,
      logger: this.logger,
      snapshotStore: options.snapshotStore,
      toolExecutionStore: options.toolExecutionStore,
      transactionStore: options.transactionStore,
      executeChildRun: (request) => this.executeChildRun(request),
    });

    for (const tool of this.delegationExecutor.getTools()) {
      if (this.toolRegistry.has(tool.name)) {
        throw new Error(`Duplicate tool name ${tool.name}`);
      }

      this.toolRegistry.set(tool.name, tool);
    }

    this.plannerTools = Array.from(this.toolRegistry.values(), (tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));

    this.logLifecycle('debug', 'agent.initialized', {
      toolNames: Array.from(this.toolRegistry.keys()),
      delegateNames: (options.delegates ?? []).map((delegate) => delegate.name),
      defaults: this.defaults,
      toolBudgets: this.resolvedToolBudgets,
      researchPolicy: this.resolvedResearchPolicy,
    });
  }

  async run(request: RunRequest): Promise<RunResult> {
    const { run: createdRun, state } = await this.createRunWithInitialSnapshot({
      goal: request.goal,
      input: request.input,
      context: request.context,
      metadata: request.metadata,
      status: 'queued',
    }, (run) => this.createInitialExecutionState(run, request.outputSchema, request.images));

    this.logLifecycle('info', 'run.created', {
      ...runLogBindings(createdRun),
      goal: summarizeValueForLog(request.goal),
      input: captureValueForLog(request.input, { mode: this.defaultCaptureMode }),
      images: summarizeImagesForLog(request.images),
      context: captureValueForLog(request.context, { mode: this.defaultCaptureMode }),
      metadata: captureValueForLog(request.metadata, { mode: 'summary' }),
      outputSchema: request.outputSchema ? summarizeValueForLog(request.outputSchema) : undefined,
    });

    return this.runWithExistingRun(createdRun.id, { outputSchema: request.outputSchema, initialState: state });
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const initialMessages = buildInitialChatMessages(
      request.messages,
      request.context,
      this.options.systemInstructions,
      this.buildRuntimeToolManifestMessage(),
    );
    const goal = summarizeChatGoal(request.messages);
    const { run: createdRun, state } = await this.createRunWithInitialSnapshot({
      goal,
      context: request.context,
      metadata: request.metadata,
      status: 'queued',
    }, () => this.createExecutionState(initialMessages, request.outputSchema));

    this.logLifecycle('info', 'run.created', {
      ...runLogBindings(createdRun),
      goal: summarizeValueForLog(goal),
      context: captureValueForLog(request.context, { mode: this.defaultCaptureMode }),
      metadata: captureValueForLog(request.metadata, { mode: 'summary' }),
      outputSchema: request.outputSchema ? summarizeValueForLog(request.outputSchema) : undefined,
      chat: true,
      messageCount: request.messages.length,
      imageCount: countChatImages(request.messages),
    });

    return this.runWithExistingRun(createdRun.id, { outputSchema: request.outputSchema, initialState: state });
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
      modelProvider: this.options.model.provider,
      modelName: this.options.model.model,
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
          const approvalInput = resolvePlanTemplate(step.inputTemplate, request.input, request.context, resolvedStepOutputs);
          const eventInput = captureToolInputForLog(tool, approvalInput, this.defaultCaptureMode);

          this.logLifecycle('warn', 'approval.requested', {
            ...runLogBindings(currentRun),
            planExecutionId: currentExecution.id,
            stepId: step.id,
            toolName: tool.name,
            input: eventInput,
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
              ...(eventInput === undefined ? {} : { input: eventInput }),
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
        const eventInput = captureToolInputForLog(tool, input, this.defaultCaptureMode);
        const toolCallId = `plan:${currentExecution.id}:${step.id}`;
        const toolContext = this.createToolContext(currentRun, step.id, toolCallId);
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
          toolCallId,
          type: 'tool.started',
          schemaVersion: 1,
          payload: {
            toolName: tool.name,
            planId: plan.id,
            planExecutionId: currentExecution.id,
            ...(eventInput === undefined ? {} : { input: eventInput }),
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
          const recoveredEventOutput =
            recoveredOutput === undefined
              ? undefined
              : tool.summarizeResult
                ? tool.summarizeResult(recoveredOutput)
                : recoveredOutput;
          await this.emit({
            runId: currentRun.id,
            planExecutionId: currentExecution.id,
            stepId: step.id,
            toolCallId,
            type: 'tool.failed',
            schemaVersion: 1,
            payload: {
              toolName: tool.name,
              ...(eventInput === undefined ? {} : { input: eventInput }),
              error: message,
              recoverable: recoveredOutput !== undefined,
              ...(recoveredEventOutput === undefined ? {} : { output: recoveredEventOutput }),
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
            toolCallId,
            type: 'tool.completed',
            schemaVersion: 1,
            payload: {
              toolName: tool.name,
              ...(eventInput === undefined ? {} : { input: eventInput }),
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

  async steer(runId: UUID, input: SteerInput | string): Promise<void> {
    const normalized: SteerInput = typeof input === 'string' ? { message: input } : input;
    if (!normalized.message || typeof normalized.message !== 'string' || normalized.message.trim() === '') {
      throw new Error('steer() requires a non-empty message');
    }

    const role = normalized.role ?? 'user';
    if (role !== 'user' && role !== 'system') {
      throw new Error(`steer() role must be 'user' or 'system'`);
    }

    const run = await this.options.runStore.getRun(runId);
    if (!run) {
      throw new Error(`Run ${runId} does not exist`);
    }

    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      throw new Error(`Run ${runId} is ${run.status}; steer() requires an active run`);
    }

    const steerRouting = await this.resolveSteerRouting(run, normalized.message);
    const targetRun = steerRouting.targetRun;
    const metadata = mergeSteerMetadata(normalized.metadata, steerRouting.metadata);
    const pendingEntry: PendingSteerMessage = {
      role,
      content: normalized.message,
      enqueuedAt: new Date().toISOString(),
      ...(metadata ? { metadata } : {}),
    };

    const updatedRun = await this.appendPendingSteerMessage(targetRun, pendingEntry);

    this.logLifecycle('info', 'run.steered', {
      ...runLogBindings(updatedRun),
      stepId: updatedRun.currentStepId,
      role,
      messageSummary: summarizeValueForLog(normalized.message),
      routedFromRunId: updatedRun.id === run.id ? undefined : run.id,
      missingTools: steerRouting.missingTools.length > 0 ? steerRouting.missingTools : undefined,
    });

    const eventPayload: JsonObject = {
      role,
      message: normalized.message,
      enqueuedAt: pendingEntry.enqueuedAt,
    };
    if (metadata) {
      eventPayload.metadata = metadata;
    }
    if (updatedRun.id !== run.id) {
      eventPayload.originalRunId = run.id;
      eventPayload.routing = {
        kind: 'parent_deferred',
        missingTools: steerRouting.missingTools,
      };
    }

    await this.emit({
      runId: updatedRun.id,
      stepId: updatedRun.currentStepId,
      type: 'run.steered',
      schemaVersion: 1,
      payload: eventPayload,
    });
  }

  private async resolveSteerRouting(
    run: AgentRun,
    message: string,
  ): Promise<{ targetRun: AgentRun; metadata?: JsonObject; missingTools: string[] }> {
    if (!run.parentRunId || !run.delegateName) {
      return { targetRun: run, missingTools: [] };
    }

    const availableTools = this.resolveAvailableToolNamesForRun(run);
    if (!availableTools) {
      return { targetRun: run, missingTools: [] };
    }

    const missingTools = inferSteerRequiredTools(message).filter((toolName) => !availableTools.has(toolName));
    if (missingTools.length === 0) {
      return { targetRun: run, missingTools: [] };
    }

    const parentRun = await this.options.runStore.getRun(run.parentRunId);
    if (!parentRun || TERMINAL_RUN_STATUSES.has(parentRun.status)) {
      return { targetRun: run, missingTools: [] };
    }

    return {
      targetRun: parentRun,
      missingTools,
      metadata: {
        steerRouting: {
          kind: 'parent_deferred',
          originalRunId: run.id,
          originalDelegateName: run.delegateName,
          missingTools,
        },
      },
    };
  }

  private async appendPendingSteerMessage(run: AgentRun, message: PendingSteerMessage): Promise<AgentRun> {
    let attempt = 0;
    let currentRun = run;
    let lastError: unknown;
    while (attempt < STEER_UPDATE_MAX_ATTEMPTS) {
      const existing = readPendingSteerMessagesFromMetadata(currentRun.metadata);
      const nextMessages = [...existing, message];
      const nextMetadata: Record<string, JsonValue> = {
        ...(currentRun.metadata ?? {}),
        [STEER_METADATA_KEY]: nextMessages as unknown as JsonValue,
      };
      try {
        return await this.options.runStore.updateRun(
          currentRun.id,
          { metadata: nextMetadata } as Partial<AgentRun>,
          currentRun.version,
        );
      } catch (error) {
        lastError = error;
        attempt += 1;
        if (attempt >= STEER_UPDATE_MAX_ATTEMPTS) {
          break;
        }
        currentRun = await this.refreshRun(currentRun.id);
      }
    }
    throw new Error(
      `Failed to enqueue steer message for run ${run.id} after ${STEER_UPDATE_MAX_ATTEMPTS} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  private async drainPendingSteerMessages(run: AgentRun, state: ExecutionState): Promise<AgentRun> {
    const initial = readPendingSteerMessagesFromMetadata(run.metadata);
    if (initial.length === 0) {
      return run;
    }

    const drained: PendingSteerMessage[] = [...initial];
    for (const message of initial) {
      state.messages.push({
        role: message.role,
        content: message.content,
      });
    }

    let attempt = 0;
    let currentRun = run;
    let lastError: unknown;
    while (attempt < STEER_UPDATE_MAX_ATTEMPTS) {
      const nextMetadata: Record<string, JsonValue> = { ...(currentRun.metadata ?? {}) };
      delete nextMetadata[STEER_METADATA_KEY];
      try {
        currentRun = await this.options.runStore.updateRun(
          currentRun.id,
          { metadata: nextMetadata } as Partial<AgentRun>,
          currentRun.version,
        );
        break;
      } catch (error) {
        lastError = error;
        attempt += 1;
        if (attempt >= STEER_UPDATE_MAX_ATTEMPTS) {
          throw new Error(
            `Failed to clear steer queue for run ${run.id} after ${STEER_UPDATE_MAX_ATTEMPTS} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
          );
        }
        currentRun = await this.refreshRun(currentRun.id);
        const refreshed = readPendingSteerMessagesFromMetadata(currentRun.metadata);
        if (refreshed.length > drained.length) {
          for (const message of refreshed.slice(drained.length)) {
            state.messages.push({
              role: message.role,
              content: message.content,
            });
            drained.push(message);
          }
        }
      }
    }

    this.logLifecycle('debug', 'run.steer_drained', {
      ...runLogBindings(currentRun),
      stepId: currentRun.currentStepId,
      drainedCount: drained.length,
    });

    return currentRun;
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
        ...(pendingToolCall.assistantContent === undefined ? {} : { assistantContent: pendingToolCall.assistantContent }),
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

  async resolveClarification(runId: UUID, message: string): Promise<RunResult> {
    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      throw new Error('Clarification message must not be empty');
    }

    const run = await this.options.runStore.getRun(runId);
    if (!run) {
      throw new Error(`Run ${runId} does not exist`);
    }

    if (run.status !== 'clarification_requested') {
      throw new Error(`Run ${runId} is not awaiting clarification`);
    }

    this.logLifecycle('info', 'run.clarification_resolved', {
      ...runLogBindings(run),
      stepId: run.currentStepId,
      clarification: summarizeValueForLog(trimmedMessage),
    });

    const state = await this.loadExecutionState(run);
    state.messages.push({
      role: 'user',
      content: trimmedMessage,
    });

    const resumedRun = await this.transitionRun(run, 'running');
    await this.emit({
      runId,
      stepId: resumedRun.currentStepId,
      type: 'run.resumed',
      schemaVersion: 1,
      payload: {
        status: 'running',
        clarification: trimmedMessage,
      },
    });
    await this.saveExecutionSnapshot(resumedRun, state, resumedRun.status);

    return this.runWithExistingRun(runId, { outputSchema: state.outputSchema });
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

    await this.acquireLeaseOrThrow(run.id);

    try {
      return await this.continueRunFromState(await this.refreshRun(run.id), state, { retryFailedChild: true });
    } finally {
      await this.releaseLeaseQuietly(run.id);
    }
  }

  async retry(runId: UUID): Promise<RunResult> {
    const run = await this.options.runStore.getRun(runId);
    if (!run) {
      throw new Error(`Run ${runId} does not exist`);
    }

    this.logLifecycle('info', 'run.retry_requested', {
      ...runLogBindings(run),
      status: run.status,
      stepId: run.currentStepId,
      errorCode: run.errorCode,
      errorMessage: run.errorMessage,
    });

    const state = await this.loadExecutionState(run);
    if (run.status !== 'failed') {
      throw new Error(`Run ${runId} is ${run.status}; only failed runs can be retried`);
    }

    const retryability = await this.checkFailedRunRetryability(run, state);
    if (!retryability.retryable) {
      throw new Error(retryability.reason);
    }

    await this.acquireLeaseOrThrow(run.id);

    try {
      const currentRun = await this.refreshRun(run.id);
      if (currentRun.status !== 'failed') {
        throw new Error(`Run ${runId} changed to ${currentRun.status}; retry no longer applies`);
      }

      const retryAttempts = readRetryAttempts(currentRun.metadata) + 1;
      const retryingRun = await this.options.runStore.updateRun(
        currentRun.id,
        {
          status: 'running',
          errorCode: undefined,
          errorMessage: undefined,
          result: undefined,
          completedAt: null,
          metadata: {
            ...(currentRun.metadata ?? {}),
            retryAttempts,
            lastRetryFailureKind: retryability.failureKind,
          },
        } as Partial<AgentRun>,
        currentRun.version,
      );

      this.logLifecycle('info', 'run.retry_started', {
        ...runLogBindings(retryingRun),
        stepId: retryingRun.currentStepId,
        failureKind: retryability.failureKind,
        retryAttempts,
      });

      await this.emit({
        runId,
        stepId: retryingRun.currentStepId,
        type: 'run.retry_started',
        schemaVersion: 1,
        payload: {
          status: 'running',
          failureKind: retryability.failureKind,
          retryAttempts,
        },
      });
      await this.saveExecutionSnapshot(retryingRun, state, retryingRun.status);

      return await this.continueRunFromState(await this.refreshRun(runId), state, { retryFailedChild: true });
    } finally {
      await this.releaseLeaseQuietly(run.id);
    }
  }

  async getRecoveryOptions(runId: UUID): Promise<RunRecoveryOptions> {
    return this.recoveryAnalyzer.getRecoveryOptions(runId);
  }

  async continueRun(options: ContinueRunOptions): Promise<RunResult> {
    const continuation = await this.createContinuationRun(options);
    return this.runWithExistingRun(continuation.continuationRunId, {});
  }

  async createContinuationRun(options: ContinueRunOptions): Promise<ContinueRunResult> {
    const continuationStore = this.options.continuationStore;
    if (!continuationStore) {
      throw new Error('continueRun() requires a configured continuationStore');
    }

    const recovery = await this.getRecoveryOptions(options.fromRunId);
    if (!recovery.continuable) {
      throw new Error(recovery.unsafeReason ?? recovery.reason);
    }

    if (recovery.requiresReconciliation) {
      throw new Error(recovery.unsafeReason ?? 'Run requires reconciliation before continuation');
    }

    const sourceRun = await this.refreshRun(options.fromRunId);
    const sourceSnapshot = await this.options.snapshotStore?.getLatest(sourceRun.id);
    if (!sourceSnapshot) {
      throw new Error(`Run ${sourceRun.id} has no snapshot to use as a continuation base`);
    }

    if ((this.options.recovery?.continuation?.requireUserApproval || options.requireApproval) && options.requireApproval !== true) {
      throw new Error(`Continuation for run ${sourceRun.id} requires explicit approval`);
    }

    const strategy = options.strategy ?? recovery.recommendedStrategy ?? 'hybrid_snapshot_then_step';
    assertSupportedMvpContinuationStrategy(strategy);
    this.assertContinuationModelMatchesConfigured(options);

    const targetProvider = options.provider ?? this.options.model.provider;
    const targetModel = options.model ?? this.options.model.model;
    const sourceState = await this.loadExecutionState(sourceRun);
    const continuationBrief = await this.buildContinuationBrief(sourceRun, recovery, strategy, targetProvider, targetModel);
    const continuationMetadata: Record<string, JsonValue> = {
      ...(sourceRun.metadata ?? {}),
      ...(options.metadata ?? {}),
      continuationOfRunId: sourceRun.id,
      continuationStrategy: strategy,
      continuationFailureClass: recovery.failureClass,
      continuationSourceSnapshotSeq: recovery.sourceSnapshotSeq ?? sourceSnapshot.snapshotSeq,
      ...(recovery.lastCompletedStepId ? { continuationLastCompletedStepId: recovery.lastCompletedStepId } : {}),
      ...(recovery.nextStepId ? { continuationNextStepId: recovery.nextStepId } : {}),
    };

    const { run: continuationRun } = await this.createRunWithInitialSnapshot(
      {
        goal: sourceRun.goal,
        input: sourceRun.input,
        context: {
          ...(sourceRun.context ?? {}),
          continuation: continuationBrief,
        },
        metadata: continuationMetadata,
        modelProvider: targetProvider,
        modelName: targetModel,
        status: 'queued',
      },
      () => this.createContinuationExecutionState(sourceState, continuationBrief),
    );

    await continuationStore.createContinuation({
      sourceRunId: sourceRun.id,
      continuationRunId: continuationRun.id,
      strategy,
      failureClass: recovery.failureClass,
      reason: recovery.reason,
      sourceSnapshotId: recovery.sourceSnapshotId ?? sourceSnapshot.id,
      sourceSnapshotSeq: recovery.sourceSnapshotSeq ?? sourceSnapshot.snapshotSeq,
      sourceEventSeq: recovery.lastSafeEventSeq,
      sourceStepId: recovery.lastCompletedStepId,
      nextStepId: recovery.nextStepId,
      provider: targetProvider,
      model: targetModel,
      metadata: options.metadata,
    });

    await this.emit({
      runId: continuationRun.id,
      type: 'run.continuation_created',
      schemaVersion: 1,
      payload: removeUndefinedJsonFields({
        sourceRunId: sourceRun.id,
        strategy,
        failureClass: recovery.failureClass,
        reason: recovery.reason,
        sourceSnapshotSeq: recovery.sourceSnapshotSeq ?? sourceSnapshot.snapshotSeq,
        lastCompletedStepId: recovery.lastCompletedStepId,
        nextStepId: recovery.nextStepId,
        provider: targetProvider,
        model: targetModel,
      }),
    });

    this.logLifecycle('info', 'run.continuation_created', {
      ...runLogBindings(continuationRun),
      sourceRunId: sourceRun.id,
      strategy,
      failureClass: recovery.failureClass,
      nextStepId: recovery.nextStepId,
      provider: targetProvider,
      model: targetModel,
    });

    return {
      sourceRunId: sourceRun.id,
      continuationRunId: continuationRun.id,
      strategy,
      sourceSnapshotSeq: recovery.sourceSnapshotSeq ?? sourceSnapshot.snapshotSeq,
      lastCompletedStepId: recovery.lastCompletedStepId,
      nextStepId: recovery.nextStepId,
    };
  }

  private async runWithExistingRun(runId: UUID, options: RunContinuationOptions): Promise<RunResult> {
    const run = await this.options.runStore.getRun(runId);
    if (!run) {
      throw new Error(`Run ${runId} does not exist`);
    }

    const state = options.initialState ?? await this.loadExecutionState(run, options.outputSchema);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      return this.resultFromStoredRun(run, state.stepsUsed);
    }

    await this.acquireLeaseOrThrow(run.id);

    try {
      return await this.continueRunFromState(await this.refreshRun(run.id), state, options);
    } finally {
      await this.releaseLeaseQuietly(run.id);
    }
  }

  private async continueRunFromState(run: AgentRun, state: ExecutionState, options: RunContinuationOptions): Promise<RunResult> {
    let currentRun = run;
    if (TERMINAL_RUN_STATUSES.has(currentRun.status)) {
      return this.resultFromStoredRun(currentRun, state.stepsUsed);
    }

    const linkedChild = await this.resolveLinkedDelegateChildRun(currentRun, state);
    if (
      currentRun.status === 'awaiting_subagent' ||
      shouldResolveWaitingDelegateSnapshot(state) ||
      linkedChild.kind !== 'missing'
    ) {
      try {
        currentRun = await this.resumeAwaitingParent(
          currentRun,
          state,
          options.retryFailedChild ?? false,
          linkedChild,
        );
      } catch (error) {
        if (error instanceof DelegationError) {
          return this.failRun(currentRun, state, error.message, error.code);
        }

        return interruptResult(
          currentRun.id,
          state.stepsUsed,
          currentRun.usage,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    if (currentRun.status === 'interrupted') {
      currentRun = await this.transitionRun(currentRun, 'running');
      this.logLifecycle('info', 'run.resumed', {
        ...runLogBindings(currentRun),
        stepId: currentRun.currentStepId,
      });
      await this.emit({
        runId: currentRun.id,
        stepId: currentRun.currentStepId,
        type: 'run.resumed',
        schemaVersion: 1,
        payload: {
          status: 'running',
        },
      });
    } else if (currentRun.status !== 'running') {
      currentRun = await this.transitionRun(currentRun, 'running');
    }

    return await this.executionLoop(currentRun, state);
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
      if (!pendingToolCall) {
        const beforeDrainRun = currentRun;
        currentRun = await this.drainPendingSteerMessages(currentRun, state);
        if (currentRun !== beforeDrainRun) {
          await this.saveExecutionSnapshot(currentRun, state, currentRun.status);
        }
      }

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

        let toolExecutionResult: PendingToolCallExecutionResult;
        try {
          toolExecutionResult = await this.executePendingToolCall(currentRun, state, pendingToolCall);
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

        const toolOutput = toolExecutionResult.output;
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

        const stepCompletedEvent: Omit<AgentEvent, 'id' | 'seq' | 'createdAt'> = {
          runId: currentRun.id,
          stepId,
          type: 'step.completed',
          schemaVersion: 1,
          payload: {
            stepId,
            toolName: pendingToolCall.name,
          },
        };

        currentRun = await this.refreshRun(currentRun.id);
        await this.persistToolCompletionContinuation({
          run: currentRun,
          state,
          completion: toolExecutionResult.completion,
          stepCompletedEvent,
        });
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
        this.flushPendingRuntimeMessages(state);
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
        state.pendingToolCalls.push(
          ...createPendingToolCalls(response.toolCalls, state.stepsUsed + 1, assistantMessage?.content),
        );

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
      resetBudgetConsecutiveCalls(state.toolBudgetUsage);
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

  private async checkFailedRunRetryability(
    run: AgentRun,
    state: ExecutionState,
  ): Promise<FailedRunRetryability> {
    const failureKind = classifyFailureKind(run.errorCode as RunFailureCode | undefined, run.errorMessage);
    const pendingToolCall = state.pendingToolCalls[0];
    if (isDelegateToolCall(pendingToolCall)) {
      return this.checkDelegateChildRetryability(run, state, failureKind);
    }

    if (run.errorCode === 'MAX_STEPS') {
      if (this.defaults.maxSteps > state.stepsUsed) {
        return { retryable: true, failureKind };
      }

      return {
        retryable: false,
        failureKind,
        reason: `Run ${run.id} exhausted ${state.stepsUsed} steps; increase maxSteps above ${state.stepsUsed} before retrying`,
      };
    }

    if (run.errorCode === 'MODEL_ERROR') {
      if (isRetryableModelFailureKind(failureKind)) {
        return { retryable: true, failureKind };
      }

      return {
        retryable: false,
        failureKind,
        reason: `Run ${run.id} failed with non-retryable model failure kind "${failureKind}"`,
      };
    }

    if (run.errorCode === 'TOOL_ERROR') {
      const retryAttempts = readRetryAttempts(run.metadata);
      if (retryAttempts >= DEFAULT_TOOL_TERMINAL_RETRY_LIMIT) {
        return {
          retryable: false,
          failureKind,
          reason: `Run ${run.id} has already used its terminal tool retry attempt`,
        };
      }

      if (!pendingToolCall) {
        return {
          retryable: false,
          failureKind,
          reason: `Run ${run.id} has no pending tool call to retry`,
        };
      }

      const tool = this.resolveToolDefinitionByName(pendingToolCall.name);
      if (!tool) {
        return {
          retryable: false,
          failureKind,
          reason: `Run ${run.id} failed on unavailable tool "${pendingToolCall.name}"`,
        };
      }

      if (!tool.retryPolicy?.retryable) {
        return {
          retryable: false,
          failureKind,
          reason: `Tool "${tool.name}" is not marked retryable`,
        };
      }

      if (!toolRetryPolicyAllows(tool, failureKind)) {
        return {
          retryable: false,
          failureKind,
          reason: `Tool "${tool.name}" does not allow retry for failure kind "${failureKind}"`,
        };
      }

      return { retryable: true, failureKind };
    }

    return {
      retryable: false,
      failureKind,
      reason: `Run ${run.id} failed with non-retryable code "${run.errorCode ?? 'unknown'}"`,
    };
  }

  private async checkDelegateChildRetryability(
    run: AgentRun,
    state: ExecutionState,
    failureKind: FailureKind,
  ): Promise<FailedRunRetryability> {
    const linkedChild = await this.resolveLinkedDelegateChildRun(run, state);
    if (linkedChild.kind === 'missing') {
      return {
        retryable: false,
        failureKind,
        reason: linkedChild.reason,
      };
    }

    if (linkedChild.kind === 'invalid') {
      return {
        retryable: false,
        failureKind,
        reason: linkedChild.reason,
      };
    }

    const { childRun } = linkedChild;
    if (childRun.status === 'succeeded') {
      return { retryable: true, failureKind };
    }

    if (!TERMINAL_RUN_STATUSES.has(childRun.status)) {
      return { retryable: true, failureKind };
    }

    if (childRun.status === 'failed') {
      const childAgent = this.createAgentForChildRun(childRun);
      const childState = await childAgent.loadExecutionState(childRun);
      const childRetryability = await childAgent.checkFailedRunRetryability(childRun, childState);
      if (childRetryability.retryable) {
        return { retryable: true, failureKind };
      }

      return {
        retryable: false,
        failureKind,
        reason: `Linked child run ${childRun.id} is not retryable: ${childRetryability.reason}`,
      };
    }

    return {
      retryable: false,
      failureKind,
      reason: `Linked child run ${childRun.id} is ${childRun.status} and cannot be retried`,
    };
  }

  private resolveToolDefinitionByName(name: string): ToolDefinition | undefined {
    const exactTool = this.toolRegistry.get(name);
    if (exactTool) {
      return exactTool;
    }

    const correctedName = this.resolveMisspelledDelegateToolName(name);
    if (!correctedName) {
      return undefined;
    }

    return this.toolRegistry.get(correctedName);
  }

  private resolveMisspelledDelegateToolName(name: string): string | undefined {
    if (!name.startsWith(RESERVED_DELEGATE_PREFIX)) {
      return undefined;
    }

    const candidateNames = Array.from(this.toolRegistry.keys()).filter((toolName) =>
      toolName.startsWith(RESERVED_DELEGATE_PREFIX),
    );
    if (candidateNames.length === 0) {
      return undefined;
    }

    let bestName: string | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    let tied = false;

    for (const candidateName of candidateNames) {
      const distance = boundedLevenshteinDistance(name, candidateName, 2);
      if (distance === undefined) {
        continue;
      }

      if (distance < bestDistance) {
        bestDistance = distance;
        bestName = candidateName;
        tied = false;
      } else if (distance === bestDistance) {
        tied = true;
      }
    }

    if (!bestName || tied) {
      return undefined;
    }

    return bestName;
  }

  private async executePendingToolCall(
    run: AgentRun,
    state: ExecutionState,
    pendingToolCall: PendingToolCallState,
  ): Promise<PendingToolCallExecutionResult> {
    const resolvedTool = this.resolveToolDefinitionByName(pendingToolCall.name);
    if (resolvedTool && resolvedTool.name !== pendingToolCall.name) {
      this.logLifecycle('warn', 'tool.name_corrected', {
        ...runLogBindings(run),
        stepId: pendingToolCall.stepId,
        requestedToolName: pendingToolCall.name,
        resolvedToolName: resolvedTool.name,
      });
      pendingToolCall.name = resolvedTool.name;
    }

    const tool = resolvedTool;
    if (!tool) {
      throw new Error(`Unknown tool ${pendingToolCall.name}`);
    }

    if (tool.requiresApproval && !this.options.defaults?.autoApproveAll && !state.approvedToolCallIds.includes(pendingToolCall.id)) {
      const awaitingApprovalRun = await this.transitionRun(run, 'awaiting_approval');
      const eventInput = captureToolInputForLog(tool, pendingToolCall.input, this.defaultCaptureMode);
      this.logLifecycle('warn', 'approval.requested', {
        ...runLogBindings(awaitingApprovalRun),
        stepId: pendingToolCall.stepId,
        toolName: tool.name,
        input: eventInput,
      });
      await this.emit({
        runId: run.id,
        stepId: pendingToolCall.stepId,
        type: 'approval.requested',
        schemaVersion: 1,
        payload: {
          toolName: tool.name,
          ...(pendingToolCall.assistantContent === undefined ? {} : { assistantContent: pendingToolCall.assistantContent }),
          ...(eventInput === undefined ? {} : { input: eventInput }),
        },
      });

      await this.saveExecutionSnapshot(awaitingApprovalRun, state, 'awaiting_approval');
      throw new ApprovalRequiredError(tool.name);
    }

    state.approvedToolCallIds = removeApprovedToolCallId(state.approvedToolCallIds, pendingToolCall.id);

    const toolContext = this.createToolContext(run, pendingToolCall.stepId, pendingToolCall.id);
    const budgetGroup = this.resolveBudgetGroup(tool);
    const budget = budgetGroup ? this.resolvedToolBudgets?.[budgetGroup] : undefined;
    const existingExecution = await this.options.toolExecutionStore?.getByIdempotencyKey(toolContext.idempotencyKey);
    if (existingExecution?.status === 'completed') {
      this.onToolExecutionAdmitted(run, state, budgetGroup, budget);
      this.logLifecycle('info', 'tool.execution_reused', {
        ...runLogBindings(run),
        stepId: pendingToolCall.stepId,
        toolName: tool.name,
        idempotencyKey: toolContext.idempotencyKey,
      });
      return {
        output: existingExecution.output ?? null,
      };
    }

    const budgetAdmission = this.admitBudgetedToolCall(run, state, tool, pendingToolCall.input, budgetGroup, budget);
    if (!budgetAdmission.admitted) {
      await this.options.toolExecutionStore?.markStarted({
        runId: run.id,
        stepId: pendingToolCall.stepId,
        toolCallId: pendingToolCall.id,
        toolName: tool.name,
        idempotencyKey: toolContext.idempotencyKey,
        inputHash: stableJsonFingerprint(pendingToolCall.input),
        input: pendingToolCall.input,
      });

      const eventInput = captureToolInputForLog(tool, pendingToolCall.input, this.defaultCaptureMode);
      const budgetOutput = budgetAdmission.output;

      this.logLifecycle('warn', 'tool.budget_exhausted', {
        ...runLogBindings(run),
        stepId: pendingToolCall.stepId,
        toolName: tool.name,
        budgetGroup,
        output: captureValueForLog(budgetOutput, { mode: 'summary' }),
      });

      return {
        output: budgetOutput,
        completion: {
          idempotencyKey: toolContext.idempotencyKey,
          output: budgetOutput,
          event: {
            runId: run.id,
            stepId: pendingToolCall.stepId,
            toolCallId: pendingToolCall.id,
            type: 'tool.completed',
            schemaVersion: 1,
          payload: {
            toolName: tool.name,
            ...(pendingToolCall.assistantContent === undefined ? {} : { assistantContent: pendingToolCall.assistantContent }),
            ...(eventInput === undefined ? {} : { input: eventInput }),
            output: budgetOutput,
            ...(budgetGroup === undefined ? {} : { budgetGroup }),
              skipped: true,
            },
          },
        },
      };
    }

    await this.options.toolExecutionStore?.markStarted({
      runId: run.id,
      stepId: pendingToolCall.stepId,
      toolCallId: pendingToolCall.id,
      toolName: tool.name,
      idempotencyKey: toolContext.idempotencyKey,
      inputHash: stableJsonFingerprint(pendingToolCall.input),
      input: pendingToolCall.input,
    });

    this.onToolExecutionAdmitted(run, state, budgetGroup, budget);

    const emitsToolLifecycle = tool.name.startsWith(RESERVED_DELEGATE_PREFIX);
    const toolStartedAt = Date.now();

    if (!emitsToolLifecycle) {
      const eventInput = captureToolInputForLog(tool, pendingToolCall.input, this.defaultCaptureMode);
      this.logToolStarted(run, pendingToolCall.stepId, tool, pendingToolCall.input);
      await this.emit({
        runId: run.id,
        stepId: pendingToolCall.stepId,
        toolCallId: pendingToolCall.id,
        type: 'tool.started',
        schemaVersion: 1,
        payload: {
          toolName: tool.name,
          ...(pendingToolCall.assistantContent === undefined ? {} : { assistantContent: pendingToolCall.assistantContent }),
          ...(eventInput === undefined ? {} : { input: eventInput }),
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
      }

      const eventInput = captureToolInputForLog(tool, pendingToolCall.input, this.defaultCaptureMode);
      const completionPayload: JsonObject = {
        toolName: tool.name,
        ...(pendingToolCall.assistantContent === undefined ? {} : { assistantContent: pendingToolCall.assistantContent }),
        ...(eventInput === undefined ? {} : { input: eventInput }),
        output: tool.summarizeResult ? tool.summarizeResult(output) : output,
      };

      return {
        output,
        completion: {
          idempotencyKey: toolContext.idempotencyKey,
          output,
          event: emitsToolLifecycle
            ? undefined
            : {
                runId: run.id,
                stepId: pendingToolCall.stepId,
                toolCallId: pendingToolCall.id,
                type: 'tool.completed',
                schemaVersion: 1,
                payload: completionPayload,
              },
        },
      };
    } catch (error) {
      if (error instanceof ApprovalRequiredError) {
        throw error;
      }

      const recoveredOutput = recoverToolError(tool, error, pendingToolCall.input);
      let toolFailedEvent: Omit<AgentEvent, 'id' | 'seq' | 'createdAt'> | undefined;

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
        const eventInput = captureToolInputForLog(tool, pendingToolCall.input, this.defaultCaptureMode);
        const recoveredEventOutput =
          recoveredOutput === undefined
            ? undefined
            : tool.summarizeResult
              ? tool.summarizeResult(recoveredOutput)
              : recoveredOutput;
        toolFailedEvent = {
          runId: run.id,
          stepId: pendingToolCall.stepId,
          toolCallId: pendingToolCall.id,
          type: 'tool.failed',
          schemaVersion: 1,
          payload: {
            toolName: tool.name,
            ...(pendingToolCall.assistantContent === undefined ? {} : { assistantContent: pendingToolCall.assistantContent }),
            ...(eventInput === undefined ? {} : { input: eventInput }),
            error: error instanceof Error ? error.message : String(error),
            recoverable: recoveredOutput !== undefined,
            ...(recoveredEventOutput === undefined ? {} : { output: recoveredEventOutput }),
          },
        };
      }

      if (recoveredOutput !== undefined) {
        return {
          output: recoveredOutput,
          completion: {
            idempotencyKey: toolContext.idempotencyKey,
            output: recoveredOutput,
            event: toolFailedEvent,
          },
        };
      }

      await this.persistToolExecutionFailure({
        idempotencyKey: toolContext.idempotencyKey,
        errorCode: error instanceof DelegationError ? error.code : 'TOOL_ERROR',
        errorMessage: error instanceof Error ? error.message : String(error),
        event: toolFailedEvent,
      });

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

  private async resolveLinkedDelegateChildRun(run: AgentRun, state: ExecutionState): Promise<LinkedDelegateChildRun> {
    const pendingToolCall = state.pendingToolCalls[0];
    if (!isDelegateToolCall(pendingToolCall)) {
      return { kind: 'missing', reason: `Run ${run.id} has no pending delegate tool call` };
    }

    const linkedChildIds = [
      run.currentChildRunId,
      state.waitingOnChildRunId,
      await this.getDelegateToolExecutionChildRunId(run, pendingToolCall),
    ].filter((childRunId): childRunId is UUID => typeof childRunId === 'string' && childRunId.length > 0);
    const distinctChildIds = Array.from(new Set(linkedChildIds));
    if (distinctChildIds.length === 0) {
      return { kind: 'missing', reason: `Run ${run.id} has no linked child run for ${pendingToolCall.name}` };
    }

    if (distinctChildIds.length > 1) {
      return {
        kind: 'invalid',
        reason: `Run ${run.id} has conflicting child linkage for ${pendingToolCall.name}: ${distinctChildIds.join(', ')}`,
      };
    }

    const childRunId = distinctChildIds[0];
    const childRun = await this.options.runStore.getRun(childRunId);
    if (!childRun) {
      return { kind: 'invalid', reason: `Linked child run ${childRunId} does not exist` };
    }

    const linkageError = validateLinkedChildRun(run, childRun, pendingToolCall.stepId);
    if (linkageError) {
      return { kind: 'invalid', reason: linkageError, childRun };
    }

    return { kind: 'linked', childRun };
  }

  private async getDelegateToolExecutionChildRunId(
    run: AgentRun,
    pendingToolCall: PendingToolCallState,
  ): Promise<UUID | undefined> {
    const record = await this.options.toolExecutionStore?.getByIdempotencyKey(
      toolCallIdempotencyKey(run.id, pendingToolCall.stepId, pendingToolCall.id),
    );
    if (record?.toolName !== pendingToolCall.name) {
      return undefined;
    }

    return record.childRunId;
  }

  private async resumeAwaitingParent(
    run: AgentRun,
    state: ExecutionState,
    retryFailedChild: boolean,
    linkedChild?: LinkedDelegateChildRun,
  ): Promise<AgentRun> {
    linkedChild ??= await this.resolveLinkedDelegateChildRun(run, state);

    let childRunId: UUID | undefined;
    if (linkedChild.kind === 'invalid') {
      throw new DelegationError(linkedChild.reason);
    }

    if (linkedChild.kind === 'linked') {
      const { childRun } = linkedChild;
      childRunId = childRun.id;
      state.waitingOnChildRunId = childRun.id;

      if (run.status === 'running' && retryFailedChild && childRun.status === 'failed') {
        await this.restoreAwaitingDelegateBoundary(run, childRun.id);
      }

      if (!TERMINAL_RUN_STATUSES.has(childRun.status)) {
        const childAgent = this.createAgentForChildRun(childRun);
        await childAgent.resume(childRun.id);
      } else if (retryFailedChild && childRun.status === 'failed') {
        const childAgent = this.createAgentForChildRun(childRun);
        const childState = await childAgent.loadExecutionState(childRun);
        const childRetryability = await childAgent.checkFailedRunRetryability(childRun, childState);
        if (childRetryability.retryable) {
          await childAgent.retry(childRun.id);
        }
      }
    }

    const resolution = await this.delegationExecutor.resumeParentRun(run.id, childRunId);
    return this.applyParentResumeResolution(run, state, resolution);
  }

  private async restoreAwaitingDelegateBoundary(run: AgentRun, childRunId: UUID): Promise<AgentRun> {
    const currentRun = await this.refreshRun(run.id);
    if (currentRun.status === 'awaiting_subagent' && currentRun.currentChildRunId === childRunId) {
      return currentRun;
    }

    return this.options.runStore.updateRun(
      currentRun.id,
      {
        status: 'awaiting_subagent',
        currentChildRunId: childRunId,
      },
      currentRun.version,
    );
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

      await this.markExistingToolExecutionCompleted(run, pendingToolCall, resolution.output);

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

  private async markExistingToolExecutionCompleted(
    run: AgentRun,
    pendingToolCall: PendingToolCallState,
    output: JsonValue,
  ): Promise<void> {
    const idempotencyKey = toolCallIdempotencyKey(run.id, pendingToolCall.stepId, pendingToolCall.id);
    const existingExecution = await this.options.toolExecutionStore?.getByIdempotencyKey(idempotencyKey);
    if (!existingExecution || existingExecution.status === 'completed') {
      return;
    }

    await this.persistToolExecutionCompletion({
      idempotencyKey,
      output,
    });
  }

  private createScopedAgent(delegate: NonNullable<AdaptiveAgentOptions['delegates']>[number]): AdaptiveAgent {
    const recursiveDelegates = this.options.delegation?.allowRecursiveDelegation ? this.options.delegates : [];
    const hostTools = this.pickHostTools(delegate.allowedTools);
    const tools = delegate.handlerTools ? [...hostTools, ...delegate.handlerTools] : hostTools;
    const defaults = mergeDelegateDefaults(this.options.defaults, delegate.defaults);
    return new AdaptiveAgent({
      model: delegate.model ?? this.options.model,
      tools,
      delegates: recursiveDelegates,
      delegation: this.options.delegation,
      runStore: this.options.runStore,
      eventStore: this.options.eventStore,
      snapshotStore: this.options.snapshotStore,
      planStore: this.options.planStore,
      continuationStore: this.options.continuationStore,
      toolExecutionStore: this.options.toolExecutionStore,
      transactionStore: this.options.transactionStore,
      eventSink: this.options.eventSink,
      logger: this.options.logger,
      defaults,
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
      toolCallId,
      planId: run.currentPlanId,
      planExecutionId: run.currentPlanExecutionId,
      input: run.input,
      context: run.context,
      idempotencyKey: `${run.id}:${stepId}:${toolCallId}`,
      signal: controller.signal,
      emit: (event) => Promise.resolve(this.emit(event)),
    };
  }

  private resolveAvailableToolNamesForRun(run: AgentRun): Set<string> | undefined {
    if (!run.delegateName) {
      return new Set(this.toolRegistry.keys());
    }

    const delegate = (this.options.delegates ?? []).find((candidate) => candidate.name === run.delegateName);
    if (!delegate) {
      return undefined;
    }

    const toolNames = new Set<string>(delegate.allowedTools);
    for (const handlerTool of delegate.handlerTools ?? []) {
      toolNames.add(handlerTool.name);
    }
    if (this.options.delegation?.allowRecursiveDelegation) {
      for (const nestedDelegate of this.options.delegates ?? []) {
        toolNames.add(`${RESERVED_DELEGATE_PREFIX}${nestedDelegate.name}`);
      }
    }

    return toolNames;
  }

  private async buildContinuationBrief(
    sourceRun: AgentRun,
    recovery: RunRecoveryOptions,
    strategy: ContinuationStrategy,
    provider: string,
    model: string,
  ): Promise<JsonObject> {
    const events = await this.options.eventStore?.listByRun(sourceRun.id, 0) ?? [];
    const completedSteps = events
      .filter((event) => event.type === 'step.completed' && event.stepId)
      .map((event) => ({
        stepId: event.stepId ?? 'unknown',
        payload: event.payload,
      }));
    const completedToolResults = events
      .filter((event) => event.type === 'tool.completed' && event.stepId)
      .map((event) => ({
        stepId: event.stepId ?? 'unknown',
        toolCallId: event.toolCallId ?? null,
        payload: event.payload,
      }));

    return {
      sourceRunId: sourceRun.id,
      originalGoal: sourceRun.goal,
      strategy,
      failure: {
        class: recovery.failureClass,
        code: sourceRun.errorCode ?? null,
        message: sourceRun.errorMessage ?? null,
        provider: sourceRun.modelProvider ?? null,
        model: sourceRun.modelName ?? null,
      },
      continuationModel: {
        provider,
        model,
      },
      progress: {
        sourceSnapshotSeq: recovery.sourceSnapshotSeq ?? null,
        lastSafeEventSeq: recovery.lastSafeEventSeq ?? null,
        lastCompletedStepId: recovery.lastCompletedStepId ?? null,
        nextStepId: recovery.nextStepId ?? null,
        completedSteps: completedSteps as unknown as JsonValue,
        completedToolResults: completedToolResults as unknown as JsonValue,
      },
      instructions: [
        'You are continuing a previous failed run.',
        'Use completed work as durable progress and do not repeat completed steps unless verification shows the prior output is missing or invalid.',
        'Continue from the next incomplete step.',
        'If prior state is ambiguous, inspect before acting.',
        'Preserve the original goal and produce the requested final result.',
      ],
    };
  }

  private createContinuationExecutionState(sourceState: ExecutionState, continuationBrief: JsonObject): ExecutionState {
    const toolManifestMessage = this.buildRuntimeToolManifestMessage();
    const state = this.createExecutionState(
      [
        buildAgentSystemMessage(this.options.systemInstructions),
        ...(toolManifestMessage ? [toolManifestMessage] : []),
        {
          role: 'user',
          content: [
            'Continue the previous failed run using this recovery brief.',
            '',
            '```json',
            JSON.stringify(continuationBrief, null, 2),
            '```',
          ].join('\n'),
        },
      ],
      sourceState.outputSchema,
    );
    state.stepsUsed = sourceState.stepsUsed;
    return state;
  }

  private assertContinuationModelMatchesConfigured(options: ContinueRunOptions): void {
    if (options.provider && options.provider !== this.options.model.provider) {
      throw new Error(
        `Continuation target provider ${options.provider} does not match this agent's configured provider ${this.options.model.provider}; instantiate an agent with the target model before continuing`,
      );
    }

    if (options.model && options.model !== this.options.model.model) {
      throw new Error(
        `Continuation target model ${options.model} does not match this agent's configured model ${this.options.model.model}; instantiate an agent with the target model before continuing`,
      );
    }
  }

  private createExecutionState(messages: ModelMessage[], outputSchema?: JsonSchema): ExecutionState {
    return {
      messages,
      stepsUsed: 0,
      pendingToolCalls: [],
      approvedToolCallIds: [],
      toolBudgetUsage: {},
      pendingRuntimeMessages: [],
      outputSchema,
    };
  }

  private flushPendingRuntimeMessages(state: ExecutionState): void {
    if (state.pendingRuntimeMessages.length === 0) {
      return;
    }

    state.messages.push(...state.pendingRuntimeMessages);
    state.pendingRuntimeMessages = [];
  }

  private enqueueRuntimeSystemMessage(
    run: AgentRun,
    state: ExecutionState,
    source: 'research_policy.require_purpose' | 'tool_budget.checkpoint',
    content: string,
  ): void {
    state.pendingRuntimeMessages.push({
      role: 'system',
      content,
    });
    this.logInjectedSystemMessage(run, source, content, 'pendingRuntimeMessages', run.currentStepId);
  }

  private logInitialInjectedSystemMessages(run: AgentRun, state: ExecutionState): void {
    const initialPrompt = state.messages[0];
    if (initialPrompt?.role === 'system' && typeof initialPrompt.content === 'string') {
      this.logInjectedSystemMessage(run, 'initial_prompt', initialPrompt.content, 'messages', run.currentStepId);
    }

    for (const message of state.messages.slice(1)) {
      if (message.role !== 'system' || typeof message.content !== 'string') {
        continue;
      }

      if (message.content.startsWith('## Available Tools and Delegates\n\n')) {
        this.logInjectedSystemMessage(run, 'tool_manifest', message.content, 'messages', run.currentStepId);
      }

      if (message.content.startsWith('## Additional Context\n\n')) {
        this.logInjectedSystemMessage(run, 'chat_context', message.content, 'messages', run.currentStepId);
      }
    }
  }

  private resolveBudgetGroup(tool: ToolDefinition): string | undefined {
    if (tool.budgetGroup && this.resolvedToolBudgets?.[tool.budgetGroup]) {
      return tool.budgetGroup;
    }

    if (this.resolvedToolBudgets?.[tool.name]) {
      return tool.name;
    }

    return tool.budgetGroup;
  }

  private admitBudgetedToolCall(
    run: AgentRun,
    state: ExecutionState,
    tool: ToolDefinition,
    input: JsonValue,
    budgetGroup: string | undefined,
    budget: ToolBudget | undefined,
  ): { admitted: true } | { admitted: false; output: JsonObject } {
    if (!budgetGroup || !budget) {
      return { admitted: true };
    }

    const usage = state.toolBudgetUsage[budgetGroup] ?? emptyToolBudgetUsage();
    const maxCalls = normalizeBudgetLimit(budget.maxCalls);
    if (maxCalls !== undefined && usage.calls >= maxCalls) {
      return {
        admitted: false,
        output: createBudgetExhaustedToolOutput(tool.name, budgetGroup, budget.onExhausted),
      };
    }

    const maxConsecutiveCalls = normalizeBudgetLimit(budget.maxConsecutiveCalls);
    if (maxConsecutiveCalls !== undefined && usage.consecutiveCalls >= maxConsecutiveCalls) {
      return {
        admitted: false,
        output: createBudgetExhaustedToolOutput(tool.name, budgetGroup, budget.onExhausted),
      };
    }

    if (
      this.resolvedResearchPolicy?.requirePurpose &&
      tool.name === 'web_search' &&
      isMissingWebSearchPurpose(input)
    ) {
      this.enqueueRuntimeSystemMessage(
        run,
        state,
        'research_policy.require_purpose',
        'Future `web_search` calls should include a short `purpose` so research stays goal-directed.',
      );
    }

    return { admitted: true };
  }

  private onToolExecutionAdmitted(
    run: AgentRun,
    state: ExecutionState,
    budgetGroup: string | undefined,
    budget: ToolBudget | undefined,
  ): void {
    if (!budgetGroup || !budget) {
      resetBudgetConsecutiveCalls(state.toolBudgetUsage);
      return;
    }

    resetBudgetConsecutiveCalls(state.toolBudgetUsage, budgetGroup);
    const usage = state.toolBudgetUsage[budgetGroup] ?? emptyToolBudgetUsage();
    usage.calls += 1;
    usage.consecutiveCalls += 1;

    const checkpointAfter = normalizeBudgetLimit(budget.checkpointAfter);
    if (checkpointAfter !== undefined && !usage.checkpointEmitted && usage.calls >= checkpointAfter) {
      usage.checkpointEmitted = true;
      this.enqueueRuntimeSystemMessage(
        run,
        state,
        'tool_budget.checkpoint',
        'You are near the web research budget. Use current evidence if it is sufficient. Only call another web research tool if you can name the specific missing fact needed for the user\'s goal. If evidence is incomplete, say what is uncertain instead of continuing to search broadly.',
      );
    }

    state.toolBudgetUsage[budgetGroup] = usage;
  }

  private createInitialExecutionState(run: AgentRun, outputSchema?: JsonSchema, images?: ImageInput[]): ExecutionState {
    return this.createExecutionState(
      buildInitialMessages(run, outputSchema, this.options.systemInstructions, this.buildRuntimeToolManifestMessage(), images),
      outputSchema,
    );
  }

  private buildRuntimeToolManifestMessage(): ModelMessage | undefined {
    if (this.options.defaults?.injectToolManifest === false) {
      return undefined;
    }

    return buildRuntimeToolManifestMessage(
      Array.from(this.toolRegistry.values()),
      this.options.model.formatToolName?.bind(this.options.model),
    );
  }

  private async createRunWithInitialSnapshot(
    runInput: Parameters<AdaptiveAgentOptions['runStore']['createRun']>[0],
    createState: (run: AgentRun) => ExecutionState,
  ): Promise<{ run: AgentRun; state: ExecutionState }> {
    const persistedRunInput = this.withPersistedModelConfig(runInput);
    const transactionStore = this.options.transactionStore;
    if (transactionStore?.eventStore && transactionStore.snapshotStore) {
      const downstreamEvents: Array<Omit<AgentEvent, 'id' | 'seq' | 'createdAt'>> = [];
      const result = await transactionStore.runInTransaction(async (stores) => {
        if (!stores.eventStore || !stores.snapshotStore) {
          throw new Error('Transactional run creation requires eventStore and snapshotStore');
        }

        const run = await stores.runStore.createRun(persistedRunInput);
        const state = createState(run);
        this.logInitialInjectedSystemMessages(run, state);
        const createdEvent = this.runCreatedEvent(run);
        await stores.eventStore.append(createdEvent);

        const snapshot = await stores.snapshotStore.save({
          runId: run.id,
          snapshotSeq: 1,
          status: run.status,
          currentStepId: run.currentStepId,
          currentPlanId: run.currentPlanId,
          currentPlanExecutionId: run.currentPlanExecutionId,
          summary: {
            status: run.status,
            stepsUsed: state.stepsUsed,
          },
          state: serializeExecutionState(state),
        });

        const snapshotEvent = this.snapshotCreatedEvent(run, snapshot.snapshotSeq, run.status);
        await stores.eventStore.append(snapshotEvent);
        downstreamEvents.push(createdEvent, snapshotEvent);
        this.logSnapshotCreated(run, state, snapshot.snapshotSeq, run.status);

        return { run, state };
      });

      await this.emitDownstreamOnly(downstreamEvents);
      return result;
    }

    const run = await this.options.runStore.createRun(persistedRunInput);
    const state = createState(run);
    this.logInitialInjectedSystemMessages(run, state);
    await this.emit(this.runCreatedEvent(run));
    await this.saveExecutionSnapshot(run, state, run.status);
    return { run, state };
  }

  private async loadExecutionState(run: AgentRun, outputSchema?: JsonSchema): Promise<ExecutionState> {
    const snapshot = await this.options.snapshotStore?.getLatest(run.id);
    const parsed = snapshot ? deserializeExecutionState(snapshot.state) : null;
    if (snapshot && !parsed) {
      throw new Error(`Run ${run.id} latest snapshot state is not compatible with this runtime`);
    }

    return parsed ?? this.createInitialExecutionState(run, outputSchema);
  }

  private withPersistedModelConfig(
    runInput: Parameters<AdaptiveAgentOptions['runStore']['createRun']>[0],
  ): Parameters<AdaptiveAgentOptions['runStore']['createRun']>[0] {
    return {
      ...runInput,
      modelProvider: runInput.modelProvider ?? this.options.model.provider,
      modelName: runInput.modelName ?? this.options.model.model,
      modelParameters: runInput.modelParameters,
    };
  }

  private async saveExecutionSnapshot(run: AgentRun, state: ExecutionState, status: RunStatus): Promise<void> {
    if (!this.options.snapshotStore) {
      return;
    }

    const transactionStore = this.options.transactionStore;
    if (transactionStore?.eventStore && transactionStore.snapshotStore) {
      const snapshotEvent = await transactionStore.runInTransaction((stores) =>
        this.saveExecutionSnapshotWithStores(stores, run, state, status),
      );

      await this.emitDownstreamOnly(snapshotEvent ? [snapshotEvent] : []);
      return;
    }

    await this.saveExecutionSnapshotWithStores(
      {
        eventStore: this.options.eventStore,
        snapshotStore: this.options.snapshotStore,
      },
      run,
      state,
      status,
    );
  }

  private async saveExecutionSnapshotWithStores(
    stores: Pick<RuntimeStores, 'eventStore' | 'snapshotStore'>,
    run: AgentRun,
    state: ExecutionState,
    status: RunStatus,
  ): Promise<Omit<AgentEvent, 'id' | 'seq' | 'createdAt'> | null> {
    if (!stores.snapshotStore) {
      return null;
    }

    const latestSnapshot = await stores.snapshotStore.getLatest(run.id);
    const snapshot = await stores.snapshotStore.save({
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

    const snapshotEvent = this.snapshotCreatedEvent(run, snapshot.snapshotSeq, status);
    await stores.eventStore?.append(snapshotEvent);
    this.logSnapshotCreated(run, state, snapshot.snapshotSeq, status);
    return snapshotEvent;
  }

  private async persistToolExecutionCompletion(params: {
    idempotencyKey: string;
    output: JsonValue;
    event?: Omit<AgentEvent, 'id' | 'seq' | 'createdAt'>;
  }): Promise<void> {
    const transactionStore = this.options.transactionStore;
    if (transactionStore?.toolExecutionStore && (transactionStore.eventStore || !params.event)) {
      await transactionStore.runInTransaction(async (stores) => {
        if (!stores.toolExecutionStore) {
          throw new Error('Transactional tool completion requires toolExecutionStore');
        }

        await stores.toolExecutionStore.markCompleted(params.idempotencyKey, params.output);
        if (params.event) {
          if (!stores.eventStore) {
            throw new Error('Transactional tool completion event requires eventStore');
          }

          await stores.eventStore.append(params.event);
        }
      });

      await this.emitDownstreamOnly(params.event ? [params.event] : []);
      return;
    }

    await this.options.toolExecutionStore?.markCompleted(params.idempotencyKey, params.output);
    if (params.event) {
      await this.emit(params.event);
    }
  }

  private async persistToolExecutionFailure(params: {
    idempotencyKey: string;
    errorCode: string;
    errorMessage: string;
    event?: Omit<AgentEvent, 'id' | 'seq' | 'createdAt'>;
  }): Promise<void> {
    const transactionStore = this.options.transactionStore;
    if (transactionStore?.toolExecutionStore && (transactionStore.eventStore || !params.event)) {
      await transactionStore.runInTransaction(async (stores) => {
        if (!stores.toolExecutionStore) {
          throw new Error('Transactional tool failure requires toolExecutionStore');
        }

        await stores.toolExecutionStore.markFailed(params.idempotencyKey, params.errorCode, params.errorMessage);
        if (params.event) {
          if (!stores.eventStore) {
            throw new Error('Transactional tool failure event requires eventStore');
          }

          await stores.eventStore.append(params.event);
        }
      });

      await this.emitDownstreamOnly(params.event ? [params.event] : []);
      return;
    }

    await this.options.toolExecutionStore?.markFailed(params.idempotencyKey, params.errorCode, params.errorMessage);
    if (params.event) {
      await this.emit(params.event);
    }
  }

  private async persistToolCompletionContinuation(params: {
    run: AgentRun;
    state: ExecutionState;
    completion?: ToolExecutionCompletionPersistence;
    stepCompletedEvent: Omit<AgentEvent, 'id' | 'seq' | 'createdAt'>;
  }): Promise<void> {
    const transactionStore = this.options.transactionStore;
    if (
      transactionStore?.eventStore &&
      transactionStore.snapshotStore &&
      (!params.completion || transactionStore.toolExecutionStore)
    ) {
      const downstreamEvents: Array<Omit<AgentEvent, 'id' | 'seq' | 'createdAt'>> = [];
      await transactionStore.runInTransaction(async (stores) => {
        if (!stores.eventStore || !stores.snapshotStore) {
          throw new Error('Transactional tool continuation requires eventStore and snapshotStore');
        }

        if (params.completion) {
          if (!stores.toolExecutionStore) {
            throw new Error('Transactional tool continuation requires toolExecutionStore');
          }

          await stores.toolExecutionStore.markCompleted(params.completion.idempotencyKey, params.completion.output);
          if (params.completion.event) {
            await stores.eventStore.append(params.completion.event);
            downstreamEvents.push(params.completion.event);
          }
        }

        await stores.eventStore.append(params.stepCompletedEvent);
        downstreamEvents.push(params.stepCompletedEvent);
        const snapshotEvent = await this.saveExecutionSnapshotWithStores(
          stores,
          params.run,
          params.state,
          params.run.status,
        );
        if (snapshotEvent) {
          downstreamEvents.push(snapshotEvent);
        }
      });

      await this.emitDownstreamOnly(downstreamEvents);
      return;
    }

    if (params.completion) {
      await this.persistToolExecutionCompletion(params.completion);
    }

    await this.emit(params.stepCompletedEvent);
    await this.saveExecutionSnapshot(params.run, params.state, params.run.status);
  }

  private async persistTerminalRunTransition(params: {
    run: AgentRun;
    state: ExecutionState;
    patch: Partial<AgentRun>;
    event: (run: AgentRun) => Omit<AgentEvent, 'id' | 'seq' | 'createdAt'>;
  }): Promise<AgentRun> {
    const transactionStore = this.options.transactionStore;
    if (transactionStore?.eventStore && transactionStore.snapshotStore) {
      const downstreamEvents: Array<Omit<AgentEvent, 'id' | 'seq' | 'createdAt'>> = [];
      const terminalRun = await transactionStore.runInTransaction(async (stores) => {
        if (!stores.eventStore || !stores.snapshotStore) {
          throw new Error('Transactional terminal transition requires eventStore and snapshotStore');
        }

        const updatedRun = await stores.runStore.updateRun(params.run.id, params.patch, params.run.version);
        const snapshotEvent = await this.saveExecutionSnapshotWithStores(
          stores,
          updatedRun,
          params.state,
          updatedRun.status,
        );
        if (snapshotEvent) {
          downstreamEvents.push(snapshotEvent);
        }

        const terminalEvent = params.event(updatedRun);
        await stores.eventStore.append(terminalEvent);
        downstreamEvents.push(terminalEvent);
        return updatedRun;
      });

      await this.emitDownstreamOnly(downstreamEvents);
      return terminalRun;
    }

    const terminalRun = await this.updateRunForTerminalTransition(params.run, params.patch);
    await this.saveExecutionSnapshot(terminalRun, params.state, terminalRun.status);
    await this.emit(params.event(terminalRun));
    return terminalRun;
  }

  private async updateRunForTerminalTransition(run: AgentRun, patch: Partial<AgentRun>): Promise<AgentRun> {
    try {
      return await this.options.runStore.updateRun(run.id, patch, run.version);
    } catch (error) {
      if (!isOptimisticConcurrencyError(error)) {
        throw error;
      }

      const refreshedRun = await this.refreshRun(run.id);
      if (TERMINAL_RUN_STATUSES.has(refreshedRun.status)) {
        return refreshedRun;
      }

      return this.options.runStore.updateRun(refreshedRun.id, patch, refreshedRun.version);
    }
  }

  private runCreatedEvent(run: AgentRun): Omit<AgentEvent, 'id' | 'seq' | 'createdAt'> {
    return {
      runId: run.id,
      type: 'run.created',
      schemaVersion: 1,
      payload: {
        goal: run.goal,
        rootRunId: run.rootRunId,
        delegationDepth: run.delegationDepth,
      },
    };
  }

  private snapshotCreatedEvent(
    run: AgentRun,
    snapshotSeq: number,
    status: RunStatus,
  ): Omit<AgentEvent, 'id' | 'seq' | 'createdAt'> {
    return {
      runId: run.id,
      stepId: run.currentStepId,
      type: 'snapshot.created',
      schemaVersion: 1,
      payload: {
        snapshotSeq,
        status,
      },
    };
  }

  private logSnapshotCreated(
    run: AgentRun,
    state: ExecutionState,
    snapshotSeq: number,
    status: RunStatus,
  ): void {
    this.logLifecycle('debug', 'snapshot.created', {
      ...runLogBindings(run),
      stepId: run.currentStepId,
      snapshotSeq,
      status,
      stepsUsed: state.stepsUsed,
    });
  }

  private async generateModelResponse(run: AgentRun, state: ExecutionState): Promise<ModelResponse> {
    const modelRequest = {
      messages: [...state.messages],
      tools: this.plannerVisibleTools(),
      outputSchema: state.outputSchema,
      metadata: run.metadata,
    };
    const startedAt = Date.now();
    const timeoutContext = createAbortTimeoutContext(this.defaults.modelTimeoutMs);
    const modelTimeoutMs = this.defaults.modelTimeoutMs;
    const modelProvider = this.options.model.provider;
    const modelName = this.options.model.model;

    this.logLifecycle('debug', 'model.request', {
      ...runLogBindings(run),
      stepId: run.currentStepId,
      ...summarizeModelRequestForLog(modelRequest),
    });

    await this.emit({
      runId: run.id,
      stepId: run.currentStepId,
      type: 'model.started',
      schemaVersion: 1,
      payload: {
        stepId: run.currentStepId,
        modelTimeoutMs,
        provider: modelProvider,
        model: modelName,
        startedAt: new Date(startedAt).toISOString(),
      },
    });

    let response: ModelResponse;
    try {
      response = await this.options.model.generate({
        ...modelRequest,
        signal: timeoutContext.signal,
        onRetry: async (retry) => {
          const durationMs = Date.now() - startedAt;
          this.logLifecycle('warn', 'model.retry', {
            ...runLogBindings(run),
            stepId: run.currentStepId,
            provider: modelProvider,
            model: modelName,
            durationMs,
            attempt: retry.attempt,
            nextAttempt: retry.nextAttempt,
            statusCode: retry.statusCode,
            retryDelayMs: retry.retryDelayMs,
            reason: retry.reason,
            phase: retry.phase,
            message: retry.message,
          });
          await this.emit({
            runId: run.id,
            stepId: run.currentStepId,
            type: 'model.retry',
            schemaVersion: 1,
            payload: {
              stepId: run.currentStepId,
              provider: modelProvider,
              model: modelName,
              durationMs,
              attempt: retry.attempt,
              nextAttempt: retry.nextAttempt,
              statusCode: retry.statusCode,
              retryDelayMs: retry.retryDelayMs,
              reason: retry.reason,
              phase: retry.phase,
              message: retry.message,
            },
          });
        },
      });
    } catch (error) {
      const modelError = timeoutContext.didTimeout()
        ? createModelTimeoutError(this.defaults.modelTimeoutMs, error)
        : error;
      const durationMs = Date.now() - startedAt;
      this.logLifecycle('error', 'model.failed', {
        ...runLogBindings(run),
        stepId: run.currentStepId,
        durationMs,
        ...summarizeModelFailureForLog(modelError, {
          modelTimeoutMs,
          timedOut: timeoutContext.didTimeout(),
        }),
        error: errorForLog(modelError),
      });
      try {
        await this.emit({
          runId: run.id,
          stepId: run.currentStepId,
          type: 'model.failed',
          schemaVersion: 1,
          payload: {
            stepId: run.currentStepId,
            durationMs,
            timedOut: timeoutContext.didTimeout(),
            modelTimeoutMs,
            provider: modelProvider,
            model: modelName,
            error: modelError instanceof Error ? modelError.message : String(modelError),
          },
        });
      } catch {
        // best-effort emit; failure here must not mask the original model error
      }
      throw modelError;
    } finally {
      timeoutContext.dispose();
    }

    const durationMs = Date.now() - startedAt;
    this.logLifecycle('debug', 'model.response', {
      ...runLogBindings(run),
      stepId: run.currentStepId,
      durationMs,
      ...summarizeModelResponseForLog(response),
    });

    await this.emit({
      runId: run.id,
      stepId: run.currentStepId,
      type: 'model.completed',
      schemaVersion: 1,
      payload: {
        stepId: run.currentStepId,
        durationMs,
        provider: modelProvider,
        model: modelName,
        finishReason: response.finishReason,
        toolCallCount: response.toolCalls?.length ?? 0,
      },
    });

    if (response.usage) {
      await this.applyUsage(run, response.usage);
    }

    return response;
  }

  private async applyUsage(run: AgentRun, usageDelta: UsageSummary): Promise<AgentRun> {
    let currentRun = run;
    let nextUsage = mergeUsage(currentRun.usage, usageDelta);
    let updatedRun: AgentRun;
    try {
      updatedRun = await this.options.runStore.updateRun(
        currentRun.id,
        {
          usage: nextUsage,
        },
        currentRun.version,
      );
    } catch (error) {
      if (!isOptimisticConcurrencyError(error)) {
        throw error;
      }

      currentRun = await this.refreshRun(run.id);
      nextUsage = mergeUsage(currentRun.usage, usageDelta);
      updatedRun = await this.options.runStore.updateRun(
        currentRun.id,
        {
          usage: nextUsage,
        },
        currentRun.version,
      );
    }

    await this.emit({
      runId: updatedRun.id,
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
    return this.plannerTools;
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
    const completedRun = await this.persistTerminalRunTransition({
      run,
      state,
      patch: {
        status: 'succeeded',
        result: output,
      },
      event: (completedRun) => ({
        runId: completedRun.id,
        stepId: completedRun.currentStepId,
        type: 'run.completed',
        schemaVersion: 1,
        payload: {
          output,
          stepsUsed: state.stepsUsed,
        },
      }),
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
    const failedRun = await this.persistTerminalRunTransition({
      run: currentRun,
      state,
      patch: {
        status: code === 'REPLAN_REQUIRED' ? 'replan_required' : 'failed',
        ...(isDelegateToolCall(state.pendingToolCalls[0]) ? { currentChildRunId: undefined } : {}),
        errorCode: code,
        errorMessage: error,
      },
      event: (failedRun) => ({
        runId: failedRun.id,
        stepId: failedRun.currentStepId,
        type: code === 'REPLAN_REQUIRED' ? 'replan.required' : 'run.failed',
        schemaVersion: 1,
        payload: {
          error,
          code,
        },
      }),
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

  private logInjectedSystemMessage(
    run: AgentRun,
    source: 'initial_prompt' | 'tool_manifest' | 'chat_context' | 'research_policy.require_purpose' | 'tool_budget.checkpoint',
    content: string,
    snapshotField: 'messages' | 'pendingRuntimeMessages',
    stepId?: string,
  ): void {
    this.logLifecycle('info', 'system_message.injected', {
      ...runLogBindings(run),
      stepId,
      source,
      snapshotField,
      snapshotStoreConfigured: Boolean(this.options.snapshotStore),
      content: summarizeValueForLog(content),
    });
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

  private async emitDownstreamOnly(events: Array<Omit<AgentEvent, 'id' | 'seq' | 'createdAt'>>): Promise<void> {
    if (!this.options.eventSink || this.options.eventSink === (this.options.eventStore as unknown as EventSink | undefined)) {
      return;
    }

    for (const event of events) {
      await this.options.eventSink.emit(event);
    }
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

function assertSupportedMvpContinuationStrategy(strategy: ContinuationStrategy): void {
  if (strategy !== 'hybrid_snapshot_then_step') {
    throw new Error(`Continuation strategy ${strategy} is not implemented in the MVP`);
  }
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

function buildRuntimeToolManifestMessage(
  tools: ToolDefinition[],
  formatToolName?: (name: string) => string,
): ModelMessage {
  const manifest = {
    tools: tools.map((tool) => ({
      name: formatToolName ? formatToolName(tool.name) : tool.name,
      kind: tool.name.startsWith(RESERVED_DELEGATE_PREFIX) ? 'delegate' : 'tool',
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    })),
  };

  return {
    role: 'system',
    content: [
      '## Available Tools and Delegates',
      '',
      'The following callable tools are available to this agent through the model tool interface. Use the exact `name` and provide input that satisfies `inputSchema`. Tools whose `kind` is `delegate` start a child run for that delegate profile.',
      '',
      '```json',
      JSON.stringify(manifest, null, 2),
      '```',
    ].join('\n'),
  };
}

function buildInitialMessages(
  run: AgentRun,
  outputSchema?: JsonSchema,
  systemInstructions?: string,
  toolManifestMessage?: ModelMessage,
  images?: ImageInput[],
): ModelMessage[] {
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
    ...(toolManifestMessage ? [toolManifestMessage] : []),
    {
      role: 'user',
      content: buildUserMessageContent(JSON.stringify(requestPayload, null, 2), images),
    },
  ];
}

function buildInitialChatMessages(
  messages: ChatMessage[],
  context?: Record<string, JsonValue>,
  systemInstructions?: string,
  toolManifestMessage?: ModelMessage,
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
    ...(toolManifestMessage ? [toolManifestMessage] : []),
    ...contextMessage,
    ...messages.map((message) => ({
      role: message.role,
      content: buildUserMessageContent(message.content, message.images),
    })),
  ];
}

function buildUserMessageContent(text: string, images?: ImageInput[]): ModelMessageContent {
  if (!images || images.length === 0) {
    return text;
  }

  return [
    { type: 'text', text },
    ...images.map((image): ModelContentPart => ({
      type: 'image',
      image,
    })),
  ];
}

function summarizeImagesForLog(images: ImageInput[] | undefined): JsonValue | undefined {
  if (!images || images.length === 0) {
    return undefined;
  }

  return images.map((image) => ({
    path: image.path,
    mimeType: image.mimeType,
    detail: image.detail,
    name: image.name,
  }));
}

function countChatImages(messages: ChatMessage[]): number {
  return messages.reduce((count, message) => count + (message.images?.length ?? 0), 0);
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
    schemaVersion: EXECUTION_STATE_SCHEMA_VERSION,
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

  if (Object.keys(state.toolBudgetUsage).length > 0) {
    serialized.toolBudgetUsage = state.toolBudgetUsage as unknown as JsonValue;
  }

  if (state.pendingRuntimeMessages.length > 0) {
    serialized.pendingRuntimeMessages = state.pendingRuntimeMessages as unknown as JsonValue;
  }

  return serialized;
}

function deserializeExecutionState(value: JsonValue): ExecutionState | null {
  if (!isJsonObject(value) || !Array.isArray(value.messages) || typeof value.stepsUsed !== 'number') {
    return null;
  }

  if (value.schemaVersion !== undefined && value.schemaVersion !== EXECUTION_STATE_SCHEMA_VERSION) {
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
    toolBudgetUsage: deserializeToolBudgetUsage(value.toolBudgetUsage),
    pendingRuntimeMessages: deserializeModelMessages(value.pendingRuntimeMessages),
  };
}

function deserializeToolBudgetUsage(value: JsonValue | undefined): Record<string, ToolBudgetUsage> {
  if (!isJsonObject(value)) {
    return {};
  }

  const usage: Record<string, ToolBudgetUsage> = {};
  for (const [groupName, entry] of Object.entries(value)) {
    if (!isJsonObject(entry)) {
      continue;
    }

    const calls = typeof entry.calls === 'number' ? entry.calls : 0;
    const consecutiveCalls = typeof entry.consecutiveCalls === 'number' ? entry.consecutiveCalls : 0;
    const checkpointEmitted = entry.checkpointEmitted === true;
    usage[groupName] = {
      calls,
      consecutiveCalls,
      checkpointEmitted,
    };
  }

  return usage;
}

function deserializeModelMessages(value: JsonValue | undefined): ModelMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.reduce<ModelMessage[]>((messages, entry) => {
    if (isModelMessage(entry)) {
      messages.push(entry);
    }
    return messages;
  }, []);
}

function serializePendingToolCall(pendingToolCall: PendingToolCallState): JsonObject {
  return {
    id: pendingToolCall.id,
    name: pendingToolCall.name,
    input: pendingToolCall.input,
    ...(pendingToolCall.assistantContent === undefined ? {} : { assistantContent: pendingToolCall.assistantContent }),
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
    assistantContent: typeof value.assistantContent === 'string' ? value.assistantContent : undefined,
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

function stableJsonFingerprint(value: JsonValue): string {
  return stableJsonStringify(value);
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
    isModelMessageContent(candidate.content) &&
    ['system', 'user', 'assistant', 'tool'].includes(candidate.role) &&
    (candidate.toolCalls === undefined || isModelToolCallArray(candidate.toolCalls)) &&
    (candidate.reasoning === undefined || typeof candidate.reasoning === 'string') &&
    (candidate.reasoningDetails === undefined || isJsonValueArray(candidate.reasoningDetails))
  );
}

function isModelMessageContent(value: unknown): value is ModelMessageContent {
  return typeof value === 'string' || isModelContentPartArray(value);
}

function isModelContentPartArray(value: unknown): value is ModelContentPart[] {
  return Array.isArray(value) && value.every(isModelContentPart);
}

function isModelContentPart(value: unknown): value is ModelContentPart {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.type === 'text') {
    return typeof candidate.text === 'string';
  }

  if (candidate.type === 'image') {
    return isImageInput(candidate.image);
  }

  return false;
}

function isImageInput(value: unknown): value is ImageInput {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.path === 'string' &&
    (candidate.mimeType === undefined || typeof candidate.mimeType === 'string') &&
    (candidate.detail === undefined || ['auto', 'low', 'high'].includes(String(candidate.detail))) &&
    (candidate.name === undefined || typeof candidate.name === 'string')
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
    reasoning: response.reasoning,
    reasoningDetails: response.reasoningDetails,
  };
}

function isModelToolCallArray(value: unknown): value is ModelMessage['toolCalls'] {
  return Array.isArray(value) && value.every(isModelToolCall);
}

function isModelToolCall(value: unknown): value is ModelToolCall {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string' && typeof candidate.name === 'string' && 'input' in candidate;
}

function createPendingToolCalls(
  toolCalls: ModelResponse['toolCalls'],
  nextStepNumber: number,
  assistantContent?: string,
): PendingToolCallState[] {
  if (!toolCalls) {
    return [];
  }

  return toolCalls.map((toolCall, index) => ({
    id: toolCall.id,
    name: toolCall.name,
    input: toolCall.input,
    assistantContent,
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

function boundedLevenshteinDistance(left: string, right: string, maxDistance: number): number | undefined {
  const lengthDelta = Math.abs(left.length - right.length);
  if (lengthDelta > maxDistance) {
    return undefined;
  }

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = new Array<number>(right.length + 1);

  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    let rowMin = current[0];

    for (let j = 1; j <= right.length; j += 1) {
      const substitutionCost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + substitutionCost,
      );
      rowMin = Math.min(rowMin, current[j]);
    }

    if (rowMin > maxDistance) {
      return undefined;
    }

    for (let j = 0; j <= right.length; j += 1) {
      previous[j] = current[j];
    }
  }

  const distance = previous[right.length] ?? 0;
  return distance <= maxDistance ? distance : undefined;
}

function isJsonValueArray(value: unknown): value is JsonValue[] {
  return Array.isArray(value) && value.every(isJsonValueLike);
}

function isJsonValueLike(value: unknown): value is JsonValue {
  if (value === null) {
    return true;
  }

  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return true;
    case 'object':
      if (Array.isArray(value)) {
        return value.every(isJsonValueLike);
      }

      return Object.values(value as Record<string, unknown>).every(isJsonValueLike);
    default:
      return false;
  }
}

function emptyToolBudgetUsage(): ToolBudgetUsage {
  return {
    calls: 0,
    consecutiveCalls: 0,
    checkpointEmitted: false,
  };
}

function normalizeBudgetLimit(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function resetBudgetConsecutiveCalls(
  usageByGroup: Record<string, ToolBudgetUsage>,
  activeGroup?: string,
): void {
  for (const [groupName, usage] of Object.entries(usageByGroup)) {
    if (activeGroup && groupName === activeGroup) {
      continue;
    }

    usage.consecutiveCalls = 0;
  }
}

function createBudgetExhaustedToolOutput(
  toolName: string,
  budgetGroup: string,
  action: ToolBudget['onExhausted'],
): JsonObject {
  const message =
    action === 'continue_with_warning'
      ? `The ${budgetGroup} budget is exhausted. Do not call ${toolName} again in this run.`
      : `The ${budgetGroup} budget is exhausted. Answer from the current evidence or explain what remains uncertain instead of calling ${toolName} again.`;

  return {
    status: 'partial',
    reason: 'budget_exhausted',
    toolName,
    budgetGroup,
    message,
  };
}

function isMissingWebSearchPurpose(input: JsonValue): boolean {
  if (!isJsonObject(input)) {
    return true;
  }

  const purpose = input.purpose;
  return typeof purpose !== 'string' || purpose.trim().length === 0;
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

function isDelegateToolCall(pendingToolCall: PendingToolCallState | undefined): pendingToolCall is PendingToolCallState {
  return Boolean(pendingToolCall?.name.startsWith(RESERVED_DELEGATE_PREFIX));
}

function toolCallIdempotencyKey(runId: UUID, stepId: string, toolCallId: string): string {
  return `${runId}:${stepId}:${toolCallId}`;
}

function mergeSteerMetadata(
  baseMetadata: JsonObject | undefined,
  routingMetadata: JsonObject | undefined,
): JsonObject | undefined {
  if (!baseMetadata && !routingMetadata) {
    return undefined;
  }

  return {
    ...(baseMetadata ?? {}),
    ...(routingMetadata ?? {}),
  };
}

function inferSteerRequiredTools(message: string): string[] {
  const requiredTools = new Set<string>();

  for (const hint of STEER_TOOL_HINTS) {
    if (hint.patterns.some((pattern) => pattern.test(message))) {
      requiredTools.add(hint.toolName);
    }
  }

  return [...requiredTools];
}

function validateLinkedChildRun(parentRun: AgentRun, childRun: AgentRun, stepId: string): string | null {
  if (childRun.parentRunId !== parentRun.id) {
    return `Child run ${childRun.id} is not linked to parent run ${parentRun.id}`;
  }

  if (childRun.rootRunId !== parentRun.rootRunId) {
    return `Child run ${childRun.id} root ${childRun.rootRunId} does not match parent root ${parentRun.rootRunId}`;
  }

  if (childRun.parentStepId && childRun.parentStepId !== stepId) {
    return `Child run ${childRun.id} parent step ${childRun.parentStepId} does not match parent step ${stepId}`;
  }

  return null;
}

function shouldResolveWaitingDelegateSnapshot(state: ExecutionState): boolean {
  const pendingToolCall = state.pendingToolCalls[0];
  return Boolean(
    state.waitingOnChildRunId &&
      isDelegateToolCall(pendingToolCall),
  );
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function removeUndefinedJsonFields(value: Record<string, JsonValue | undefined>): JsonObject {
  const result: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      result[key] = entry;
    }
  }

  return result;
}

function readPendingSteerMessagesFromMetadata(
  metadata: Record<string, JsonValue> | undefined,
): PendingSteerMessage[] {
  if (!metadata) {
    return [];
  }
  const raw = metadata[STEER_METADATA_KEY];
  if (!Array.isArray(raw)) {
    return [];
  }
  const result: PendingSteerMessage[] = [];
  for (const entry of raw) {
    if (!isJsonObject(entry)) {
      continue;
    }
    const role = entry.role;
    const content = entry.content;
    if ((role !== 'user' && role !== 'system') || typeof content !== 'string') {
      continue;
    }
    const enqueuedAt = typeof entry.enqueuedAt === 'string' ? entry.enqueuedAt : new Date().toISOString();
    const metadataField = isJsonObject(entry.metadata) ? entry.metadata : undefined;
    result.push({
      role,
      content,
      enqueuedAt,
      ...(metadataField ? { metadata: metadataField } : {}),
    });
  }
  return result;
}

function isOptimisticConcurrencyError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.name === 'OptimisticConcurrencyError' ||
      error.name === 'PostgresOptimisticConcurrencyError' ||
      error.message.includes('version mismatch'))
  );
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
    for (const [key, value] of Object.entries(template as Record<string, unknown>)) {
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

function readRetryAttempts(metadata?: Record<string, JsonValue>): number {
  const attempts = metadata?.retryAttempts;
  return typeof attempts === 'number' && Number.isFinite(attempts) && attempts > 0 ? attempts : 0;
}

function classifyFailureKind(code?: RunFailureCode, message?: string): FailureKind {
  if (code === 'MAX_STEPS') {
    return 'max_steps';
  }

  if (code === 'APPROVAL_REJECTED') {
    return 'approval_rejected';
  }

  const normalized = (message ?? '').toLowerCase();
  if (normalized.includes('timed out') || normalized.includes('timeout') || /\b524\b/.test(normalized)) {
    return 'timeout';
  }

  if (
    normalized.includes('network') ||
    normalized.includes('econnreset') ||
    normalized.includes('econnrefused') ||
    normalized.includes('enotfound') ||
    normalized.includes('fetch failed') ||
    normalized.includes('socket') ||
    normalized.includes('connection')
  ) {
    return 'network';
  }

  if (normalized.includes('rate limit') || normalized.includes('429')) {
    return 'rate_limit';
  }

  if (
    normalized.includes('enoent') ||
    normalized.includes('no such file or directory') ||
    normalized.includes('not found')
  ) {
    return 'not_found';
  }

  if (
    normalized.includes('provider') ||
    normalized.includes('finishreason=error') ||
    normalized.includes('5xx') ||
    normalized.includes('500') ||
    normalized.includes('502') ||
    normalized.includes('503') ||
    normalized.includes('504')
  ) {
    return 'provider_error';
  }

  if (code === 'TOOL_ERROR') {
    return 'tool_error';
  }

  return 'unknown';
}

function isRetryableModelFailureKind(failureKind: FailureKind): boolean {
  return failureKind === 'timeout' || failureKind === 'network' || failureKind === 'rate_limit' || failureKind === 'provider_error';
}

function toolRetryPolicyAllows(tool: ToolDefinition, failureKind: FailureKind): boolean {
  const retryOn = tool.retryPolicy?.retryOn;
  if (!retryOn || retryOn.length === 0) {
    return isRetryableModelFailureKind(failureKind);
  }

  return retryOn.includes(failureKind);
}

function mergeDelegateDefaults(
  parentDefaults: AdaptiveAgentOptions['defaults'],
  delegateDefaults: NonNullable<AdaptiveAgentOptions['delegates']>[number]['defaults'],
): AdaptiveAgentOptions['defaults'] {
  const defaults = { ...parentDefaults, ...delegateDefaults };
  if (parentDefaults?.maxSteps !== undefined) {
    defaults.maxSteps = Math.max(parentDefaults.maxSteps, delegateDefaults?.maxSteps ?? parentDefaults.maxSteps);
  }
  defaults.researchPolicy = parentDefaults?.researchPolicy ?? delegateDefaults?.researchPolicy;
  defaults.toolBudgets = mergeDelegateToolBudgets(parentDefaults?.toolBudgets, delegateDefaults?.toolBudgets);
  return defaults;
}

function mergeDelegateToolBudgets(
  parentBudgets: Record<string, ToolBudget> | undefined,
  delegateBudgets: Record<string, ToolBudget> | undefined,
): Record<string, ToolBudget> | undefined {
  if (!parentBudgets && !delegateBudgets) {
    return undefined;
  }

  const merged: Record<string, ToolBudget> = {
    ...(parentBudgets ?? {}),
  };

  for (const [groupName, budget] of Object.entries(delegateBudgets ?? {})) {
    if (!merged[groupName]) {
      merged[groupName] = budget;
    }
  }

  return merged;
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

function summarizeModelFailureForLog(
  error: unknown,
  options: { modelTimeoutMs: number; timedOut: boolean },
): Record<string, JsonValue | undefined> {
  return {
    failurePhase: extractErrorField(error, 'modelInvocationPhase') as string | undefined,
    failureAttempt: extractNumericErrorField(error, 'modelInvocationAttempt'),
    statusCode: extractNumericErrorField(error, 'modelInvocationStatusCode'),
    retryDelayMs: extractNumericErrorField(error, 'modelInvocationRetryDelayMs'),
    timeoutSource: options.timedOut ? 'agent_model_timeout' : undefined,
    configuredModelTimeoutMs: options.timedOut ? options.modelTimeoutMs : undefined,
  };
}

function extractNumericErrorField(error: unknown, key: string): number | undefined {
  const value = extractErrorField(error, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function extractErrorField(error: unknown, key: string): unknown {
  let current: unknown = error;

  while (current instanceof Error) {
    const value = (current as Record<string, unknown>)[key];
    if (value !== undefined) {
      return value;
    }

    current = (current as Error & { cause?: unknown }).cause;
  }

  return undefined;
}
