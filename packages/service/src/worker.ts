import type { JobRunRole, JobState, JsonValue, ServiceError, ServiceResult } from '@adaptive-agent/service-sdk';
import type { ClaimedJob, ClaimResult } from './postgres.js';

export interface ExecutionOutcome {
  state: JobState;
  result?: ServiceResult;
  error?: ServiceError;
  runs?: Array<{ runId: string; role: JobRunRole }>;
  deferred?: boolean;
}
export interface WorkloadExecutor {
  execute(claim: ClaimedJob): Promise<ExecutionOutcome>;
  close(): Promise<void>;
}

export interface AgentWorkerStore {
  claim(jobId: string): Promise<ClaimResult>;
  link(jobId: string, runId: string, role: JobRunRole): Promise<void>;
  complete(claim: Pick<ClaimedJob, 'job' | 'commandVersion' | 'command' | 'leaseOwner'>, state: JobState, result?: ServiceResult, error?: ServiceError): Promise<boolean>;
  defer(claim: Pick<ClaimedJob, 'job' | 'commandVersion' | 'leaseOwner'>, state: JobState): Promise<void>;
}

export class AgentWorker {
  private stopping = false;
  private readonly active = new Set<Promise<void>>();
  constructor(private readonly store: AgentWorkerStore, private readonly executor: WorkloadExecutor) {}

  async process(payload: { jobId: string }): Promise<void> {
    if (this.stopping) throw new Error('Worker is shutting down');
    const task = this.processClaim(payload.jobId);
    this.active.add(task);
    try { await task; } finally { this.active.delete(task); }
  }

  async close(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.active]);
    await this.executor.close();
  }

  private async processClaim(jobId: string): Promise<void> {
    const claimed = await this.store.claim(jobId);
    if (claimed.action === 'ack') return;
    const { job } = claimed.claim;
    try {
      const outcome = await this.executor.execute(claimed.claim);
      for (const run of outcome.runs ?? []) await this.store.link(job.id, run.runId, run.role);
      if (outcome.deferred) {
        await this.store.defer(claimed.claim, outcome.state);
        return;
      }
      await this.store.complete(claimed.claim, outcome.state, outcome.result, outcome.error ? toPublicServiceError(outcome.error) : undefined);
    } catch (error) {
      await this.store.complete(claimed.claim, 'failed', undefined, toPublicServiceError(error));
      throw error;
    }
  }
}

export function toPublicServiceError(error: unknown): ServiceError {
  if (isServiceError(error)) {
    return { schemaVersion: 1, code: safeCode(error.code), message: 'Agent execution failed.', retryable: error.retryable };
  }
  return { schemaVersion: 1, code: 'worker_execution_failed', message: 'Agent execution failed.', retryable: true };
}

function isServiceError(error: unknown): error is ServiceError { return Boolean(error && typeof error === 'object' && 'code' in error && 'retryable' in error); }
function safeCode(code: string): string { return /^[a-z0-9][a-z0-9_.-]{0,99}$/i.test(code) ? code : 'agent_execution_failed'; }

export function serviceResult(value: JsonValue): ServiceResult {
  return { schemaVersion: 1, value, completedAt: new Date().toISOString() };
}
