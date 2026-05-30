#!/usr/bin/env bun

import { stdout } from 'node:process';
import { extname } from 'node:path';
import chalk from 'chalk';
import type { AgentEvent, AudioInput, ChatMessage, JsonObject, JsonValue, ModelAdapterConfig, RunResult, RunStatus, UsageSummary } from '@adaptive-agent/core';
import { Editor, matchesKey, ProcessTerminal, TUI, type OverlayHandle } from '@earendil-works/pi-tui';

import {
  createAgentSdk,
  createOrchestrationSdk,
  inspectAgentSdkResolution,
  loadAgentSdkConfig,
  type AgentSdk,
  type AgentSdkOptions,
  type AgentSdkRunOptions,
  type ApprovalMode,
  type ClarificationMode,
  type OrchestrationLifecycleEvent,
  type OrchestrationSdk,
  type RuntimeMode,
} from './index.js';
import {
  MessageLog,
  StatusBar,
  InputPanel,
  TuiShell,
  createApprovalDialog,
  createClarificationDialog,
  defaultEditorTheme,
  type ApprovalInfo,
  type ClarificationInfo,
  type EventStreamMode,
  type TuiClientState,
} from './tui/index.js';

const HELP_TEXT = `Commands:
  <text>                    send using current mode from config
  /run <goal>               start a run
  /run-image <path> <goal>  start an image run
  /run-audio <path> <goal>  start an audio run
  /run-file <path> <goal>   start a file run
  /chat <message>           send a chat turn
  /mode run|chat            change default submit mode
  /retry [runId]            retry failed run; defaults to last failed run
  /interrupt [runId]        interrupt explicit or current active run
  /steer <message>          steer current active run as user
  /steer <runId> <message>  steer explicit run as user
  /steer --role user|system [runId] <message>
                             steer with a role override
  /replay <runId>           render stored run events into the log
  /inspect [runId]          show compact run/event summary
  /config                   show resolved config
  /tools                    list registered tools
  /delegates                list configured delegates
  /event progress|compact|verbose|off
  /inspect-session <id>     show orchestration session links when --orchestrate is enabled
  /clear                    clear the message log
  /help                     show this help
  /exit                     close the TUI

Scrollback:
  Mouse wheel               scroll output
  PageUp/PageDown           scroll output by a page
  Ctrl+Up/Ctrl+Down         scroll output by one line
  Home/End                  jump to top/bottom of output`;

const USAGE = `Usage:
  adaptive-agent-tui [options]
  bun run ./packages/agent-sdk/src/adaptive-agent-tui.ts [options]

Options:
  --cwd <path>              Working directory used for SDK config lookup
  --agent <path>            Explicit path to agent.json
  --settings <path>         Explicit path to agent.settings.json
  --runtime <mode>          Runtime mode: memory or postgres
  --provider <name>         Override provider: openrouter, ollama, mistral, mesh
  --model <name>            Override model name
  --approval <mode>         Approval mode override: auto, manual, reject
  --clarification <mode>    Clarification mode override: interactive or fail
  --event <mode>            Event mode: progress, compact, verbose, off
  --orchestrate             Route /run through the orchestration SDK
  --catalog <path>          Agent config path to add to orchestration catalog; repeatable
  --dry-run                 Resolve config, tools, and delegates, then exit
  --help                    Show this help text`;

const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  'succeeded',
  'failed',
  'clarification_requested',
  'replan_required',
  'cancelled',
]);

interface TuiCliOptions {
  cwd?: string;
  agentConfigPath?: string;
  settingsConfigPath?: string;
  runtimeMode?: RuntimeMode;
  provider?: ModelAdapterConfig['provider'];
  model?: string;
  approvalMode?: ApprovalMode;
  clarificationMode?: ClarificationMode;
  eventMode: EventStreamMode;
  orchestrate: boolean;
  agentCatalogPaths: string[];
  dryRun: boolean;
  help: boolean;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function main(argv = Bun.argv.slice(2)): Promise<number> {
  const cli = parseArgs(argv);
  if (cli.help) {
    console.log(USAGE);
    return 0;
  }

  const sdkOptions = buildSdkOptions(cli);
  if (cli.dryRun) {
    const inspection = await inspectAgentSdkResolution(sdkOptions);
    console.log(`agent: ${inspection.config.agent.id} (${inspection.config.agent.name})`);
    console.log(`model: ${inspection.config.model.provider}/${inspection.config.model.model}`);
    console.log(`runtime: ${inspection.config.runtime.mode}`);
    console.log(`tools: ${inspection.registeredToolNames.join(', ') || '(none)'}`);
    console.log(`delegates: ${inspection.delegates.map((delegate) => delegate.name).join(', ') || '(none)'}`);
    return 0;
  }

  const resolvedConfig = await loadAgentSdkConfig(sdkOptions);
  const state: TuiClientState = {
    agentId: resolvedConfig.agent.id,
    agentName: resolvedConfig.agent.name,
    provider: resolvedConfig.model.provider,
    model: resolvedConfig.model.model,
    runtimeMode: resolvedConfig.runtime.mode,
    invocationMode: resolvedConfig.agent.defaultInvocationMode,
    eventMode: cli.eventMode,
    tui: resolvedConfig.tui,
    lastAssistantContentByRun: new Map(),
    busy: false,
  };

  return runTui(sdkOptions, state, cli);
}

async function runTui(sdkOptions: AgentSdkOptions, state: TuiClientState, cli: TuiCliOptions): Promise<number> {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  const closed = createDeferred<number>();
  const messageLog = new MessageLog(state.tui);
  const statusBar = new StatusBar(state);
  const editor = new Editor(tui, defaultEditorTheme);
  const inputPanel = new InputPanel(state, editor);
  const shell = new TuiShell(terminal, statusBar, messageLog, inputPanel);
  tui.addChild(shell);
  tui.setFocus(editor);

  let sdk: AgentSdk | undefined;
  let orchestrationSdk: OrchestrationSdk | undefined;
  let activeModal: OverlayHandle | undefined;
  let activeModalCleanup: (() => void) | undefined;
  const chatMessages: ChatMessage[] = [];

  function invalidate(): void {
    statusBar.invalidate();
    inputPanel.invalidate();
    tui.requestRender();
  }

  function availableMessageLines(): number {
    const statusLines = statusBar.render(terminal.columns);
    const inputLines = inputPanel.render(terminal.columns);
    return Math.max(1, terminal.rows - statusLines.length - inputLines.length);
  }

  function addSystem(content: string): void {
    messageLog.addMessage({ type: 'system', content, timestamp: new Date() });
    invalidate();
  }

  function closeModal(): void {
    activeModal?.hide();
    activeModal = undefined;
    activeModalCleanup?.();
    activeModalCleanup = undefined;
    tui.setFocus(editor);
    invalidate();
  }

  async function handleResult(result: RunResult): Promise<void> {
    state.currentRunId = result.runId;
    if (result.status === 'success') {
      state.currentRunUsage = result.usage;
      state.pendingApprovalRunId = undefined;
      state.pendingClarificationRunId = undefined;
      messageLog.addMessage({ type: 'run', content: formatOutput(result.output), timestamp: new Date() });
      if (state.invocationMode === 'chat') {
        chatMessages.push({ role: 'assistant', content: formatOutput(result.output) });
      }
      invalidate();
      return;
    }
    if (result.status === 'failure') {
      state.currentRunUsage = result.usage;
      state.lastFailedRunId = result.runId;
      messageLog.addMessage({ type: 'system', content: `${shortId(result.runId)} failed: ${result.error}`, timestamp: new Date() });
      invalidate();
      return;
    }
    if (result.status === 'approval_requested') {
      state.pendingApprovalRunId = result.runId;
      showApprovalModal({ runId: result.runId, toolName: result.toolName, reason: result.message });
      invalidate();
      return;
    }
    state.pendingClarificationRunId = result.runId;
    showClarificationModal({ runId: result.runId, message: result.message, suggestedQuestions: result.suggestedQuestions ?? [] });
    invalidate();
  }

  function runTask(label: string, task: () => Promise<RunResult>): void {
    if (state.busy) {
      addSystem('A run is already active. Use /interrupt or /steer, or wait for it to finish.');
      return;
    }
    state.busy = true;
    state.currentRunStartedAt = new Date();
    state.currentRunDurationMs = undefined;
    state.currentRunUsage = undefined;
    invalidate();
    void task()
      .then(handleResult)
      .catch((error) => addSystem(`${label} error: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        state.busy = false;
        if (state.currentRunStartedAt) {
          state.currentRunDurationMs = Date.now() - state.currentRunStartedAt.getTime();
          state.currentRunStartedAt = undefined;
        }
        invalidate();
      });
  }

  function showApprovalModal(approvalInfo: ApprovalInfo): void {
    if (!sdk) return;
    closeModal();
    const { dialog, selectList } = createApprovalDialog(tui, approvalInfo);
    activeModal = tui.showOverlay(dialog, { width: '60%', maxHeight: '80%', anchor: 'center' });
    selectList.onSelect = (item) => {
      const approved = item.value === 'yes';
      closeModal();
      state.pendingApprovalRunId = undefined;
      runTask('approval', async () => {
        await sdk!.agent.resolveApproval(approvalInfo.runId, approved);
        return sdk!.resumeRaw(approvalInfo.runId);
      });
    };
    selectList.onCancel = closeModal;
    tui.setFocus(selectList);
  }

  function showClarificationModal(clarificationInfo: ClarificationInfo): void {
    if (!sdk) return;
    closeModal();
    const dialog = createClarificationDialog(tui, clarificationInfo);
    activeModal = tui.showOverlay(dialog, { width: '75%', maxHeight: '85%', anchor: 'center' });
    activeModalCleanup = tui.addInputListener((data) => {
      if (data === '\x1b') {
        closeModal();
        return { consume: true };
      }
      return undefined;
    });
    const dialogEditor = dialog.getEditor();
    dialogEditor.onSubmit = (value: string) => {
      const answer = value.trim();
      if (!answer) return;
      closeModal();
      state.pendingClarificationRunId = undefined;
      runTask('clarification', () => sdk!.agent.resolveClarification(clarificationInfo.runId, answer));
    };
    tui.setFocus(dialogEditor);
  }

  function handleEvent(event: AgentEvent): void {
    const eventTimestamp = readEventTimestamp(event);
    state.latestAgentEvent = {
      eventType: event.type,
      compactText: formatEvent(event),
      runId: event.runId,
      toolName: readPayloadString(event.payload, 'toolName'),
      detail: readPayloadString(event.payload, 'message') ?? readPayloadString(event.payload, 'error'),
      timestamp: eventTimestamp,
    };
    if (event.type === 'run.failed') state.lastFailedRunId = event.runId;
    if (!isTerminalRunEvent(event)) state.currentRunId = event.runId;
    if (event.type === 'usage.updated') {
      state.currentRunUsage = readPayloadUsage(event.payload) ?? state.currentRunUsage;
    }
    if (state.eventMode === 'off') {
      invalidate();
      return;
    }
    if (state.eventMode === 'progress' || state.eventMode === 'compact') {
      const assistantContent = readPayloadString(event.payload, 'assistantContent')?.trim();
      if (assistantContent) {
        const lastShown = state.lastAssistantContentByRun.get(event.runId);
        if (lastShown !== assistantContent) {
          state.lastAssistantContentByRun.set(event.runId, assistantContent);
          messageLog.addMessage({ type: 'progress', content: assistantContent, timestamp: new Date() });
        }
      }
    }
    if (state.eventMode !== 'progress') {
      messageLog.addMessage({ type: 'event', content: formatEvent(event), timestamp: new Date() });
    }
    invalidate();
  }

  function handleOrchestrationEvent(event: OrchestrationLifecycleEvent): void {
    state.latestAgentEvent = {
      eventType: event.type,
      compactText: formatOrchestrationEvent(event),
      runId: 'runId' in event ? event.runId : undefined,
      status: 'status' in event ? event.status : undefined,
      detail: 'routingReason' in event ? event.routingReason : undefined,
      timestamp: readOrchestrationEventTimestamp(event),
    };
    if (state.eventMode === 'off') {
      invalidate();
      return;
    }
    messageLog.addMessage({ type: 'event', content: formatOrchestrationEvent(event), timestamp: readOrchestrationEventTimestamp(event) });
    invalidate();
  }

  sdk = await createAgentSdk({ ...sdkOptions, eventListener: handleEvent });
  if (cli.orchestrate) {
    orchestrationSdk = await createOrchestrationSdk({
      ...sdkOptions,
      requestedAgentConfig: sdk.config.agent,
      agentCatalogPaths: cli.agentCatalogPaths,
      runtime: sdk.created.runtime,
      eventListener: handleEvent,
      orchestrationListener: handleOrchestrationEvent,
    });
  }
  addSystem(`Agent ready: ${state.agentId} (${state.agentName})\n${state.provider}/${state.model} | runtime ${state.runtimeMode} | mode ${state.invocationMode}${orchestrationSdk ? ' | orchestration on' : ''}\nType /help for commands.`);

  const removeScrollListener = tui.addInputListener((data) => {
    if (activeModal) return undefined;
    const pageSize = Math.max(1, availableMessageLines() - 1);
    if (isScrollUpInput(data, 'page')) {
      messageLog.scrollUp(pageSize);
      invalidate();
      return { consume: true };
    }
    if (isScrollDownInput(data, 'page')) {
      messageLog.scrollDown(pageSize);
      invalidate();
      return { consume: true };
    }
    if (isScrollUpInput(data, 'line')) {
      messageLog.scrollUp(1);
      invalidate();
      return { consume: true };
    }
    if (isScrollDownInput(data, 'line')) {
      messageLog.scrollDown(1);
      invalidate();
      return { consume: true };
    }
    if (matchesKey(data, 'home')) {
      messageLog.scrollToTop(terminal.columns, availableMessageLines());
      invalidate();
      return { consume: true };
    }
    if (matchesKey(data, 'end')) {
      messageLog.scrollToBottom();
      invalidate();
      return { consume: true };
    }
    return undefined;
  });

  editor.onSubmit = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    void handleCommand(trimmed).catch((error) => {
      addSystem(`Error: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  async function handleCommand(trimmed: string): Promise<void> {
    if (trimmed === '/exit' || trimmed === '/quit') {
      closed.resolve(0);
      return;
    }
    if (trimmed === '/help') return addSystem(HELP_TEXT);
    if (trimmed === '/clear') {
      messageLog.clear();
      invalidate();
      return;
    }
    if (trimmed === '/config') return addSystem(formatConfig(state, sdk!));
    if (trimmed === '/tools') return addSystem(`tools: ${sdk!.registeredToolNames.join(', ') || '(none)'}`);
    if (trimmed === '/delegates') return addSystem(`delegates: ${(sdk!.config.agent.delegates ?? []).join(', ') || '(none)'}`);
    if (trimmed.startsWith('/inspect-session ')) return inspectSession(trimmed.slice('/inspect-session '.length).trim());
    if (trimmed.startsWith('/mode ')) {
      state.invocationMode = parseEnum(trimmed.slice(6).trim(), ['run', 'chat'], '/mode');
      return addSystem(`mode set to ${state.invocationMode}`);
    }
    if (trimmed.startsWith('/event ')) {
      state.eventMode = parseEnum(trimmed.slice(7).trim(), ['progress', 'compact', 'verbose', 'off'], '/event');
      return addSystem(`event mode set to ${state.eventMode}`);
    }
    if (trimmed.startsWith('/run-image ')) return submitRunWithAttachment(trimmed, 'image');
    if (trimmed.startsWith('/run-audio ')) return submitRunWithAttachment(trimmed, 'audio');
    if (trimmed.startsWith('/run-file ')) return submitRunWithAttachment(trimmed, 'file');
    if (trimmed.startsWith('/run ')) return submitRun(trimmed.slice(5).trim());
    if (trimmed.startsWith('/chat ')) return submitChat(trimmed.slice(6).trim());
    if (trimmed === '/retry' || trimmed.startsWith('/retry ')) return submitRetry(trimmed);
    if (trimmed === '/interrupt' || trimmed.startsWith('/interrupt ')) return interruptRun(trimmed);
    if (trimmed === '/steer' || trimmed.startsWith('/steer ')) return steerRun(trimmed);
    if (trimmed.startsWith('/replay ')) return replayRun(trimmed.slice(8).trim());
    if (trimmed === '/inspect' || trimmed.startsWith('/inspect ')) return inspectRun(trimmed);
    if (trimmed.startsWith('/')) return addSystem(`Unknown command: ${trimmed}\n\n${HELP_TEXT}`);
    return state.invocationMode === 'chat' ? submitChat(trimmed) : submitRun(trimmed);
  }

  function submitRun(goal: string, options: AgentSdkRunOptions = {}): void {
    if (!goal) throw new Error('/run requires a goal');
    messageLog.addMessage({ type: 'user', content: goal, timestamp: new Date() });
    if (!orchestrationSdk) {
      runTask('run', () => sdk!.runRaw(goal, options));
      return;
    }
    runTask('orchestrated run', async () => {
      const result = await orchestrationSdk!.runRaw(goal, options);
      addSystem(`orchestration session ${result.sessionId}: ${result.executionShape}\nstages: ${result.stages.map((stage) => `${stage.nodeId}:${stage.agentId}:${shortId(stage.runId)}`).join(', ')}`);
      return result.finalResult;
    });
  }

  function submitRunWithAttachment(command: string, kind: 'image' | 'audio' | 'file'): void {
    const prefix = `/run-${kind} `;
    const { path, rest: goal } = splitPathAndRest(command.slice(prefix.length).trim(), prefix);
    if (kind === 'image') return submitRun(goal, { images: [{ path }] });
    if (kind === 'audio') return submitRun(goal, { contentParts: [{ type: 'audio', audio: { source: { kind: 'path', path }, format: inferAudioFormat(path) } }] });
    return submitRun(goal, { contentParts: [{ type: 'file', file: { source: { kind: 'path', path } } }] });
  }

  function submitChat(message: string): void {
    if (!message) throw new Error('/chat requires a message');
    chatMessages.push({ role: 'user', content: message });
    messageLog.addMessage({ type: 'user', content: message, timestamp: new Date() });
    runTask('chat', () => sdk!.chatRaw(chatMessages));
  }

  function submitRetry(command: string): void {
    const runId = command === '/retry' ? state.lastFailedRunId : command.slice('/retry '.length).trim();
    if (!runId) throw new Error('/retry requires a runId when no failed run is known');
    addSystem(`retry requested for ${runId}`);
    runTask('retry', () => sdk!.retryRaw(runId));
  }

  async function interruptRun(command: string): Promise<void> {
    const runId = command === '/interrupt' ? state.currentRunId : command.slice('/interrupt '.length).trim();
    if (!runId) throw new Error('/interrupt requires a runId when no current run is known');
    await sdk!.interrupt(runId);
    addSystem(`interrupt requested for ${runId}`);
  }

  async function steerRun(command: string): Promise<void> {
    const parsed = parseSteer(command, await resolveDefaultSteerRunId());
    await sdk!.steer(parsed.runId, { role: parsed.role, message: parsed.message });
    addSystem(`steer sent for ${parsed.runId} as ${parsed.role}`);
  }

  async function resolveDefaultSteerRunId(): Promise<string | undefined> {
    const candidates = [
      state.latestAgentEvent?.runId,
      state.pendingApprovalRunId,
      state.pendingClarificationRunId,
      state.currentRunId,
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const runId = await resolveActiveLeafRunId(candidate);
      if (runId) return runId;
    }
    return undefined;
  }

  async function resolveActiveLeafRunId(runId: string): Promise<string | undefined> {
    let currentId: string | undefined = runId;
    const seen = new Set<string>();
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const run = await sdk!.created.runtime.runStore.getRun(currentId);
      if (!run) return undefined;
      if (run.currentChildRunId) {
        currentId = run.currentChildRunId;
        continue;
      }
      if (!TERMINAL_RUN_STATUSES.has(run.status)) return run.id;
      return undefined;
    }
    return undefined;
  }

  async function replayRun(runId: string): Promise<void> {
    if (!runId) throw new Error('/replay requires a runId');
    const inspection = await sdk!.inspect(runId);
    addSystem(`replay ${runId}: ${inspection.events.length} event(s)`);
    for (const event of inspection.events) {
      messageLog.addMessage({ type: 'event', content: formatEvent(event), timestamp: new Date(event.createdAt) });
    }
    if (inspection.run?.result !== undefined) {
      messageLog.addMessage({ type: 'run', content: formatOutput(inspection.run.result), timestamp: new Date() });
    }
    invalidate();
  }

  async function inspectRun(command: string): Promise<void> {
    const runId = command === '/inspect' ? state.currentRunId ?? state.lastFailedRunId : command.slice('/inspect '.length).trim();
    if (!runId) throw new Error('/inspect requires a runId when no current or failed run is known');
    const inspection = await sdk!.inspect(runId);
    const eventCounts: Record<string, number> = {};
    for (const event of inspection.events) eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
    addSystem(`run: ${JSON.stringify(inspection.run, null, 2)}\nevents: ${JSON.stringify(eventCounts, null, 2)}`);
  }

  async function inspectSession(sessionId: string): Promise<void> {
    if (!orchestrationSdk) throw new Error('/inspect-session requires --orchestrate');
    if (!sessionId) throw new Error('/inspect-session requires a sessionId');
    const inspection = await orchestrationSdk.inspectSession(sessionId);
    addSystem(`session: ${JSON.stringify(inspection.session, null, 2)}\nplan: ${JSON.stringify(inspection.plan, null, 2)}\nlinks: ${JSON.stringify(inspection.links, null, 2)}`);
  }

  terminal.write('\x1b[?1049h');
  terminal.write('\x1b[?1000h\x1b[?1006h');
  tui.start();
  const tick = setInterval(() => {
    if (state.latestAgentEvent || state.busy) tui.requestRender();
  }, 1000);
  try {
    return await closed.promise;
  } finally {
    clearInterval(tick);
    removeScrollListener();
    tui.stop();
    terminal.write('\x1b[?1006l\x1b[?1000l');
    terminal.write('\x1b[?1049l');
    await sdk.close();
    await orchestrationSdk?.close();
  }
}

function isScrollUpInput(data: string, granularity: 'line' | 'page'): boolean {
  if (granularity === 'page') return matchesKey(data, 'pageUp') || data === '\x1b[5~';
  return matchesKey(data, 'ctrl+up') || data === '\x1b[1;5A' || isSgrMouseWheel(data, 'up');
}

function isScrollDownInput(data: string, granularity: 'line' | 'page'): boolean {
  if (granularity === 'page') return matchesKey(data, 'pageDown') || data === '\x1b[6~';
  return matchesKey(data, 'ctrl+down') || data === '\x1b[1;5B' || isSgrMouseWheel(data, 'down');
}

function isSgrMouseWheel(data: string, direction: 'up' | 'down'): boolean {
  const match = /^\x1b\[<(\d+);\d+;\d+M$/.exec(data);
  if (!match) return false;
  const button = Number(match[1]);
  if ((button & 64) === 0) return false;
  return direction === 'up' ? (button & 1) === 0 : (button & 1) === 1;
}

function parseArgs(argv: string[]): TuiCliOptions {
  const options: TuiCliOptions = { eventMode: 'progress', orchestrate: false, agentCatalogPaths: [], dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--help': options.help = true; break;
      case '--dry-run': options.dryRun = true; break;
      case '--orchestrate': options.orchestrate = true; break;
      case '--catalog': options.agentCatalogPaths.push(requireValue(arg, argv[++index])); break;
      case '--cwd': options.cwd = requireValue(arg, argv[++index]); break;
      case '--agent': options.agentConfigPath = requireValue(arg, argv[++index]); break;
      case '--settings': options.settingsConfigPath = requireValue(arg, argv[++index]); break;
      case '--runtime': options.runtimeMode = parseEnum(requireValue(arg, argv[++index]), ['memory', 'postgres'] as const, arg); break;
      case '--provider': options.provider = parseEnum(requireValue(arg, argv[++index]), ['openrouter', 'ollama', 'mistral', 'mesh'] as const, arg); break;
      case '--model': options.model = requireValue(arg, argv[++index]); break;
      case '--approval': options.approvalMode = parseEnum(requireValue(arg, argv[++index]), ['auto', 'manual', 'reject'] as const, arg); break;
      case '--clarification': options.clarificationMode = parseEnum(requireValue(arg, argv[++index]), ['interactive', 'fail'] as const, arg); break;
      case '--event': options.eventMode = parseEnum(requireValue(arg, argv[++index]), ['progress', 'compact', 'verbose', 'off'] as const, arg); break;
      default: throw new Error(`Unknown argument: ${arg}\n\n${USAGE}`);
    }
  }
  return options;
}

function buildSdkOptions(cli: TuiCliOptions): AgentSdkOptions {
  return {
    cwd: cli.cwd,
    agentConfigPath: cli.agentConfigPath,
    settingsConfigPath: cli.settingsConfigPath,
    runtimeMode: cli.runtimeMode,
    model: cli.provider || cli.model ? { ...(cli.provider ? { provider: cli.provider } : {}), ...(cli.model ? { model: cli.model } : {}) } : undefined,
    settingsConfig: cli.approvalMode || cli.clarificationMode
      ? {
          interaction: {
            ...(cli.approvalMode ? { approvalMode: cli.approvalMode } : {}),
            ...(cli.clarificationMode ? { clarificationMode: cli.clarificationMode } : {}),
          },
        }
      : undefined,
  };
}

function splitPathAndRest(value: string, commandName: string): { path: string; rest: string } {
  const match = /^"([^"]+)"\s+(.+)$/.exec(value) ?? /^'(.*?)'\s+(.+)$/.exec(value) ?? /^(\S+)\s+(.+)$/.exec(value);
  if (!match) throw new Error(`${commandName.trim()} requires a path and a goal`);
  return { path: match[1], rest: match[2].trim() };
}

function inferAudioFormat(path: string): NonNullable<AudioInput['format']> {
  switch (extname(path).toLowerCase()) {
    case '.wav': return 'wav';
    case '.mp3': return 'mp3';
    case '.flac': return 'flac';
    case '.m4a': return 'm4a';
    case '.ogg': return 'ogg';
    case '.aac': return 'aac';
    case '.aiff':
    case '.aif': return 'aiff';
    case '.pcm16': return 'pcm16';
    case '.pcm24': return 'pcm24';
    default: throw new Error(`Unable to infer audio format from path "${path}". Supported extensions: .wav, .mp3, .flac, .m4a, .ogg, .aac, .aiff, .aif, .pcm16, .pcm24.`);
  }
}

function parseSteer(command: string, currentRunId?: string): { runId: string; role: 'user' | 'system'; message: string } {
  const rest = command.slice('/steer'.length).trim();
  if (!rest) throw new Error('/steer requires a message');
  const tokens = rest.split(/\s+/);
  let role: 'user' | 'system' = 'user';
  let offset = 0;
  if (tokens[0] === '--role') {
    role = parseEnum(tokens[1] ?? '', ['user', 'system'], '--role');
    offset = 2;
  }
  const remaining = tokens.slice(offset);
  if (remaining.length === 0) throw new Error('/steer requires a message');
  const first = remaining[0];
  const hasExplicitRunId = looksLikeRunId(first) && remaining.length > 1;
  const runId = hasExplicitRunId ? first : currentRunId;
  if (!runId) throw new Error('/steer requires a runId when no current run is known');
  const message = (hasExplicitRunId ? remaining.slice(1) : remaining).join(' ').trim();
  if (!message) throw new Error('/steer requires a message');
  return { runId, role, message };
}

function looksLikeRunId(value: string): boolean {
  return /^(run[_-]|[0-9a-f]{8}-[0-9a-f-]{27,})/i.test(value);
}

function formatConfig(state: TuiClientState, sdk: AgentSdk): string {
  return [
    `agent: ${state.agentId} (${state.agentName})`,
    `model: ${state.provider}/${state.model}`,
    `runtime: ${state.runtimeMode}`,
    `workspace: ${sdk.config.workspaceRoot}`,
    `shellCwd: ${sdk.config.shellCwd}`,
    `approval: ${sdk.config.interaction.approvalMode}`,
    `clarification: ${sdk.config.interaction.clarificationMode}`,
  ].join('\n');
}

function formatEvent(event: AgentEvent): string {
  const parts = [`${event.type}`, shortId(event.runId)];
  if (event.stepId) parts.push(`step=${shortId(event.stepId)}`);
  const toolName = readPayloadString(event.payload, 'toolName');
  if (toolName) parts.push(`tool=${toolName}`);
  const status = readPayloadString(event.payload, 'status') ?? readPayloadString(event.payload, 'toStatus');
  if (status) parts.push(`status=${status}`);
  const message = readPayloadString(event.payload, 'message') ?? readPayloadString(event.payload, 'error');
  if (message) parts.push(chalk.dim(message));
  return parts.join(' | ');
}

function formatOrchestrationEvent(event: OrchestrationLifecycleEvent): string {
  const parts = [event.type, `session=${shortId(event.sessionId)}`];
  if ('nodeId' in event) parts.push(`node=${event.nodeId}`, `agent=${event.agentId}`, `stage=${event.stage}`);
  if ('runId' in event) parts.push(`run=${shortId(event.runId)}`);
  if ('finalRunId' in event) parts.push(`run=${shortId(event.finalRunId)}`);
  if ('status' in event) parts.push(`status=${event.status}`);
  if ('executionShape' in event) parts.push(`shape=${event.executionShape}`);
  if (event.type === 'orchestration.plan.created') {
    parts.push(`nodes=${event.nodes.map((node) => `${node.id}:${node.agentId}`).join(',') || '(none)'}`);
  }
  if ('routingReason' in event) parts.push(chalk.dim(event.routingReason));
  return parts.join(' | ');
}

function formatOutput(output: JsonValue): string {
  if (typeof output === 'string') return output;
  return `\`\`\`json\n${JSON.stringify(output, null, 2)}\n\`\`\``;
}

function readPayloadString(payload: JsonValue, key: string): string | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  const value = (payload as JsonObject)[key];
  return typeof value === 'string' ? value : undefined;
}

function readPayloadUsage(payload: JsonValue): UsageSummary | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  const usage = (payload as JsonObject).usage;
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) return undefined;
  const promptTokens = readNumberField(usage, 'promptTokens');
  const completionTokens = readNumberField(usage, 'completionTokens');
  if (promptTokens === undefined || completionTokens === undefined) return undefined;
  return {
    promptTokens,
    completionTokens,
    reasoningTokens: readNumberField(usage, 'reasoningTokens'),
    totalTokens: readNumberField(usage, 'totalTokens'),
    estimatedCostUSD: readNumberField(usage, 'estimatedCostUSD') ?? 0,
    provider: readStringField(usage, 'provider'),
    model: readStringField(usage, 'model'),
  };
}

function readNumberField(value: JsonValue, key: string): number | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const field = (value as JsonObject)[key];
  return typeof field === 'number' ? field : undefined;
}

function readStringField(value: JsonValue, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const field = (value as JsonObject)[key];
  return typeof field === 'string' ? field : undefined;
}

function readEventTimestamp(event: AgentEvent): Date {
  const timestamp = new Date(event.createdAt);
  return Number.isFinite(timestamp.getTime()) ? timestamp : new Date();
}

function readOrchestrationEventTimestamp(event: OrchestrationLifecycleEvent): Date {
  const timestamp = new Date(event.createdAt);
  return Number.isFinite(timestamp.getTime()) ? timestamp : new Date();
}

function isTerminalRunEvent(event: AgentEvent): boolean {
  if (event.type === 'run.completed' || event.type === 'run.failed') return true;
  const status = readPayloadString(event.payload, 'status') ?? readPayloadString(event.payload, 'toStatus');
  return status ? TERMINAL_RUN_STATUSES.has(status as RunStatus) : false;
}

function shortId(id: string): string {
  return id.length <= 12 ? id : id.slice(0, 12);
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function parseEnum<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${label} must be one of: ${allowed.join(', ')}`);
}

main()
  .then((code) => {
    stdout.write('');
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
