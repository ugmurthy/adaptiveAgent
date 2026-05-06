import { createInterface } from 'node:readline/promises';
import { stdin, stderr, stdout } from 'node:process';

import type { AdaptiveAgent, ChatMessage, JsonObject, RunResult } from '@adaptive-agent/core';

import { formatJsonValue, renderRunResult, renderRunStatus } from './render.js';

export interface ExecuteWithInteractionOptions {
  agent: AdaptiveAgent;
  initialResult: RunResult;
  autoApprove?: boolean;
  metadata?: JsonObject;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
  stdinIsTTY?: boolean;
}

export async function resolveInteractiveResult(options: ExecuteWithInteractionOptions): Promise<RunResult> {
  let result = options.initialResult;
  const stdinIsTTY = options.stdinIsTTY ?? Boolean(stdin.isTTY);

  while (result.status === 'approval_requested' || result.status === 'clarification_requested') {
    if (result.status === 'approval_requested') {
      if (!options.autoApprove && !stdinIsTTY) {
        throw new Error(
          `Run ${result.runId} requested approval for ${result.toolName}. Re-run with --auto-approve or use an interactive terminal.`,
        );
      }

      const approved = options.autoApprove ? true : await promptYesNo(`Approve tool "${result.toolName}"? [y/N] `);
      await options.agent.resolveApproval(result.runId, approved);
      result = await options.agent.resume(result.runId);
      continue;
    }

    if (!stdinIsTTY) {
      throw new Error(`Run ${result.runId} requested clarification. Re-run in an interactive terminal to answer it.`);
    }

    const answer = await promptText(`${result.message}\nClarification answer: `);
    result = await options.agent.resolveClarification(result.runId, answer);
  }

  return result;
}

export async function runChatLoop(options: {
  agent: AdaptiveAgent;
  metadata?: JsonObject;
  autoApprove?: boolean;
  firstMessage?: string;
}): Promise<RunResult | undefined> {
  const messages: ChatMessage[] = [];
  let nextMessage = options.firstMessage;
  let lastResult: RunResult | undefined;

  while (true) {
    const userMessage = nextMessage ?? (await promptText('you> '));
    nextMessage = undefined;
    const trimmedMessage = userMessage.trim();

    if (!trimmedMessage || trimmedMessage === '.exit' || trimmedMessage === '.quit') {
      return lastResult;
    }

    messages.push({ role: 'user', content: trimmedMessage });
    const initialResult = await options.agent.chat({ messages, metadata: options.metadata });
    const result = await resolveInteractiveResult({
      agent: options.agent,
      initialResult,
      autoApprove: options.autoApprove,
      metadata: options.metadata,
    });
    lastResult = result;

    stderr.write(`${renderRunStatus(result)}\n`);
    stdout.write(`${renderRunResult(result)}\n`);

    if (result.status === 'success') {
      messages.push({ role: 'assistant', content: formatJsonValue(result.output) });
      continue;
    }

    return result;
  }
}

export async function readGoalFromArgsStdinOrPrompt(args: string[]): Promise<string> {
  const argGoal = args.join(' ').trim();
  if (argGoal) {
    return argGoal;
  }

  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const stdinGoal = Buffer.concat(chunks).toString('utf-8').trim();
    if (stdinGoal) {
      return stdinGoal;
    }
  }

  return promptText('Goal: ');
}

async function promptYesNo(question: string): Promise<boolean> {
  const answer = (await promptText(question)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

async function promptText(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
