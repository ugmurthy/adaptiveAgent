#!/usr/bin/env bun

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { createModelAdapter, loadSkillFromDirectory, skillToDelegate, type ModelAdapter, type ModelRequest, type ModelResponse } from '@adaptive-agent/core';
import { AgentSdk, discoverCatalogDelegates, loadAgentSdkConfig, prepareSkillHandlerModule, type AgentSdkOptions } from '@adaptive-agent/agent-sdk';

const HELP = `Manually test a SKILL.md delegate using ./agent.settings.json.

Usage (run from the workspace you want to test):
  bun run /path/to/repo/scripts/test-delegate.ts --list
  bun run /path/to/repo/scripts/test-delegate.ts --delegate researcher --task "Investigate X"
  bun run /path/to/repo/scripts/test-delegate.ts --delegate researcher --task "Investigate X" --output ./logs/test.jsonl

The settings-selected agent supplies the fallback model and defaults. The selected
skill supplies instructions, allowed tools, handlers, and any model/default overrides.
No coordinator model or task preparation is used. Runs use temporary in-memory stores.
Each complete model request/response and runtime event is saved to a JSONL transcript.
Requests repeat the full message history deliberately, so you can inspect exactly
what the model saw on each turn. Console output includes requests and responses.

WARNING: This executes real tools in the current folder, uses paid models when
configured, and honors settings approval behavior (including auto-approval).
Transcripts may contain sensitive prompts, file contents, and tool output.
`;

export interface ManualDelegateOptions {
  cwd?: string;
  delegate?: string;
  task?: string;
  outputPath?: string;
  /** Inject an adapter for deterministic, offline testing. */
  modelAdapter?: ModelAdapter;
  print?: (text: string) => void;
}

export async function testDelegate(options: ManualDelegateOptions = {}): Promise<number> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const print = options.print ?? console.log;
  const sdkOptions: AgentSdkOptions = {
    cwd,
    settingsConfigPath: resolve(cwd, 'agent.settings.json'),
    settingsOverrides: { workspace: { overrideRoot: cwd, overrideShellCwd: cwd } },
    runtimeMode: 'memory',
  };
  const discoveryConfig = await loadAgentSdkConfig({
    ...sdkOptions,
    // Discovery only needs settings and skill dirs, not an installed agent profile.
    agentConfig: {
      id: 'manual-delegate-discovery', name: 'Manual delegate discovery',
      invocationModes: ['run'], defaultInvocationMode: 'run', tools: [],
      model: { provider: 'ollama', model: 'discovery-only' },
    },
  });
  // Metadata-only discovery does not load unrelated skill handlers or delegates.
  const catalog = await discoverCatalogDelegates(discoveryConfig, new Set());
  if (!options.delegate) {
    print(`Workspace: ${cwd}\nSettings: ${sdkOptions.settingsConfigPath}`);
    for (const entry of catalog) {
      print(`\n${entry.name}\n  ${entry.description}\n  SKILL.md: ${resolve(entry.path, 'SKILL.md')}\n  Tools: ${entry.allowedTools.join(', ') || '(none)'}`);
    }
    print(`\nDiscovered ${catalog.length} delegate(s).`);
    return 0;
  }
  if (!options.task?.trim()) throw new Error('--task must contain a task description.');
  const name = options.delegate.replace(/^delegate\./, '');
  const selected = catalog.find((entry) => entry.name === name);
  if (!selected) throw new Error(`Unknown delegate "${name}". Use --list to see discovered delegates.`);
  const config = await loadAgentSdkConfig(sdkOptions);
  if (config.inference.mode === 'gateway') {
    throw new Error('This manual runner currently supports byok/local inference, not gateway inference.');
  }
  const env = { ...process.env, ...config.settings.env };
  const skill = await loadSkillFromDirectory(selected.path, {
    resolveHandlerModule: async (request) => (await prepareSkillHandlerModule(request, { env })).modulePath,
  });
  const model = options.modelAdapter ?? skill.model ?? createModelAdapter(config.model);
  const outputPath = resolve(cwd, options.outputPath ?? `logs/delegate-${name}-${crypto.randomUUID()}.jsonl`);
  mkdirSync(dirname(outputPath), { recursive: true });
  // Never overwrite a previous experiment; keep newly created transcripts private.
  writeFileSync(outputPath, '', { flag: 'wx', mode: 0o600 });
  const record = (type: string, data: unknown, visible = false) => {
    const entry = { timestamp: new Date().toISOString(), type, data };
    appendFileSync(outputPath, `${JSON.stringify(entry)}\n`);
    if (visible) print(`\n=== ${type} ===\n${JSON.stringify(data, null, 2)}`);
  };
  print(`Workspace: ${cwd}\nSkill: ${resolve(selected.path, 'SKILL.md')}\nModel: ${model.provider}/${model.model}\nTranscript: ${outputPath}`);
  record('experiment', { workspace: cwd, skillPath: resolve(selected.path, 'SKILL.md'), delegate: name, task: options.task, provider: model.provider, model: model.model });
  let turn = 0;
  const capture = async (request: ModelRequest, generate: () => Promise<ModelResponse>) => {
    const call = ++turn;
    record('model.request', { turn: call, invocation: request.invocation, messages: request.messages, tools: request.tools, outputSchema: request.outputSchema }, true);
    try {
      const response = await generate();
      // Raw provider payloads can include transport metadata; keep model-facing fields.
      const { rawProviderResponse: _raw, ...visible } = response;
      record('model.response', { turn: call, ...visible }, true);
      return response;
    } catch (error) {
      record('model.error', { turn: call, error: error instanceof Error ? error.message : String(error) }, true);
      throw error;
    }
  };
  const traced: ModelAdapter = {
    provider: model.provider,
    model: model.model,
    capabilities: model.capabilities,
    formatToolName: model.formatToolName?.bind(model),
    generate: (request) => capture(request, () => model.generate(request)),
    ...(model.stream ? { stream: (request, onEvent) => capture(request, () => model.stream!(request, onEvent)) } : {}),
  };
  // A deterministic parent invokes exactly one real delegate tool. Only the child
  // calls the provider, with the usual core delegate prompt and scoped tools.
  const parent: ModelAdapter = {
    provider: 'manual',
    model: 'delegate-driver',
    capabilities: model.capabilities,
    async generate(request) {
      const result = request.messages.find((message) => message.role === 'tool');
      return result
        ? { finishReason: 'stop', text: typeof result.content === 'string' ? result.content : JSON.stringify(result.content) }
        : { finishReason: 'tool_calls', toolCalls: [{ id: 'manual-delegate', name: `delegate.${name}`, input: { goal: options.task! } }] };
    },
  };
  let sdk: AgentSdk | undefined;
  try {
    sdk = await AgentSdk.create({
      ...sdkOptions,
      agentConfig: {
        ...config.agent,
        tools: skill.allowedTools,
        delegates: [],
        delegation: { maxDepth: 1, maxChildrenPerRun: 1, allowRecursiveDelegation: false, childRunsMayRequestApproval: true, childRunsMayRequestClarification: true },
      },
      modelAdapter: parent,
      delegates: [{ ...skillToDelegate(skill), model: traced }],
      eventListener: (event) => record('event', event),
    });
    const result = await sdk.run(options.task);
    const { events } = await sdk.inspect(result.runId);
    const childIds = new Set(events.filter((event) => event.type === 'delegate.spawned')
      .flatMap((event) => {
        const payload = event.payload;
        return payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.childRunId === 'string'
          ? [payload.childRunId] : [];
      }));
    const children = (await Promise.all([...childIds].map((id) => sdk!.created.runtime.runStore.getRun(id))))
      .filter((child) => child !== null);
    record('parent.result', result);
    for (const child of children) record('delegate.result', child, true);
    return result.status === 'success' && children.length === 1 && children[0].status === 'succeeded' ? 0 : 1;
  } catch (error) {
    record('experiment.error', { error: error instanceof Error ? error.message : String(error) }, true);
    throw error;
  } finally {
    await sdk?.close();
  }
}

export async function main(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: {
    list: { type: 'boolean' }, help: { type: 'boolean' },
    delegate: { type: 'string' }, task: { type: 'string' }, output: { type: 'string' },
  } });
  if (values.help) { console.log(HELP); return 0; }
  if (values.list && (values.delegate || values.task || values.output)) throw new Error('--list cannot be combined with run options.');
  if (!values.list && (!values.delegate || !values.task)) throw new Error('Use --list or --delegate NAME --task "DESCRIPTION". See --help.');
  return testDelegate({ delegate: values.delegate, task: values.task, outputPath: values.output });
}

if (import.meta.main) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
