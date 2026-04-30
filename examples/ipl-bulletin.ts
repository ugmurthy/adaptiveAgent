#!/usr/bin/env bun
/**
 * IPL Bulletin — daily cricket bulletin pipeline built on top of AdaptiveAgent.
 *
 * Wires the bundled `cricket-analyst` and `monte-carlo` skills so the agent can
 * pull deterministic IPL facts and run a Monte Carlo rollout in TypeScript,
 * never asking the LLM to "simulate" via tokens. The 76-minute step-5 timeout
 * recorded in 21-april-log.md was almost certainly caused by the LLM doing
 * exactly that — this entrypoint is the deterministic alternative.
 *
 * Usage:
 *   bun run examples/ipl-bulletin.ts                       # today
 *   bun run examples/ipl-bulletin.ts --date 2026-04-28     # frozen date
 *   bun run examples/ipl-bulletin.ts --no-network          # offline / fixtures only
 *
 * Env:
 *   PROVIDER          ollama | openrouter | mistral | mesh   (default: ollama)
 *   OLLAMA_MODEL      e.g. qwen3.5
 *   CRICKET_DATA_BASE_URL  optional JSON mirror; otherwise fixture-only
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';

import {
  createAdaptiveAgent,
  type AdaptiveAgentModelInput,
} from '../packages/core/src/create-adaptive-agent.js';
import { loadSkillFromDirectory } from '../packages/core/src/skills/load-skill.js';
import type { SkillDefinition } from '../packages/core/src/skills/types.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SKILLS_DIR = join(HERE, 'skills');

export interface BulletinOptions {
  model: AdaptiveAgentModelInput;
  date?: string;
  noNetwork?: boolean;
}

export async function loadBulletinSkills(): Promise<SkillDefinition[]> {
  const cricketAnalyst = await loadSkillFromDirectory(join(SKILLS_DIR, 'cricket-analyst'));
  const monteCarlo = await loadSkillFromDirectory(join(SKILLS_DIR, 'monte-carlo'));
  return [cricketAnalyst, monteCarlo];
}

export async function createBulletinAgent(options: BulletinOptions) {
  const skills = await loadBulletinSkills();
  const created = createAdaptiveAgent({
    model: options.model,
    skills,
    defaults: {
      maxSteps: 30,
      modelTimeoutMs: 90_000,
    },
  });
  return { ...created, skills };
}

export function buildGoal(date: string, noNetwork: boolean): string {
  const networkClause = noNetwork
    ? 'IMPORTANT: --no-network is in effect. Do not call web_search or read_web_page; rely entirely on the cricket-analyst delegate.'
    : 'Prefer delegate.cricket-analyst for IPL facts. Avoid web scraping unless the delegate explicitly cannot answer.';

  return [
    `You are producing the IPL 2026 bulletin for ${date}.`,
    '',
    'Required structure:',
    '  1. Current points table (call delegate.cricket-analyst with action=points_table).',
    '  2. Highlights of recent matches (call delegate.cricket-analyst with action=fixtures).',
    '  3. Player form notes (call delegate.cricket-analyst with action=player_form).',
    '  4. Monte Carlo predictions (call delegate.monte-carlo with action=simulate_tournament,',
    '     passing the points table from step 1 and the remaining fixtures from step 2).',
    '  5. Final styled HTML report.',
    '',
    'Ground rules:',
    '- NEVER fabricate scores, points, NRR values, or probabilities. Use only data returned by',
    '  the delegates. If a delegate returns null fields, surface that explicitly.',
    '- NEVER simulate match outcomes by reasoning in tokens. The monte-carlo delegate is the',
    '  source of truth for all probability values.',
    '- Round all probabilities to 4 decimal places exactly as the delegate returns them.',
    networkClause,
  ].join('\n');
}

async function runCli(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const date = args.date ?? new Date().toISOString().slice(0, 10);
  const noNetwork = args.noNetwork ?? false;

  const provider = (process.env.PROVIDER ?? 'ollama') as 'ollama' | 'openrouter' | 'mistral' | 'mesh';
  const modelInput: AdaptiveAgentModelInput = {
    provider,
    model: process.env.OLLAMA_MODEL ?? 'qwen3.5',
  };

  const { agent } = await createBulletinAgent({ model: modelInput, date, noNetwork });
  const goal = buildGoal(date, noNetwork);

  const result = await agent.run({ goal });

  if (result.status !== 'success') {
    console.error(`bulletin run did not succeed: status=${result.status}`);
    if ('error' in result) console.error(`  error: ${result.error}`);
    process.exit(1);
  }

  const outputPath = join(process.cwd(), `sport-bulletin-${date}.html`);
  const html = typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2);
  await writeFile(outputPath, html, 'utf-8');
  console.log(`bulletin written to ${outputPath}`);
}

interface ParsedArgs {
  date?: string;
  noNetwork?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date' && i + 1 < argv.length) {
      out.date = argv[++i];
    } else if (a === '--no-network') {
      out.noNetwork = true;
    }
  }
  return out;
}

if (import.meta.main) {
  await runCli();
}
