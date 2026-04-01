#!/usr/bin/env bun
/**
 * AdaptiveAgent sample script.
 *
 * Demonstrates:
 *   - creating a provider-agnostic model adapter (Ollama, OpenRouter, or Mistral)
 *   - registering built-in tools
 *   - loading skills from disk and using them as delegate profiles
 *   - running the agent with delegation to sub-agents
 *
 * Usage:
 *   # Using Ollama (default — no API key needed, runs locally)
 *   bun run examples/run-agent.ts
 *
 *   # Using Ollama with a specific model
 *   OLLAMA_MODEL=qwen3.5 bun run examples/run-agent.ts
 *
 *   # Using OpenRouter
 *   PROVIDER=openrouter OPENROUTER_API_KEY=sk-or-... bun run examples/run-agent.ts
 *
 *   # Using Mistral
 *   PROVIDER=mistral MISTRAL_API_KEY=... bun run examples/run-agent.ts
 *
 *   # Custom goal
 *   bun run examples/run-agent.ts "Summarize the files in this project"
 */

import { resolve } from 'node:path';

import { AdaptiveAgent } from '../packages/core/src/adaptive-agent.js';
import { InMemoryEventStore } from '../packages/core/src/in-memory-event-store.js';
import { InMemoryRunStore } from '../packages/core/src/in-memory-run-store.js';
import { InMemorySnapshotStore } from '../packages/core/src/in-memory-snapshot-store.js';
import { createModelAdapter } from '../packages/core/src/adapters/create-model-adapter.js';
import { createReadFileTool } from '../packages/core/src/tools/read-file.js';
import { createListDirectoryTool } from '../packages/core/src/tools/list-directory.js';
import { createWriteFileTool } from '../packages/core/src/tools/write-file.js';
import { createWebSearchTool } from '../packages/core/src/tools/web-search.js';
import { createReadWebPageTool } from '../packages/core/src/tools/read-web-page.js';
import { loadSkillFromDirectory } from '../packages/core/src/skills/load-skill.js';
import { skillToDelegate } from '../packages/core/src/skills/skill-to-delegate.js';
import type { ToolDefinition, DelegateDefinition } from '../packages/core/src/types.js';

// ─── Configuration ──────────────────────────────────────────────────────────

const PROVIDER = (process.env.PROVIDER ?? 'ollama') as 'ollama' | 'openrouter' | 'mistral';

const MODEL_DEFAULTS: Record<string, string> = {
  ollama: process.env.OLLAMA_MODEL ?? 'qwen3.5',
  openrouter: process.env.OPENROUTER_MODEL ?? 'anthropic/claude-sonnet-4',
  mistral: process.env.MISTRAL_MODEL ?? 'mistral-large-latest',
};

const PROJECT_ROOT = resolve(import.meta.dir, '..');
const SKILLS_DIR = resolve(import.meta.dir, 'skills');

// ─── Build the model adapter ────────────────────────────────────────────────

console.log(`\n🤖 Provider: ${PROVIDER}`);
console.log(`📦 Model:    ${MODEL_DEFAULTS[PROVIDER]}\n`);

const model = createModelAdapter({
  provider: PROVIDER,
  model: MODEL_DEFAULTS[PROVIDER],
  apiKey: process.env[`${PROVIDER.toUpperCase()}_API_KEY`] ?? process.env.OPENROUTER_API_KEY,
  baseUrl: process.env[`${PROVIDER.toUpperCase()}_BASE_URL`],
});

// ─── Register built-in tools ────────────────────────────────────────────────

const tools: ToolDefinition[] = [
  createReadFileTool({ allowedRoot: PROJECT_ROOT }),
  createListDirectoryTool({ allowedRoot: PROJECT_ROOT }),
  createWriteFileTool({ allowedRoot: resolve(PROJECT_ROOT, 'artifacts') }),
];

// Add web tools only if Brave Search API key is available
const braveKey = process.env.BRAVE_SEARCH_API_KEY;
if (braveKey) {
  tools.push(createWebSearchTool({ apiKey: braveKey }));
  tools.push(createReadWebPageTool());
  console.log('🔍 Web search tools enabled (BRAVE_SEARCH_API_KEY found)');
} else {
  console.log('⚠️  Web search tools disabled (set BRAVE_SEARCH_API_KEY to enable)');
}

console.log(`🔧 Tools:    ${tools.map((t) => t.name).join(', ')}`);

// ─── Load skills as delegates ───────────────────────────────────────────────

const delegates: DelegateDefinition[] = [];

async function tryLoadSkill(skillDir: string, requiredTools: string[]): Promise<void> {
  const available = requiredTools.every((t) => tools.some((tool) => tool.name === t));
  if (!available) {
    const skillName = skillDir.split('/').pop();
    console.log(`⏭️  Skipping skill '${skillName}' (missing tools: ${requiredTools.filter((t) => !tools.some((tool) => tool.name === t)).join(', ')})`);
    return;
  }

  try {
    const skill = await loadSkillFromDirectory(skillDir);
    delegates.push(skillToDelegate(skill));
    console.log(`📋 Loaded skill: ${skill.name} → delegate.${skill.name}`);
  } catch (error) {
    console.warn(`⚠️  Failed to load skill from ${skillDir}:`, error);
  }
}

await tryLoadSkill(resolve(SKILLS_DIR, 'researcher'), ['web_search', 'read_web_page']);
await tryLoadSkill(resolve(SKILLS_DIR, 'file-analyst'), ['read_file', 'list_directory']);

// ─── Create the agent ───────────────────────────────────────────────────────

const runStore = new InMemoryRunStore();
const eventStore = new InMemoryEventStore();
const snapshotStore = new InMemorySnapshotStore();

const agent = new AdaptiveAgent({
  model,
  tools,
  delegates,
  delegation: {
    maxDepth: 1,
    maxChildrenPerRun: 5,
  },
  runStore,
  eventStore,
  snapshotStore,
  defaults: {
    maxSteps: 20,
    toolTimeoutMs: 30_000,
    modelTimeoutMs: 60_000,
  },
});

// ─── Run it ─────────────────────────────────────────────────────────────────

const goal = process.argv[2] ?? 'List the top-level files in this project and summarize what each one is for.';

console.log(`\n🎯 Goal: ${goal}\n`);
console.log('─'.repeat(60));

const startTime = Date.now();

try {
  const result = await agent.run({ goal });
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n' + '─'.repeat(60));

  if (result.status === 'success') {
    console.log(`\n✅ Success (${elapsed}s, ${result.stepsUsed} steps)`);
    console.log('\n📄 Output:\n');
    console.log(
      typeof result.output === 'string'
        ? result.output
        : JSON.stringify(result.output, null, 2),
    );

    if (result.usage.promptTokens > 0) {
      console.log('\n📊 Usage:');
      console.log(`   Prompt tokens:     ${result.usage.promptTokens}`);
      console.log(`   Completion tokens: ${result.usage.completionTokens}`);
      if (result.usage.reasoningTokens) {
        console.log(`   Reasoning tokens:  ${result.usage.reasoningTokens}`);
      }
      console.log(`   Estimated cost:    $${result.usage.estimatedCostUSD.toFixed(4)}`);
    }
  } else if (result.status === 'failure') {
    console.log(`\n❌ Failed (${elapsed}s, ${result.stepsUsed} steps)`);
    console.log(`   Code:  ${result.code}`);
    console.log(`   Error: ${result.error}`);
  } else if (result.status === 'approval_requested') {
    console.log(`\n⏸️  Approval requested for tool: ${result.toolName}`);
    console.log(`   ${result.message}`);
    console.log(`   Run ID: ${result.runId} (use agent.resume() after approval)`);
  } else if (result.status === 'clarification_requested') {
    console.log(`\n❓ Clarification requested:`);
    console.log(`   ${result.message}`);
  }

  console.log('\n🧾 Result object:\n');
  console.log(JSON.stringify(result, null, 2));

  // Show event timeline
  const events = await eventStore.listByRun(result.runId);
  console.log(`\n📅 Event timeline (${events.length} events):`);
  for (const event of events) {
    const payload = typeof event.payload === 'object' && event.payload !== null ? event.payload : {};
    const detail = 'toolName' in payload ? ` [${(payload as any).toolName}]` : '';
    console.log(`   ${event.type}${detail}`);
  }

  // Show child runs if any
  const childRuns = await runStore.listChildren(result.runId);
  if (childRuns.length > 0) {
    console.log(`\n👥 Child runs (${childRuns.length}):`);
    for (const child of childRuns) {
      console.log(`   delegate.${child.delegateName} → ${child.status} (${child.id.slice(0, 8)}...)`);
    }
  }
} catch (error) {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`\n💥 Error after ${elapsed}s:`, error);
  process.exit(1);
}
