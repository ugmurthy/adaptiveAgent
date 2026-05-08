import type { ContinuationStore, RunContinuation, UUID } from './types.js';

function cloneContinuation(continuation: RunContinuation): RunContinuation {
  return structuredClone(continuation);
}

export class InMemoryContinuationStore implements ContinuationStore {
  private readonly continuations = new Map<UUID, RunContinuation>();
  private readonly continuationIdsBySourceRun = new Map<UUID, UUID[]>();
  private readonly continuationIdByRun = new Map<UUID, UUID>();

  async createContinuation(
    continuation: Omit<RunContinuation, 'id' | 'createdAt'>,
  ): Promise<RunContinuation> {
    if (this.continuationIdByRun.has(continuation.continuationRunId)) {
      throw new Error(`Continuation run ${continuation.continuationRunId} is already linked`);
    }

    const storedContinuation: RunContinuation = {
      ...structuredClone(continuation),
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };

    this.continuations.set(storedContinuation.id, storedContinuation);
    this.continuationIdByRun.set(storedContinuation.continuationRunId, storedContinuation.id);

    const sourceContinuations = this.continuationIdsBySourceRun.get(storedContinuation.sourceRunId) ?? [];
    sourceContinuations.push(storedContinuation.id);
    this.continuationIdsBySourceRun.set(storedContinuation.sourceRunId, sourceContinuations);

    return cloneContinuation(storedContinuation);
  }

  async listBySourceRun(sourceRunId: UUID): Promise<RunContinuation[]> {
    const continuationIds = this.continuationIdsBySourceRun.get(sourceRunId) ?? [];
    return continuationIds
      .map((continuationId) => this.continuations.get(continuationId))
      .filter((continuation): continuation is RunContinuation => Boolean(continuation))
      .map(cloneContinuation);
  }

  async getByContinuationRun(continuationRunId: UUID): Promise<RunContinuation | null> {
    const continuationId = this.continuationIdByRun.get(continuationRunId);
    if (!continuationId) {
      return null;
    }

    const continuation = this.continuations.get(continuationId);
    return continuation ? cloneContinuation(continuation) : null;
  }
}
