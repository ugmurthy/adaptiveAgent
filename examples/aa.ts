#!/usr/bin/env bun
/**
 * AdaptiveAgent runner with file-based configuration.
 *
 * Default config path:
 *   ~/.config/.aa/config.json
 *
 * Minimal example:
 * {
 *   "provider": "ollama",
 *   "providers": {
 *     "ollama": { "model": "qwen3.5" }
 *   },
 *   "agent": {
 *     "verbose": false,
 *     "autoApprove": false
 *   }
 * }
 *
 * Usage:
 *   bun run examples/aa.ts "Summarize the files in this project"
 *   printf 'Summarize the files in this project' | bun run examples/aa.ts
 */

import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

import { resolveAaConfig } from './aa-config.js';
import { createAdaptiveAgent } from '../packages/core/src/create-adaptive-agent.js';
import { createAdaptiveAgentLogger } from '../packages/core/src/logger.js';
import { loadSkillFromDirectory } from '../packages/core/src/skills/load-skill.js';
import { skillToDelegate } from '../packages/core/src/skills/skill-to-delegate.js';
import { createListDirectoryTool } from '../packages/core/src/tools/list-directory.js';
import { createReadFileTool } from '../packages/core/src/tools/read-file.js';
import { createReadWebPageTool } from '../packages/core/src/tools/read-web-page.js';
import { createShellExecTool } from '../packages/core/src/tools/shell-exec.js';
import { createWebSearchTool } from '../packages/core/src/tools/web-search.js';
import { createWriteFileTool } from '../packages/core/src/tools/write-file.js';
import type { DelegateDefinition, RunResult, ToolDefinition } from '../packages/core/src/types.js';

marked.use(markedTerminal());

const config = await resolveAaConfig();

console.log(`\nConfig:    ${config.configPath}`);
console.log(`Provider:  ${config.provider}`);
console.log(`Model:     ${config.model}\n`);

const tools: ToolDefinition[] = [
  createReadFileTool({ allowedRoot: config.projectRoot }),
  createListDirectoryTool({ allowedRoot: config.projectRoot }),
  createWriteFileTool({ allowedRoot: config.writeRoot }),
  createShellExecTool({ cwd: config.shellCwd }),
];

if (config.webSearch.enabled) {
  if (config.webSearch.provider === 'duckduckgo') {
    tools.push(createWebSearchTool({ provider: 'duckduckgo', timeoutMs: config.webSearch.timeoutMs }));
  } else {
    tools.push(
      createWebSearchTool({
        provider: 'brave',
        apiKey: config.webSearch.braveApiKey!,
        timeoutMs: config.webSearch.timeoutMs,
      }),
    );
  }

  tools.push(createReadWebPageTool({ timeoutMs: config.webSearch.timeoutMs }));
  console.log(
    `Web tools: ${config.webSearch.provider}${config.webSearch.timeoutMs ? ` (timeout=${config.webSearch.timeoutMs}ms)` : ''}`,
  );
} else {
  console.log('Web tools: disabled');
}

console.log(`Tools:     ${tools.map((tool) => tool.name).join(', ')}`);
if (config.agent.maxSteps !== undefined) {
  console.log(`Max steps: ${config.agent.maxSteps}`);
}
if (config.agent.modelTimeoutMs !== undefined) {
  console.log(
    `Model timeout: ${config.agent.modelTimeoutMs === 0 ? 'disabled' : `${config.agent.modelTimeoutMs}ms`}`,
  );
}

const delegates: DelegateDefinition[] = [];

const skillEntries = await readdir(config.skillsDir, { withFileTypes: true });
for (const entry of skillEntries) {
  if (!entry.isDirectory()) {
    continue;
  }

  const skillDir = resolve(config.skillsDir, entry.name);
  try {
    const skill = await loadSkillFromDirectory(skillDir);
    const missingTools = skill.allowedTools.filter((toolName) => !tools.some((tool) => tool.name === toolName));
    if (missingTools.length > 0) {
      console.log(`Skipping skill '${skill.name}' (missing tools: ${missingTools.join(', ')})`);
      continue;
    }

    delegates.push(skillToDelegate(skill));
    console.log(`Loaded skill: ${skill.name} -> delegate.${skill.name}`);
  } catch (error) {
    console.warn(`Failed to load skill from ${entry.name}:`, error);
  }
}

const logger = createAdaptiveAgentLogger({
  name: config.logging.name,
  destination: config.logging.destination,
  ...(config.logging.destination === 'file' || config.logging.destination === 'both'
    ? { filePath: config.logging.filePath }
    : {}),
  level: config.logging.level,
  pretty: process.stdout.isTTY,
});

if (config.logging.destination === 'file' || config.logging.destination === 'both') {
  console.log(`Logs:      ${config.logging.destination} (${config.logging.filePath}, level=${config.logging.level})`);
}

const {
  agent,
  runtime: { runStore, eventStore },
} = createAdaptiveAgent({
  model: {
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    siteUrl: config.siteUrl,
    siteName: config.siteName,
  },
  tools,
  delegates,
  delegation: {
    maxDepth: config.agent.delegation.maxDepth,
    maxChildrenPerRun: config.agent.delegation.maxChildrenPerRun,
  },
  logger,
  defaults: {
    ...(config.agent.maxSteps === undefined ? {} : { maxSteps: config.agent.maxSteps }),
    toolTimeoutMs: config.agent.toolTimeoutMs,
    ...(config.agent.modelTimeoutMs === undefined ? {} : { modelTimeoutMs: config.agent.modelTimeoutMs }),
    autoApproveAll: config.agent.autoApprove,
    capture: config.agent.capture,
  },
});

const goal = await resolveGoal();

console.log(`\nGoal: ${goal}\n`);
console.log('-'.repeat(60));

const startTime = Date.now();

async function resolveGoal(): Promise<string> {
  const cliGoal = process.argv.slice(2).join(' ').trim();
  if (cliGoal) {
    return cliGoal;
  }

  if (input.isTTY && output.isTTY) {
    const readline = createInterface({ input, output });
    try {
      const promptedGoal = await readline.question('Goal: ');
      const goalText = promptedGoal.trim();
      if (!goalText) {
        throw new Error('No goal provided. Pass a goal as an argument or type one when prompted.');
      }
      return goalText;
    } finally {
      readline.close();
    }
  }

  const chunks: string[] = [];
  for await (const chunk of input) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  }

  const pipedGoal = chunks.join('').trim();
  if (!pipedGoal) {
    throw new Error('No goal provided on stdin. Pass a goal as an argument or pipe goal text into aa.ts.');
  }

  return pipedGoal;
}

async function promptForApproval(toolName: string): Promise<boolean> {
  if (config.agent.autoApprove) {
    console.log(`\nAuto-approving tool: ${toolName}`);
    return true;
  }

  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      'Approval was requested, but no interactive TTY is available. Enable agent.autoApprove in config for non-interactive runs.',
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

function printResult(result: RunResult, elapsedSeconds: string): void {
  console.log('\n' + '-'.repeat(60));

  if (result.status === 'success') {
    console.log(`\nSuccess (${elapsedSeconds}s, ${result.stepsUsed} steps)`);
    console.log('\nOutput:\n');
    console.log(
      typeof result.output === 'string'
        ? marked.parse(result.output)
        : marked.parse(JSON.stringify(result.output, null, 2)),
    );

    if (config.agent.verbose && result.usage.promptTokens > 0) {
      console.log('\nUsage:');
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
    console.log(`\nFailed (${elapsedSeconds}s, ${result.stepsUsed} steps)`);
    console.log(`   Code:  ${result.code}`);
    console.log(`   Error: ${result.error}`);
    return;
  }

  if (result.status === 'clarification_requested') {
    console.log('\nClarification requested:');
    console.log(`   ${result.message}`);
    return;
  }

  console.log(`\nApproval requested for tool: ${result.toolName}`);
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

  if (config.agent.verbose) {
    console.log('\nResult object:\n');
    console.log(JSON.stringify(result, null, 2));

    const events = await eventStore.listByRun(result.runId);
    console.log(`\nEvent timeline (${events.length} events):`);
    for (const event of events) {
      const payload = typeof event.payload === 'object' && event.payload !== null ? event.payload : {};
      const detail = 'toolName' in payload ? ` [${String(payload.toolName)}]` : '';
      console.log(`   ${event.type}${detail}`);
    }

    const childRuns = await runStore.listChildren(result.runId);
    if (childRuns.length > 0) {
      console.log(`\nChild runs (${childRuns.length}):`);
      for (const child of childRuns) {
        console.log(`   delegate.${child.delegateName} -> ${child.status} (${child.id.slice(0, 8)}...)`);
      }
    }
  }
} catch (error) {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`\nError after ${elapsed}s:`, error);
  process.exit(1);
}
