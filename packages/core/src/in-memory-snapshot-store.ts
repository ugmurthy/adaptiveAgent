import type { RunSnapshot, SnapshotStore, UUID } from './types.js';

function cloneSnapshot(snapshot: RunSnapshot): RunSnapshot {
  return structuredClone(snapshot);
}

export class InMemorySnapshotStore implements SnapshotStore {
  private readonly snapshotsByRun = new Map<UUID, RunSnapshot[]>();

  async save(snapshot: Omit<RunSnapshot, 'id' | 'createdAt'>): Promise<RunSnapshot> {
    const snapshots = this.snapshotsByRun.get(snapshot.runId) ?? [];
    if (snapshots.some((existing) => existing.snapshotSeq === snapshot.snapshotSeq)) {
      throw new Error(`Snapshot ${snapshot.runId}@${snapshot.snapshotSeq} already exists`);
    }

    const nextSnapshot: RunSnapshot = {
      ...snapshot,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };

    snapshots.push(nextSnapshot);
    snapshots.sort((left, right) => left.snapshotSeq - right.snapshotSeq);
    this.snapshotsByRun.set(snapshot.runId, snapshots);
    return cloneSnapshot(nextSnapshot);
  }

  async getLatest(runId: UUID): Promise<RunSnapshot | null> {
    const snapshots = this.snapshotsByRun.get(runId) ?? [];
    const latest = snapshots[snapshots.length - 1];
    return latest ? cloneSnapshot(latest) : null;
  }
}
