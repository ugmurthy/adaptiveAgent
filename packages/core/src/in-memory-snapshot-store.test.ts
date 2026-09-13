import { describe, expect, it } from 'vitest';

import { InMemorySnapshotStore } from './in-memory-snapshot-store.js';

describe('InMemorySnapshotStore', () => {
  it('retains the highest sequence while rejecting every previously saved sequence', async () => {
    const store = new InMemorySnapshotStore();
    const snapshot = (snapshotSeq: number, marker: string) => ({
      runId: 'run-1',
      snapshotSeq,
      status: 'running' as const,
      summary: { marker },
      state: { marker },
    });

    await store.save(snapshot(2, 'latest'));
    await store.save(snapshot(1, 'older'));

    expect(await store.getLatest('run-1')).toMatchObject({
      snapshotSeq: 2,
      state: { marker: 'latest' },
    });
    await expect(store.save(snapshot(1, 'duplicate'))).rejects.toThrow(
      'Snapshot run-1@1 already exists',
    );
  });
});
