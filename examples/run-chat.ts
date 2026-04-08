#!/usr/bin/env bun
/**
 * Minimal AdaptiveAgent chat demo.
 *
 * Usage:
 *   bun run examples/run-chat.ts
 *   PROVIDER=openrouter OPENROUTER_API_KEY=... bun run examples/run-chat.ts
 *   CHAT_SYSTEM_PROMPT="You are a terse staff engineer." bun run examples/run-chat.ts
 */

import { isAbsolute, resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

import { createAdaptiveAgent } from '../packages/core/src/create-adaptive-agent.js';
import {
  createAdaptiveAgentLogger,
  DEFAULT_LOG_DESTINATION,
  DEFAULT_LOG_LEVEL,
  type AdaptiveAgentLogDestination,
} from '../packages/core/src/logger.js';
import type { ChatMessage } from '../packages/core/src/types.js';

marked.use(markedTerminal());

const PROVIDER = (process.env.PROVIDER ?? 'ollama') as 'ollama' | 'openrouter' | 'mistral' | 'mesh';

const MODEL_DEFAULTS: Record<typeof PROVIDER, string> = {
  ollama: process.env.OLLAMA_MODEL ?? 'qwen3.5',
  openrouter: process.env.OPENROUTER_MODEL ?? 'anthropic/claude-sonnet-4',
  mistral: process.env.MISTRAL_MODEL ?? 'mistral-large-latest',
  mesh: process.env.MESH_MODEL ?? 'openai/gpt-4o',
};

const PROJECT_ROOT = resolve(import.meta.dir, '..');
const logDestination = parseLogDestination(process.env.LOG_DEST);
const logDir = resolveLogDir(process.env.LOG_DIR);
const logFilePath = resolve(logDir, 'adaptive-agent-chat.log');
const modelTimeoutMs = parseOptionalNonNegativeInt(process.env.MODEL_TIMEOUT_MS);
const maxSteps = parseOptionalPositiveInt(process.env.AGENT_MAX_STEPS) ?? 8;
const systemPrompt = process.env.CHAT_SYSTEM_PROMPT?.trim();

const logger = createAdaptiveAgentLogger({
  name: 'adaptive-agent-chat',
  destination: logDestination,
  ...(logDestination === 'file' || logDestination === 'both' ? { filePath: logFilePath } : {}),
  level: process.env.AGENT_LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
  pretty: process.stdout.isTTY,
});

const { agent } = createAdaptiveAgent({
  model: {
    provider: PROVIDER,
    model: MODEL_DEFAULTS[PROVIDER],
    apiKey: process.env[`${PROVIDER.toUpperCase()}_API_KEY`] ?? process.env.OPENROUTER_API_KEY,
    baseUrl: process.env[`${PROVIDER.toUpperCase()}_BASE_URL`],
  },
  tools: [],
  logger,
  defaults: {
    maxSteps,
    ...(modelTimeoutMs === undefined ? {} : { modelTimeoutMs }),
  },
});

if (!input.isTTY || !output.isTTY) {
  throw new Error('examples/run-chat.ts requires an interactive TTY.');
}

const readline = createInterface({ input, output });
const messages: ChatMessage[] = systemPrompt ? [{ role: 'system', content: systemPrompt }] : [];

console.log(`\n💬 AdaptiveAgent chat`);
console.log(`🤖 Provider: ${PROVIDER}`);
console.log(`📦 Model:    ${MODEL_DEFAULTS[PROVIDER]}`);
console.log(`🧰 Tools:    none`);
console.log(`🔁 Max steps per turn: ${maxSteps}`);
if (modelTimeoutMs !== undefined) {
  console.log(`⏱️  Model timeout: ${modelTimeoutMs === 0 ? 'disabled' : `${modelTimeoutMs}ms`}`);
}
if (systemPrompt) {
  console.log(`📝 System prompt: ${systemPrompt}`);
}
if (logDestination === 'file' || logDestination === 'both') {
  console.log(`🪵 Logs:     ${logDestination} (${logger.filePath ?? logFilePath})`);
}
console.log('\nCommands: /exit, /clear, /history\n');

try {
  while (true) {
    const message = (await readline.question('You: ')).trim();
    if (!message) {
      continue;
    }

    if (message === '/exit') {
      break;
    }

    if (message === '/clear') {
      messages.length = 0;
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      console.log('History cleared.\n');
      continue;
    }

    if (message === '/history') {
      printHistory(messages);
      continue;
    }

    messages.push({ role: 'user', content: message });
    const result = await agent.chat({
      messages,
      metadata: {
        channel: 'cli-chat',
      },
    });

    if (result.status === 'success') {
      const reply = renderChatReply(result.output);
      messages.push({ role: 'assistant', content: reply });
      console.log(`\nAssistant (${result.stepsUsed} step${result.stepsUsed === 1 ? '' : 's'}):\n`);
      console.log(marked(reply));
      console.log('');
      continue;
    }

    if (result.status === 'failure') {
      console.log(`\nAssistant failed [${result.code}]: ${result.error}\n`);
      continue;
    }

    if (result.status === 'clarification_requested') {
      console.log(`\nAssistant needs clarification: ${result.message}\n`);
      continue;
    }

    console.log(`\nAssistant requested approval for ${result.toolName}: ${result.message}\n`);
  }
} finally {
  readline.close();
}

function renderChatReply(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }

  return JSON.stringify(output, null, 2);
}

function printHistory(messages: ChatMessage[]): void {
  if (messages.length === 0) {
    console.log('No messages yet.\n');
    return;
  }

  console.log('');
  for (const message of messages) {
    const label = message.role === 'assistant' ? 'Assistant' : message.role === 'user' ? 'You' : 'System';
    console.log(`${label}: ${message.content}`);
  }
  console.log('');
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
