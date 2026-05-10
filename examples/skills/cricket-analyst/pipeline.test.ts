import { describe, expect, it } from 'vitest';

import { runBulletinPipeline } from './pipeline.ts';

describe('runBulletinPipeline (E2E offline)', () => {
  it('runs end-to-end against frozen 2026-04-28 fixture data', async () => {
    const start = Date.now();
    const result = await runBulletinPipeline({
      date: '2026-04-28',
      iterations: 2000,
      seed: 42,
      allowNetwork: false,
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5000);
    expect(result.html.length).toBeGreaterThan(500);
  });

  it('contains all 10 IPL teams in the points table', async () => {
    const result = await runBulletinPipeline({
      date: '2026-04-28',
      iterations: 500,
      seed: 1,
      allowNetwork: false,
    });
    expect(result.structured.pointsTable.teams).toHaveLength(10);
    const codes = result.structured.pointsTable.teams.map((t) => t.code).sort();
    expect(codes).toEqual(['CSK', 'DC', 'GT', 'KKR', 'LSG', 'MI', 'PBKS', 'RCB', 'RR', 'SRH']);
  });

  it('winnerProb sums to within 1e-2 of 1.0', async () => {
    const result = await runBulletinPipeline({
      date: '2026-04-28',
      iterations: 2000,
      seed: 42,
      allowNetwork: false,
    });
    const total = Object.values(result.structured.predictions.winnerProb).reduce((a, b) => a + b, 0);
    expect(Math.abs(total - 1)).toBeLessThan(0.01);
  });

  it('playoffProb values are all in [0,1]', async () => {
    const result = await runBulletinPipeline({
      date: '2026-04-28',
      iterations: 1000,
      seed: 1,
      allowNetwork: false,
    });
    for (const v of Object.values(result.structured.predictions.playoffProb)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('HTML is well-formed (balanced tags + DOCTYPE)', async () => {
    const result = await runBulletinPipeline({
      date: '2026-04-28',
      iterations: 200,
      seed: 1,
      allowNetwork: false,
    });
    expect(result.html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(result.html.trimEnd().endsWith('</html>')).toBe(true);
    // Balanced <html> and <body> tags
    expect((result.html.match(/<html\b/g) ?? []).length).toBe(1);
    expect((result.html.match(/<\/html>/g) ?? []).length).toBe(1);
    expect((result.html.match(/<body\b/g) ?? []).length).toBe(1);
    expect((result.html.match(/<\/body>/g) ?? []).length).toBe(1);
  });

  it('seeded runs produce identical structured output', async () => {
    const a = await runBulletinPipeline({
      date: '2026-04-28', iterations: 500, seed: 99, allowNetwork: false,
    });
    const b = await runBulletinPipeline({
      date: '2026-04-28', iterations: 500, seed: 99, allowNetwork: false,
    });
    expect(a.structured.predictions.winnerProb).toEqual(b.structured.predictions.winnerProb);
  });
});
