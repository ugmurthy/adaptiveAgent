import type { RunSnapshot, SnapshotStore, UUID } from './types.js';

function cloneSnapshot(snapshot: RunSnapshot): RunSnapshot {
  return structuredClone(snapshot);
}

export class InMemorySnapshotStore implements SnapshotStore {
  private readonly latestSnapshotByRun = new Map<UUID, RunSnapshot>();
  private readonly snapshotSequencesByRun = new Map<UUID, Set<number>>();

  async save(snapshot: Omit<RunSnapshot, 'id' | 'createdAt'>): Promise<RunSnapshot> {
    const sequences = this.snapshotSequencesByRun.get(snapshot.runId) ?? new Set<number>();
    if (sequences.has(snapshot.snapshotSeq)) {
      throw new Error(`Snapshot ${snapshot.runId}@${snapshot.snapshotSeq} already exists`);
    }

    const nextSnapshot: RunSnapshot = {
      ...snapshot,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };

    sequences.add(nextSnapshot.snapshotSeq);
    this.snapshotSequencesByRun.set(snapshot.runId, sequences);
    const latest = this.latestSnapshotByRun.get(snapshot.runId);
    if (!latest || nextSnapshot.snapshotSeq > latest.snapshotSeq) {
      this.latestSnapshotByRun.set(snapshot.runId, nextSnapshot);
    }
    return cloneSnapshot(nextSnapshot);
  }

  async getLatest(runId: UUID): Promise<RunSnapshot | null> {
    const latest = this.latestSnapshotByRun.get(runId);
    return latest ? cloneSnapshot(latest) : null;
  }
}
