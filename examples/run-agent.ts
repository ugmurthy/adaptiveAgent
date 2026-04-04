#!/usr/bin/env bun
/**
 * AdaptiveAgent sample script.
 *
 * Demonstrates:
 *   - creating a provider-agnostic model adapter (Ollama, OpenRouter, Mistral, or Mesh)
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
 *   # Using Mesh's OpenAI-compatible gateway
 *   PROVIDER=mesh MESH_API_KEY=... bun run examples/run-agent.ts
 *
 *   # Custom goal
 *   bun run examples/run-agent.ts "Summarize the files in this project"
 *
 *   # Auto-approve gated tools in non-interactive runs
 *   bun run examples/run-agent.ts --auto-approve
 *
 *   # Allow more model/tool turns before MAX_STEPS
 *   AGENT_MAX_STEPS=60 bun run examples/run-agent.ts
 *
 *   # Enable lifecycle logging explicitly (default is silent)
 *   AGENT_LOG_LEVEL=info bun run examples/run-agent.ts
 *
 *   # Write structured logs to PROJECT_ROOT/logs/adaptive-agent-example.log
 *   LOG_DEST=file AGENT_LOG_LEVEL=info bun run examples/run-agent.ts
 *
 *   # Mirror logs to console and file, with a custom log directory
 *   LOG_DEST=both LOG_DIR=./tmp/logs AGENT_LOG_LEVEL=debug bun run examples/run-agent.ts
 */

import { readdir } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

import { AdaptiveAgent } from '../packages/core/src/adaptive-agent.js';
import { InMemoryEventStore } from '../packages/core/src/in-memory-event-store.js';
import { InMemoryRunStore } from '../packages/core/src/in-memory-run-store.js';
import { InMemorySnapshotStore } from '../packages/core/src/in-memory-snapshot-store.js';
import { createModelAdapter } from '../packages/core/src/adapters/create-model-adapter.js';
import { createReadFileTool } from '../packages/core/src/tools/read-file.js';
import { createListDirectoryTool } from '../packages/core/src/tools/list-directory.js';
import { createWriteFileTool } from '../packages/core/src/tools/write-file.js';
import { createShellExecTool } from '../packages/core/src/tools/shell-exec.js';
import { createWebSearchTool } from '../packages/core/src/tools/web-search.js';
import { createReadWebPageTool } from '../packages/core/src/tools/read-web-page.js';
import { loadSkillFromDirectory } from '../packages/core/src/skills/load-skill.js';
import { skillToDelegate } from '../packages/core/src/skills/skill-to-delegate.js';
import {
  createAdaptiveAgentLogger,
  DEFAULT_LOG_DESTINATION,
  DEFAULT_LOG_LEVEL,
  type AdaptiveAgentLogDestination,
} from '../packages/core/src/logger.js';
import type { DelegateDefinition, RunResult, ToolDefinition } from '../packages/core/src/types.js';
//-markdown//
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

marked.use(markedTerminal());

// ─── Configuration ──────────────────────────────────────────────────────────

const PROVIDER = (process.env.PROVIDER ?? 'ollama') as 'ollama' | 'openrouter' | 'mistral' | 'mesh';

const MODEL_DEFAULTS: Record<string, string> = {
  ollama: process.env.OLLAMA_MODEL ?? 'qwen3.5',
  openrouter: process.env.OPENROUTER_MODEL ?? 'anthropic/claude-sonnet-4',
  mistral: process.env.MISTRAL_MODEL ?? 'mistral-large-latest',
  mesh: process.env.MESH_MODEL ?? 'openai/gpt-4o',
};

const PROJECT_ROOT = resolve(import.meta.dir, '..');
const SKILLS_DIR = resolve(import.meta.dir, 'skills');
const cliArgs = process.argv.slice(2);
const verbose = cliArgs.includes('--verbose') || cliArgs.includes('-v');
const autoApprove = cliArgs.includes('--auto-approve') || process.env.AUTO_APPROVE === '1';
const positionalArgs = cliArgs.filter((arg) => !['--verbose', '-v', '--auto-approve'].includes(arg));
const webSearchProviderEnv = process.env.WEB_SEARCH_PROVIDER;
const logDestinationEnv = process.env.LOG_DEST;
const webSearchProvider =
  webSearchProviderEnv === 'duckduckgo' || webSearchProviderEnv === 'brave'
    ? webSearchProviderEnv
    : 'brave';
const logDestination = parseLogDestination(logDestinationEnv);
const logDir = resolveLogDir(process.env.LOG_DIR);
const logFilePath = resolve(logDir, 'adaptive-agent-example.log');
const agentLogLevel = process.env.AGENT_LOG_LEVEL ?? (verbose ? 'debug' : DEFAULT_LOG_LEVEL);
const maxSteps = parseOptionalPositiveInt(process.env.AGENT_MAX_STEPS);
const webToolTimeoutMs = parseOptionalPositiveInt(process.env.WEB_TOOL_TIMEOUT_MS);
const modelTimeoutMs = parseOptionalNonNegativeInt(process.env.MODEL_TIMEOUT_MS);

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
  createShellExecTool({ cwd: PROJECT_ROOT }),
];

if (webSearchProviderEnv && webSearchProviderEnv !== webSearchProvider) {
  console.warn(`⚠️  Unknown WEB_SEARCH_PROVIDER='${webSearchProviderEnv}', defaulting to brave`);
}

if (logDestinationEnv && logDestinationEnv !== logDestination) {
  console.warn(`⚠️  Unknown LOG_DEST='${logDestinationEnv}', defaulting to ${DEFAULT_LOG_DESTINATION}`);
}

if (process.env.WEB_TOOL_TIMEOUT_MS && webToolTimeoutMs === undefined) {
  console.warn(`⚠️  Ignoring invalid WEB_TOOL_TIMEOUT_MS='${process.env.WEB_TOOL_TIMEOUT_MS}' (expected a positive integer)`);
}

if (process.env.MODEL_TIMEOUT_MS && modelTimeoutMs === undefined) {
  console.warn(
    `⚠️  Ignoring invalid MODEL_TIMEOUT_MS='${process.env.MODEL_TIMEOUT_MS}' (expected a non-negative integer)`,
  );
}

if (process.env.AGENT_MAX_STEPS && maxSteps === undefined) {
  console.warn(`⚠️  Ignoring invalid AGENT_MAX_STEPS='${process.env.AGENT_MAX_STEPS}' (expected a positive integer)`);
}

if (webSearchProvider === 'duckduckgo') {
  tools.push(createWebSearchTool({ provider: 'duckduckgo', timeoutMs: webToolTimeoutMs }));
  tools.push(createReadWebPageTool({ timeoutMs: webToolTimeoutMs }));
  console.log(
    `🔍 Web search tools enabled (WEB_SEARCH_PROVIDER=duckduckgo${webToolTimeoutMs ? `, WEB_TOOL_TIMEOUT_MS=${webToolTimeoutMs}` : ''})`,
  );
} else {
  const braveKey = process.env.BRAVE_SEARCH_API_KEY;
  if (braveKey) {
    tools.push(createWebSearchTool({ provider: 'brave', apiKey: braveKey, timeoutMs: webToolTimeoutMs }));
    tools.push(createReadWebPageTool({ timeoutMs: webToolTimeoutMs }));
    console.log(
      `🔍 Web search tools enabled (WEB_SEARCH_PROVIDER=brave, BRAVE_SEARCH_API_KEY found${webToolTimeoutMs ? `, WEB_TOOL_TIMEOUT_MS=${webToolTimeoutMs}` : ''})`,
    );
  } else {
    console.log('⚠️  Web search tools disabled (set WEB_SEARCH_PROVIDER=duckduckgo or provide BRAVE_SEARCH_API_KEY)');
  }
}

console.log(`🔧 Tools:    ${tools.map((t) => t.name).join(', ')}`);
if (maxSteps !== undefined) {
  console.log(`🔁 Max steps: ${maxSteps}`);
}
if (modelTimeoutMs !== undefined) {
  console.log(`⏱️  Model timeout: ${modelTimeoutMs === 0 ? 'disabled' : `${modelTimeoutMs}ms`}`);
}

// ─── Load skills as delegates ───────────────────────────────────────────────

const delegates: DelegateDefinition[] = [];

const skillEntries = await readdir(SKILLS_DIR, { withFileTypes: true });
for (const entry of skillEntries) {
  if (!entry.isDirectory()) continue;
  const skillDir = resolve(SKILLS_DIR, entry.name);
  try {
    const skill = await loadSkillFromDirectory(skillDir);
    const missing = skill.allowedTools.filter((t) => !tools.some((tool) => tool.name === t));
    if (missing.length > 0) {
      console.log(`⏭️  Skipping skill '${skill.name}' (missing tools: ${missing.join(', ')})`);
      continue;
    }
    delegates.push(skillToDelegate(skill));
    console.log(`📋 Loaded skill: ${skill.name} → delegate.${skill.name}`);
  } catch (error) {
    console.warn(`⚠️  Failed to load skill from ${entry.name}:`, error);
  }
}

// ─── Create the agent ───────────────────────────────────────────────────────

const runStore = new InMemoryRunStore();
const eventStore = new InMemoryEventStore();
const snapshotStore = new InMemorySnapshotStore();
const logger = createAdaptiveAgentLogger({
  name: 'adaptive-agent-example'+process.env.RUN_SUFFIX,
  destination: logDestination,
  ...(logDestination === 'file' || logDestination === 'both' ? { filePath: logFilePath } : {}),
  level: agentLogLevel,
  pretty: process.stdout.isTTY,
});

if (logDestination === 'file' || logDestination === 'both') {
  console.log(`🪵 Logs:     ${logDestination} (${logFilePath}, level=${agentLogLevel})`);
}

const agent = new AdaptiveAgent({
  model,
  tools,
  delegates,
  delegation: {
    maxDepth: 1,
    maxChildrenPerRun: 7,
  },
  runStore,
  eventStore,
  snapshotStore,
  logger,
  defaults: {
    ...(maxSteps === undefined ? {} : { maxSteps }),
    toolTimeoutMs: 30_000,
    ...(modelTimeoutMs === undefined ? {} : { modelTimeoutMs }),
    autoApproveAll: autoApprove,
    capture: verbose ? 'full' : 'summary',
  },
});

// ─── Run it ─────────────────────────────────────────────────────────────────

const goal = positionalArgs[0] ?? 'List the top-level files in this project and summarize what each one is for.';

console.log(`\n🎯 Goal: ${goal}\n`);
console.log('─'.repeat(60));

const startTime = Date.now();

async function promptForApproval(toolName: string): Promise<boolean> {
  if (autoApprove) {
    console.log(`\n✅ Auto-approving tool: ${toolName}`);
    return true;
  }

  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      'Approval was requested, but this example is using in-memory stores and no interactive TTY is available. Re-run with --auto-approve or keep the process alive to approve interactively.',
    );
  }

  const readline = createInterface({ input, output });
  try {
    const answer = await readline.question(`Approve tool "${toolName}"? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}

async function resolveApproval(runId: string, approved: boolean): Promise<void> {
  await agent.resolveApproval(runId, approved);
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

function parseOptionalNonNegativeInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return undefined;
  }

  return parsed;
}

function parseLogDestination(value: string | undefined): AdaptiveAgentLogDestination {
  if (value === 'console' || value === 'file' || value === 'both') {
    return value;
  }

  return DEFAULT_LOG_DESTINATION;
}

function resolveLogDir(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return resolve(PROJECT_ROOT, 'logs');
  }

  return isAbsolute(trimmed) ? trimmed : resolve(PROJECT_ROOT, trimmed);
}

function printResult(result: RunResult, elapsedSeconds: string): void {
  console.log('\n' + '─'.repeat(60));

  if (result.status === 'success') {
    console.log(`\n✅ Success (${elapsedSeconds}s, ${result.stepsUsed} steps)`);
    console.log('\n📄 Output:\n');
    console.log(
      typeof result.output === 'string'
        ? marked.parse(result.output)
        : marked.parse(JSON.stringify(result.output, null, 2)),
    );

    if (verbose && result.usage.promptTokens > 0) {
      console.log('\n📊 Usage:');
      console.log(`   Prompt tokens:     ${result.usage.promptTokens}`);
      console.log(`   Completion tokens: ${result.usage.completionTokens}`);
      if (result.usage.reasoningTokens) {
        console.log(`   Reasoning tokens:  ${result.usage.reasoningTokens}`);
      }
      console.log(`   Estimated cost:    $${result.usage.estimatedCostUSD.toFixed(4)}`);
    }
    return;
  }

  if (result.status === 'failure') {
    console.log(`\n❌ Failed (${elapsedSeconds}s, ${result.stepsUsed} steps)`);
    console.log(`   Code:  ${result.code}`);
    console.log(`   Error: ${result.error}`);
    return;
  }

  if (result.status === 'clarification_requested') {
    console.log(`\n❓ Clarification requested:`);
    console.log(`   ${result.message}`);
    return;
  }

  console.log(`\n⏸️  Approval requested for tool: ${result.toolName}`);
  console.log(`   ${result.message}`);
  console.log(`   Run ID: ${result.runId}`);
}

try {
  let result = await agent.run({ goal });

  while (result.status === 'approval_requested') {
    printResult(result, ((Date.now() - startTime) / 1000).toFixed(1));
    const approved = await promptForApproval(result.toolName);
    await resolveApproval(result.runId, approved);

    if (approved) {
      console.log(`   Approved ${result.toolName}; resuming run...`);
    } else {
      console.log(`   Rejected ${result.toolName}; finalizing run...`);
    }

    result = await agent.resume(result.runId);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  printResult(result, elapsed);

  if (verbose) {
    console.log('\n🧾 Result object:\n');
    console.log(JSON.stringify(result, null, 2));

    const events = await eventStore.listByRun(result.runId);
    console.log(`\n📅 Event timeline (${events.length} events):`);
    for (const event of events) {
      const payload = typeof event.payload === 'object' && event.payload !== null ? event.payload : {};
      const detail = 'toolName' in payload ? ` [${(payload as any).toolName}]` : '';
      console.log(`   ${event.type}${detail}`);
    }

    const childRuns = await runStore.listChildren(result.runId);
    if (childRuns.length > 0) {
      console.log(`\n👥 Child runs (${childRuns.length}):`);
      for (const child of childRuns) {
        console.log(`   delegate.${child.delegateName} → ${child.status} (${child.id.slice(0, 8)}...)`);
      }
    }
  }
} catch (error) {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`\n💥 Error after ${elapsed}s:`, error);
  process.exit(1);
}
