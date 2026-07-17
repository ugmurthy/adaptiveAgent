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
      await this.store.complete(claimed.claim, outcome.state, outcome.result, outcome.error);
    } catch (error) {
      await this.store.complete(claimed.claim, 'failed', undefined, {
        schemaVersion: 1, code: 'worker_execution_failed', message: safeMessage(error), retryable: true,
      });
      throw error;
    }
  }
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:postgres(?:ql)?:\/\/)[^@\s]+@/gi, 'postgres://[redacted]@').slice(0, 2_000);
}

export function serviceResult(value: JsonValue): ServiceResult {
  return { schemaVersion: 1, value, completedAt: new Date().toISOString() };
}
