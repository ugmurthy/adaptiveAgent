import { describe, expect, it, vi } from 'vitest';

import { runBulletinPipeline } from './pipeline.ts';
import { loadDataset } from './data-source.ts';

describe('--no-network mode', () => {
  it('runs end-to-end with allowNetwork=false using bundled fixtures', async () => {
    const result = await runBulletinPipeline({
      date: '2026-04-28',
      iterations: 200,
      seed: 1,
      allowNetwork: false,
    });
    expect(result.html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(result.structured.pointsTable.teams.length).toBe(10);
  });

  it('does not invoke the injected fetchImpl when allowNetwork=false', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('fetch must not be called in --no-network mode');
    });
    const result = await runBulletinPipeline({
      date: '2026-04-28',
      iterations: 100,
      seed: 1,
      allowNetwork: false,
      baseUrl: 'https://should-not-be-used.invalid',
      fetchImpl: fetchSpy as any,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.structured.pointsTable.teams.length).toBe(10);
  });

  it('fails with a clear, actionable error when fixture is missing under --no-network', async () => {
    await expect(
      loadDataset('does-not-exist.json', { allowNetwork: false }),
    ).rejects.toThrow(/--no-network mode requires fixture/);
  });

  it('produces a bulletin even when CRICKET_DATA_BASE_URL is set, since allowNetwork=false overrides it', async () => {
    const fetchSpy = vi.fn();
    const result = await runBulletinPipeline({
      date: '2026-04-28',
      iterations: 100,
      seed: 1,
      allowNetwork: false,
      baseUrl: 'https://cricket-data.example.invalid',
      fetchImpl: fetchSpy as any,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.structured.pointsTable.tournament).toBe('IPL 2026');
  });
});
