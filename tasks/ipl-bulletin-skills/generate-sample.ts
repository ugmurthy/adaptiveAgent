#!/usr/bin/env bun
/**
 * Reproducibly generates the sample bulletin artifact at
 * tasks/ipl-bulletin-skills/sample-bulletin.html. Run via:
 *
 *   bun run tasks/ipl-bulletin-skills/generate-sample.ts
 *
 * Determinism: --date 2026-04-28 + seed 42 + bundled fixtures + 10000 iterations.
 * Two runs on the same code produce a bit-identical artifact.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBulletinPipeline } from '../../examples/skills/cricket-analyst/pipeline.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));

async function main() {
  const start = Date.now();
  const result = await runBulletinPipeline({
    date: '2026-04-28',
    iterations: 10_000,
    seed: 42,
    allowNetwork: false,
  });
  const elapsedMs = Date.now() - start;

  const out = join(HERE, 'sample-bulletin.html');
  await writeFile(out, result.html, 'utf-8');
  console.log(`wrote ${out}`);
  console.log(`elapsed: ${elapsedMs} ms (${(elapsedMs / 1000).toFixed(2)} s)`);
  console.log(`teams in points table: ${result.structured.pointsTable.teams.length}`);
  const totalWinner = Object.values(result.structured.predictions.winnerProb).reduce((a, b) => a + b, 0);
  console.log(`winnerProb sum: ${totalWinner.toFixed(4)}`);
}

if (import.meta.main) {
  await main();
}
