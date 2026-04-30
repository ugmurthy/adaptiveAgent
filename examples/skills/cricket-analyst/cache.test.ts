import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { withCache, cachePath, readCache, writeCache } from './cache.ts';
import { getPointsTable } from './points-table.ts';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'cricket-cache-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('cache primitives', () => {
  it('returns undefined on cold cache', async () => {
    const value = await readCache('points_table', { v: 1 }, { cacheRoot: tmp });
    expect(value).toBeUndefined();
  });

  it('round-trips a value through the filesystem', async () => {
    await writeCache('points_table', { v: 1 }, { hello: 'world' }, { cacheRoot: tmp });
    const back = await readCache<{ hello: string }>('points_table', { v: 1 }, { cacheRoot: tmp });
    expect(back).toEqual({ hello: 'world' });
  });

  it('expires entries past TTL', async () => {
    const path = cachePath('points_table', { v: 1 }, { cacheRoot: tmp });
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify({ stale: true }), 'utf-8');

    // Force a 'now' far in the future so TTL is exceeded
    const value = await readCache('points_table', { v: 1 }, {
      cacheRoot: tmp,
      now: () => Date.now() + 24 * 60 * 60 * 1000 * 7,
    });
    expect(value).toBeUndefined();
  });

  it('writes are skipped when enabled=false', async () => {
    await writeCache('points_table', { v: 1 }, { hi: true }, { cacheRoot: tmp, enabled: false });
    const back = await readCache('points_table', { v: 1 }, { cacheRoot: tmp });
    expect(back).toBeUndefined();
  });
});

describe('withCache short-circuits the fetcher on cache hit', () => {
  it('does not call the fetcher when a fresh entry exists', async () => {
    await writeCache('points_table', { v: 1 }, { from: 'cache' }, { cacheRoot: tmp });

    let fetcherCalls = 0;
    const result = await withCache(
      'points_table',
      { v: 1 },
      { cacheRoot: tmp },
      async () => {
        fetcherCalls++;
        return { from: 'fetcher' };
      },
    );

    expect(fetcherCalls).toBe(0);
    expect(result).toEqual({ from: 'cache' });
  });

  it('calls the fetcher exactly once on cold cache and caches the result', async () => {
    let fetcherCalls = 0;
    const fetcher = async () => {
      fetcherCalls++;
      return { from: 'fetcher', n: fetcherCalls };
    };

    const first = await withCache('points_table', { v: 1 }, { cacheRoot: tmp }, fetcher);
    const second = await withCache('points_table', { v: 1 }, { cacheRoot: tmp }, fetcher);

    expect(fetcherCalls).toBe(1);
    expect(first).toEqual({ from: 'fetcher', n: 1 });
    expect(second).toEqual({ from: 'fetcher', n: 1 });
  });
});

describe('points-table integration with cache pre-population', () => {
  it('a cache-only fetch performs no outbound HTTP', async () => {
    // Pre-populate cache with a marker payload
    const cachedPayload = {
      tournament: 'IPL 2026 (cached)',
      asOf: '2026-04-28',
      teams: [
        { name: 'Cached Team', code: 'CT', played: 1, wins: 1, losses: 0, points: 2, nrr: 0.5 },
      ],
    };

    // The points-table action loads via loadDataset and is not cache-aware yet
    // (cache integration into the actions is a host-side concern; this test
    // documents that primitives compose correctly on top of getPointsTable).
    const result = await withCache(
      'points_table',
      { source: 'fixture' },
      { cacheRoot: tmp },
      () => getPointsTable({
        dataSource: { 'ipl-2026-points-table.json': cachedPayload },
        fetchImpl: (() => {
          throw new Error('fetch should not be called for fixture path');
        }) as any,
      }),
    );

    expect(result.tournament).toBe('IPL 2026 (cached)');
    expect(result.teams[0].code).toBe('CT');

    // A second call should be served from withCache without re-invoking getPointsTable
    let inner = 0;
    const second = await withCache(
      'points_table',
      { source: 'fixture' },
      { cacheRoot: tmp },
      async () => {
        inner++;
        return cachedPayload;
      },
    );
    expect(inner).toBe(0);
    expect(second.tournament).toBe('IPL 2026 (cached)');
  });
});
