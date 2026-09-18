import type { OrchestrationExecution, OrchestrationStage, OrchestrationStore } from './types.js';

export class OrchestrationOptimisticConcurrencyError extends Error {
  constructor(message: string) { super(message); this.name = 'OrchestrationOptimisticConcurrencyError'; }
}

export class InMemoryOrchestrationStore implements OrchestrationStore {
  private readonly executions = new Map<string, OrchestrationExecution>();
  private readonly stages = new Map<string, Map<string, OrchestrationStage>>();

  async createExecution(input: Parameters<OrchestrationStore['createExecution']>[0]): Promise<OrchestrationExecution> {
    const id = input.id ?? crypto.randomUUID();
    if (this.executions.has(id)) throw new Error(`Orchestration execution ${id} already exists`);
    const nodeIds = new Set(input.stages.map((stage) => stage.nodeId));
    if (nodeIds.size !== input.stages.length) throw new Error('Orchestration stage nodeIds must be unique');
    for (const stage of input.stages) for (const dependency of stage.dependencies ?? []) {
      if (!nodeIds.has(dependency)) throw new Error(`Unknown stage dependency ${dependency}`);
    }
    const now = new Date().toISOString();
    const execution: OrchestrationExecution = { id, status: input.status ?? 'routing', request: structuredClone(input.request), catalogFingerprint: input.catalogFingerprint, plan: structuredClone(input.plan), version: 0, createdAt: now, updatedAt: now };
    this.executions.set(id, execution);
    this.stages.set(id, new Map(input.stages.map((stage) => [stage.nodeId, {
      executionId: id, runId: stage.runId, nodeId: stage.nodeId, agentId: stage.agentId,
      status: stage.status ?? 'queued', dependencies: [...(stage.dependencies ?? [])],
      upstreamRunIds: [...(stage.upstreamRunIds ?? [])], version: 0, createdAt: now, updatedAt: now,
    }])));
    return structuredClone(execution);
  }
  async getExecution(id: string) { return cloneNullable(this.executions.get(id) ?? null); }
  async updateExecution(id: string, patch: Partial<Pick<OrchestrationExecution, 'status'>>, expectedVersion: number) {
    const current = this.requireExecution(id);
    if (current.version !== expectedVersion) throw new OrchestrationOptimisticConcurrencyError(`Orchestration execution ${id} version mismatch`);
    const now = new Date().toISOString();
    const terminal = patch.status && ['succeeded', 'failed', 'cancelled'].includes(patch.status);
    const next = { ...current, ...patch, version: current.version + 1, updatedAt: now, completedAt: terminal ? (current.completedAt ?? now) : current.completedAt };
    this.executions.set(id, next); return structuredClone(next);
  }
  async listStages(id: string): Promise<OrchestrationStage[]> { return [...(this.stages.get(id)?.values() ?? [])].sort((a,b) => a.nodeId.localeCompare(b.nodeId)).map((stage) => structuredClone(stage)); }
  async updateStage(id: string, nodeId: string, patch: Partial<Pick<OrchestrationStage, 'status' | 'upstreamRunIds'>>, expectedVersion: number) {
    const current = this.requireStage(id, nodeId);
    if (current.version !== expectedVersion) throw new OrchestrationOptimisticConcurrencyError(`Orchestration stage ${nodeId} version mismatch`);
    const now = new Date().toISOString(); const status = patch.status ?? current.status;
    const next = { ...current, ...structuredClone(patch), version: current.version + 1, updatedAt: now,
      startedAt: status === 'running' ? (current.startedAt ?? now) : current.startedAt,
      completedAt: ['succeeded','failed','cancelled','skipped'].includes(status) ? (current.completedAt ?? now) : current.completedAt };
    this.stages.get(id)!.set(nodeId, next); return structuredClone(next);
  }
  async claimReadyStage(id: string) {
    const execution = this.requireExecution(id);
    if (!['routing', 'running'].includes(execution.status)) return null;
    const stages = this.stages.get(id)!;
    const ready = [...stages.values()].sort((a,b) => a.nodeId.localeCompare(b.nodeId)).find(stage => stage.status === 'queued' && stage.dependencies.every(dep => ['succeeded','failed','skipped'].includes(stages.get(dep)?.status ?? '')));
    return ready ? this.updateStage(id, ready.nodeId, { status: 'running' }, ready.version) : null;
  }
  private requireExecution(id: string) { const value = this.executions.get(id); if (!value) throw new Error(`Orchestration execution ${id} not found`); return value; }
  private requireStage(id: string, nodeId: string) { const value = this.stages.get(id)?.get(nodeId); if (!value) throw new Error(`Orchestration stage ${nodeId} not found`); return value; }
}
function cloneNullable<T>(value: T | null): T | null { return value === null ? null : structuredClone(value); }
