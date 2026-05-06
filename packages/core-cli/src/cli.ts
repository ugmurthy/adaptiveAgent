#!/usr/bin/env bun
import { fileURLToPath } from 'node:url';
import { stderr, stdout } from 'node:process';

import type { AgentEvent, RunResult } from '@adaptive-agent/core';

import { createLocalAgent, resolveLoadedWorkspaceRoot } from './agent-loader.js';
import { loadAgentConfig, type LoadedAgentConfig } from './config.js';
import { readGoalFromArgsStdinOrPrompt, resolveInteractiveResult, runChatLoop } from './interactive.js';
import { resolveLocalModules, resolveRuntimeBundle, type ResolvedLocalModules, type RuntimeBundle, type RuntimeMode } from './local-modules.js';
import {
  renderConfigSummary,
  renderEventLine,
  renderInspect,
  renderRunResult,
  renderRunStatus,
  renderStartupSummary,
  type StartupSummary,
} from './render.js';

const COMMANDS = ['run', 'chat', 'resume', 'retry', 'interrupt', 'steer', 'inspect', 'config'] as const;
type CliCommand = (typeof COMMANDS)[number];

export interface ParsedCliArgs {
  command?: CliCommand;
  positionals: string[];
  agentConfigPath?: string;
  skillsDirs: string[];
  allowExampleSkills: boolean;
  runtimeMode: RuntimeMode;
  autoApprove: boolean;
  events: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
}

interface CliContext {
  parsed: ParsedCliArgs;
  loadedConfig: LoadedAgentConfig;
  workspaceRoot: string;
  modules: ResolvedLocalModules;
}

interface RuntimeContext extends CliContext {
  runtime: RuntimeBundle;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    return await runCli(argv);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export async function runCli(argv: string[]): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (parsed.help) {
    stdout.write(`${renderHelp()}\n`);
    return 0;
  }

  if (parsed.version) {
    stdout.write('0.1.0\n');
    return 0;
  }

  const context = await loadCliContext(parsed);
  const command = parsed.command ?? context.loadedConfig.config.defaultInvocationMode;

  if (command === 'config') {
    stdout.write(`${renderConfigSummary(toStartupSummary(context))}\n`);
    return 0;
  }

  stderr.write(`${renderStartupSummary(toStartupSummary(context))}\n`);
  requireInvocationMode(context.loadedConfig, command);

  if (command === 'inspect') {
    return withRuntime(context, async (runtimeContext) => inspectRun(runtimeContext));
  }

  return withRuntime(context, async (runtimeContext) => runAgentCommand(runtimeContext, command));
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const parsed: ParsedCliArgs = {
    positionals: [],
    skillsDirs: [],
    allowExampleSkills: false,
    runtimeMode: 'memory',
    autoApprove: false,
    events: false,
    verbose: false,
    help: false,
    version: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;

    if (token === '--') {
      parsed.positionals.push(...argv.slice(index + 1));
      break;
    }

    if (token === '--help' || token === '-h') {
      parsed.help = true;
      continue;
    }

    if (token === '--version' || token === '-v') {
      parsed.version = true;
      continue;
    }

    if (token === '--agent' || token === '--agent-config') {
      parsed.agentConfigPath = requireFlagValue(argv, ++index, token);
      continue;
    }

    if (token === '--skills-dir') {
      parsed.skillsDirs.push(requireFlagValue(argv, ++index, token));
      continue;
    }

    if (token === '--runtime') {
      parsed.runtimeMode = parseRuntimeMode(requireFlagValue(argv, ++index, token));
      continue;
    }

    if (token === '--allow-example-skills') {
      parsed.allowExampleSkills = true;
      continue;
    }

    if (token === '--auto-approve') {
      parsed.autoApprove = true;
      continue;
    }

    if (token === '--events') {
      parsed.events = true;
      continue;
    }

    if (token === '--verbose') {
      parsed.verbose = true;
      continue;
    }

    if (token.startsWith('--')) {
      throw new Error(`Unknown option: ${token}`);
    }

    if (!parsed.command && isCommand(token)) {
      parsed.command = token;
      continue;
    }

    parsed.positionals.push(token);
  }

  return parsed;
}

async function loadCliContext(parsed: ParsedCliArgs): Promise<CliContext> {
  const loadedConfig = await loadAgentConfig({ explicitPath: parsed.agentConfigPath });
  const workspaceRoot = resolveLoadedWorkspaceRoot(loadedConfig);
  const modules = await resolveLocalModules({
    workspaceRoot,
    requestedToolNames: loadedConfig.config.tools,
    requestedDelegateNames: loadedConfig.config.delegates,
    skillsDirs: parsed.skillsDirs,
    allowExampleSkills: parsed.allowExampleSkills,
  });

  return {
    parsed,
    loadedConfig,
    workspaceRoot,
    modules,
  };
}

async function withRuntime(context: CliContext, operation: (context: RuntimeContext) => Promise<number>): Promise<number> {
  const runtime = await resolveRuntimeBundle(context.parsed.runtimeMode);
  try {
    return await operation({ ...context, runtime });
  } finally {
    await runtime.close?.();
  }
}

async function runAgentCommand(context: RuntimeContext, command: CliCommand): Promise<number> {
  const localAgent = createLocalAgent({
    loadedConfig: context.loadedConfig,
    modules: context.modules,
    runtime: context.runtime,
    autoApprove: context.parsed.autoApprove,
  });
  const unsubscribe = subscribeToEvents(context.parsed.events, localAgent.created.runtime.eventStore);

  try {
    let result: RunResult | undefined;
    if (command === 'run') {
      const goal = await readGoalFromArgsStdinOrPrompt(context.parsed.positionals);
      result = await localAgent.created.agent.run({ goal, metadata: localAgent.metadata });
      result = await resolveInteractiveResult({
        agent: localAgent.created.agent,
        initialResult: result,
        autoApprove: context.parsed.autoApprove,
        metadata: localAgent.metadata,
      });
    } else if (command === 'chat') {
      const message = context.parsed.positionals.join(' ').trim();
      if (message) {
        result = await localAgent.created.agent.chat({
          messages: [{ role: 'user', content: message }],
          metadata: localAgent.metadata,
        });
        result = await resolveInteractiveResult({
          agent: localAgent.created.agent,
          initialResult: result,
          autoApprove: context.parsed.autoApprove,
          metadata: localAgent.metadata,
        });
      } else {
        result = await runChatLoop({
          agent: localAgent.created.agent,
          metadata: localAgent.metadata,
          autoApprove: context.parsed.autoApprove,
        });
        return result?.status === 'failure' ? 1 : 0;
      }
    } else if (command === 'resume') {
      result = await localAgent.created.agent.resume(requireSingleRunId(context.parsed.positionals, 'resume'));
      result = await resolveInteractiveResult({
        agent: localAgent.created.agent,
        initialResult: result,
        autoApprove: context.parsed.autoApprove,
        metadata: localAgent.metadata,
      });
    } else if (command === 'retry') {
      result = await localAgent.created.agent.retry(requireSingleRunId(context.parsed.positionals, 'retry'));
      result = await resolveInteractiveResult({
        agent: localAgent.created.agent,
        initialResult: result,
        autoApprove: context.parsed.autoApprove,
        metadata: localAgent.metadata,
      });
    } else if (command === 'interrupt') {
      const runId = requireSingleRunId(context.parsed.positionals, 'interrupt');
      await localAgent.created.agent.interrupt(runId);
      stdout.write(`Interrupted run ${runId}\n`);
      return 0;
    } else if (command === 'steer') {
      const { runId, message } = requireSteerArgs(context.parsed.positionals);
      await localAgent.created.agent.steer(runId, { message });
      stdout.write(`Steered run ${runId} with message (${message.length} chars)\n`);
      return 0;
    }

    if (!result) {
      return 0;
    }

    stderr.write(`${renderRunStatus(result)}\n`);
    stdout.write(`${renderRunResult(result)}\n`);
    return result.status === 'failure' ? 1 : 0;
  } finally {
    unsubscribe?.();
  }
}

async function inspectRun(context: RuntimeContext): Promise<number> {
  const runId = requireSingleRunId(context.parsed.positionals, 'inspect');
  const runStore = context.runtime.runtime?.runStore;
  const eventStore = context.runtime.runtime?.eventStore;
  if (!runStore || !eventStore) {
    throw new Error('Inspect requires configured runtime stores.');
  }

  const run = await runStore.getRun(runId);
  if (!run) {
    throw new Error(`Run ${runId} does not exist.`);
  }

  const events = await eventStore.listByRun(runId);
  stdout.write(`${renderInspect(run, events)}\n`);
  return 0;
}

function subscribeToEvents(enabled: boolean, eventStore: { subscribe?: (listener: (event: AgentEvent) => void) => () => void }): (() => void) | undefined {
  if (!enabled || !eventStore.subscribe) {
    return undefined;
  }

  return eventStore.subscribe((event) => {
    stderr.write(`${renderEventLine(event)}\n`);
  });
}

function toStartupSummary(context: CliContext): StartupSummary {
  return {
    loadedConfig: context.loadedConfig,
    modules: context.modules,
    workspaceRoot: context.workspaceRoot,
    runtimeMode: context.parsed.runtimeMode,
    verbose: context.parsed.verbose,
  };
}

function requireInvocationMode(loadedConfig: LoadedAgentConfig, command: CliCommand): void {
  if ((command === 'run' || command === 'chat') && !loadedConfig.config.invocationModes.includes(command)) {
    throw new Error(`Agent "${loadedConfig.config.id}" does not allow ${command} mode.`);
  }
}

function requireSingleRunId(values: string[], command: string): string {
  if (values.length !== 1 || !values[0]?.trim()) {
    throw new Error(`${command} requires exactly one <run-id>.`);
  }

  return values[0];
}

function requireSteerArgs(values: string[]): { runId: string; message: string } {
  const [runId, ...rest] = values;
  if (!runId?.trim() || rest.length === 0) {
    throw new Error('steer requires <run-id> followed by the steer message.');
  }
  const message = rest.join(' ').trim();
  if (!message) {
    throw new Error('steer requires a non-empty message after <run-id>.');
  }
  return { runId, message };
}

function requireFlagValue(argv: string[], index: number, flagName: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flagName} requires a value.`);
  }

  return value;
}

function parseRuntimeMode(value: string): RuntimeMode {
  if (value === 'memory' || value === 'postgres') {
    return value;
  }

  throw new Error('--runtime must be one of: memory, postgres.');
}

function isCommand(value: string): value is CliCommand {
  return (COMMANDS as readonly string[]).includes(value);
}

function renderHelp(): string {
  return `core-agent [options] [command] [...args]

Commands:
  run <goal>        Run a one-shot goal
  chat              Start an interactive chat loop
  chat <message>    Send one chat turn and exit
  resume <run-id>   Resume a run from runtime stores
  retry <run-id>    Retry a failed run from runtime stores
  interrupt <run-id>          Interrupt a running run cooperatively
  steer <run-id> <message...> Inject a user message into a running run
  inspect <run-id>  Print run details and event timeline
  config            Print resolved local agent configuration

Options:
  --agent <path>, --agent-config <path>
  --skills-dir <path>           Add a local skill search directory
  --allow-example-skills        Include ./examples/skills in delegate lookup
  --runtime memory|postgres     Runtime store mode (default: memory)
  --auto-approve                Approve tools requiring approval for this invocation
  --events                      Print compact persisted core events
  --verbose                     Print debug notes such as ignored gateway-only fields
  --help
  --version`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const exitCode = await main();
  process.exit(exitCode);
}
