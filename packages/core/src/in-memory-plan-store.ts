import type { PlanArtifact, PlanExecution, PlanExecutionStatus, PlanStore, UUID } from './types.js';

const TERMINAL_PLAN_EXECUTION_STATUSES = new Set<PlanExecutionStatus>([
  'succeeded',
  'failed',
  'replan_required',
  'cancelled',
]);

function clonePlan(plan: PlanArtifact): PlanArtifact {
  return structuredClone(plan);
}

function cloneExecution(execution: PlanExecution): PlanExecution {
  return structuredClone(execution);
}

function toIsoString(date: Date): string {
  return date.toISOString();
}

export class InMemoryPlanStore implements PlanStore {
  private readonly plans = new Map<UUID, PlanArtifact>();
  private readonly executions = new Map<UUID, PlanExecution>();

  async createPlan(plan: Omit<PlanArtifact, 'createdAt' | 'archivedAt'>): Promise<PlanArtifact> {
    if (this.plans.has(plan.id)) {
      throw new Error(`Plan ${plan.id} already exists`);
    }

    const storedPlan: PlanArtifact = {
      ...structuredClone(plan),
      createdAt: toIsoString(new Date()),
    };
    this.plans.set(storedPlan.id, storedPlan);
    return clonePlan(storedPlan);
  }

  async getPlan(planId: UUID): Promise<PlanArtifact | null> {
    const plan = this.plans.get(planId);
    return plan ? clonePlan(plan) : null;
  }

  async listSteps(planId: UUID) {
    const plan = this.plans.get(planId);
    return plan ? structuredClone(plan.steps) : [];
  }

  async createExecution(execution: Omit<PlanExecution, 'createdAt' | 'updatedAt'>): Promise<PlanExecution> {
    if (this.executions.has(execution.id)) {
      throw new Error(`Plan execution ${execution.id} already exists`);
    }

    if (!this.plans.has(execution.planId)) {
      throw new Error(`Plan ${execution.planId} does not exist`);
    }

    const now = new Date();
    const storedExecution: PlanExecution = {
      ...structuredClone(execution),
      createdAt: toIsoString(now),
      updatedAt: toIsoString(now),
      completedAt: TERMINAL_PLAN_EXECUTION_STATUSES.has(execution.status) ? toIsoString(now) : undefined,
    };
    this.executions.set(storedExecution.id, storedExecution);
    return cloneExecution(storedExecution);
  }

  async getExecution(executionId: UUID): Promise<PlanExecution | null> {
    const execution = this.executions.get(executionId);
    return execution ? cloneExecution(execution) : null;
  }

  async updateExecution(executionId: UUID, patch: Partial<PlanExecution>): Promise<PlanExecution> {
    const current = this.executions.get(executionId);
    if (!current) {
      throw new Error(`Plan execution ${executionId} does not exist`);
    }

    if (patch.id && patch.id !== executionId) {
      throw new Error('Plan execution IDs are immutable');
    }

    if (patch.planId && patch.planId !== current.planId) {
      throw new Error('planId is immutable');
    }

    if (patch.runId && patch.runId !== current.runId) {
      throw new Error('runId is immutable');
    }

    const now = new Date();
    const nextStatus = patch.status ?? current.status;
    const nextExecution: PlanExecution = {
      ...current,
      ...patch,
      updatedAt: toIsoString(now),
      completedAt:
        patch.completedAt ??
        current.completedAt ??
        (TERMINAL_PLAN_EXECUTION_STATUSES.has(nextStatus) ? toIsoString(now) : undefined),
    };
    this.executions.set(executionId, nextExecution);
    return cloneExecution(nextExecution);
  }
}
