#!/usr/bin/env bun

import { stdin as input, stdout as output } from 'node:process';
import chalk from 'chalk';

import type { AgentEventFrame, OutboundFrame, SessionOpenedFrame, SessionUpdatedFrame } from './protocol.js';
import { GATEWAY_CONFIG_PATH, loadLocalGatewayConnectionConfig } from './local-dev.js';
import { mintLocalDevJwt } from './local-dev-jwt.js';
import {
  type ClientOptions,
  type Deferred,
  createDeferred,
  normalizeConnectHost,
  parseCsv,
  parseFrame,
  parsePort,
  requireValue,
  resolveSocketUrl,
} from './local-ws-client/common.js';
import {
  defaultEditorTheme,
  StatusBar,
  MessageLog,
  InputPanel,
  TuiShell,
  createApprovalDialog,
  createClarificationDialog,
  type TuiClientState,
  type ApprovalInfo,
  type ClarificationInfo,
} from './tui/index.js';
import {
  getInteractiveSessionMode,
  isEventsCommand,
  parseClarifyCommand,
  parseEventsCommand,
  parseApproveCommand,
  parseRetryCommand,
  recordFailedRunFromAgentEvent,
  recordInteractiveSession,
  selectInteractiveSession,
} from './local-ws-client/interactive.js';
import { formatCompactAgentEventFrame } from './local-event-format.js';
import { isClarificationRequestOutput, shortRunId } from './local-ws-client/render.js';

import {
  TUI,
  ProcessTerminal,
  Editor,
  type OverlayHandle,
} from '@mariozechner/pi-tui';

const HELP_TEXT = `Commands:
  <text>                     send a chat message with message.send
  /run <goal>                send run.start via a dedicated run session
  /retry [runId]             retry a failed run in the current run session
  /approve [runId] [yes|no]  resolve the pending approval for the session
  /clarify [runId] <text>    answer a pending clarification for a run
  /event [on [verbose]|off]  stream one-line, detailed, or muted realtime agent.event frames
  /ping                      send a ping frame
  /session                   print the active session id
  /clear                     clear the message log
  /help                      show this help
  /exit                      close the socket and exit`;

const USAGE = `Usage:
  bun run ./packages/gateway-fastify/src/local-ws-client-tui.ts [options]

Options:
  --url <ws-url>             Full WebSocket URL override
  --host <host>              Default: derived from local gateway config or 127.0.0.1
  --port <port>              Default: derived from local gateway config or 8959
  --path <path>              Default: derived from local gateway config or /ws
  --channel <id>             Session channelId and upgrade query param (default: web)
  --session-id <id>          Reattach an existing session instead of opening a new one
  --sub, --subject <value>   JWT subject claim (default: local-dev-user)
  --tenant <value>           JWT tenant claim
  --role <value>             Add a JWT role claim; can be repeated
  --roles <a,b,c>            Add multiple comma-separated JWT roles
  --token <jwt>              Use this JWT instead of auto-minting one
  --message <text>           Send one chat message after opening the session, then exit
  --run <goal>               Send one session-bound run.start after opening the session, then exit
  --verbose                  Print every received frame as JSON
  --help                     Show this help text

Examples:
  bun run gateway:ws-client-tui
  bun run gateway:ws-client-tui --message "Hello there"
  bun run gateway:ws-client-tui --run "Summarize the repository"
  bun run gateway:ws-client-tui --sub alice --tenant acme --role admin`;

function recordLiveAgentEvent(state: TuiClientState, frame: AgentEventFrame): void {
  const payload = asRecord(frame.data);
  const status = readString(payload, 'toStatus') ?? readString(payload, 'status');
  const toolName = readString(payload, 'toolName');
  const error = readFailureText(payload);
  const message = readString(payload, 'message');

  state.latestAgentEvent = {
    eventType: frame.eventType,
    compactText: formatCompactAgentEventFrame(frame, { includeSeq: false }),
    runId: frame.runId,
    seq: frame.seq,
    status,
    toolName,
    detail: error ?? message,
    timestamp: new Date(),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readFailureText(record: Record<string, unknown>): string | undefined {
  return readString(record, 'error') ?? readString(record, 'reason') ?? readString(record, 'message');
}

function formatRunOutput(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }

  const json = JSON.stringify(output, null, 2);
  return json ? `\`\`\`json\n${json}\n\`\`\`` : '';
}

async function parseArgs(args: string[]): Promise<ClientOptions> {
  const connectionConfig = await loadLocalGatewayConnectionConfig();
  const options: ClientOptions = {
    url: undefined,
    host: normalizeConnectHost(connectionConfig?.host),
    port: connectionConfig?.port ?? 8959,
    path: connectionConfig?.websocketPath ?? '/ws',
    channel: 'web',
    sessionId: undefined,
    subject: 'local-dev-user',
    tenantId: undefined,
    roles: [],
    token: undefined,
    message: undefined,
    runGoal: undefined,
    verbose: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case '--url':
        options.url = requireValue(arg, args[index + 1]);
        index += 1;
        break;
      case '--host':
        options.host = requireValue(arg, args[index + 1]);
        index += 1;
        break;
      case '--port':
        options.port = parsePort(requireValue(arg, args[index + 1]));
        index += 1;
        break;
      case '--path':
        options.path = requireValue(arg, args[index + 1]);
        index += 1;
        break;
      case '--channel':
        options.channel = requireValue(arg, args[index + 1]);
        index += 1;
        break;
      case '--session-id':
        options.sessionId = requireValue(arg, args[index + 1]);
        index += 1;
        break;
      case '--sub':
      case '--subject':
        options.subject = requireValue(arg, args[index + 1]);
        index += 1;
        break;
      case '--tenant':
        options.tenantId = requireValue(arg, args[index + 1]);
        index += 1;
        break;
      case '--role':
        options.roles.push(requireValue(arg, args[index + 1]));
        index += 1;
        break;
      case '--roles':
        options.roles.push(...parseCsv(requireValue(arg, args[index + 1])));
        index += 1;
        break;
      case '--token':
        options.token = requireValue(arg, args[index + 1]);
        index += 1;
        break;
      case '--message':
        options.message = requireValue(arg, args[index + 1]);
        index += 1;
        break;
      case '--run':
        options.runGoal = requireValue(arg, args[index + 1]);
        index += 1;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}\n\n${USAGE}`);
    }
  }

  if (options.message && options.runGoal) {
    throw new Error('Use only one of --message or --run.');
  }

  options.roles = [...new Set(options.roles)];
  return options;
}

async function runTuiMode(
  options: ClientOptions,
  token: string,
  socketUrl: string,
  state: TuiClientState,
): Promise<void> {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  const messageLog = new MessageLog();
  const statusBar = new StatusBar(state);
  const editor = new Editor(tui, defaultEditorTheme);
  const inputPanel = new InputPanel(state, editor);
  const shell = new TuiShell(terminal, statusBar, messageLog, inputPanel);
  tui.addChild(shell);
  tui.setFocus(editor);

  const socketReady = createDeferred<void>();
  const closed = createDeferred<{ code: number; reason: string }>();
  let pendingSessionOpen: ReturnType<typeof createDeferred<SessionOpenedFrame>> | undefined;

  const BunWebSocket = WebSocket as {
    new (url: string | URL, options?: Bun.WebSocketOptions): WebSocket;
  };
  const socket = new BunWebSocket(socketUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  type PendingModal =
    | { type: 'approval'; approvalInfo: ApprovalInfo }
    | { type: 'clarification'; clarificationInfo: ClarificationInfo };

  const modalQueue: PendingModal[] = [];
  let activeModal: OverlayHandle | undefined;
  let activeModalCleanup: (() => void) | undefined;

  messageLog.addMessage({
    type: 'system',
    content: `Connecting to ${socketUrl}...`,
    timestamp: new Date(),
  });

  function sendFrame(frame: Record<string, unknown>): void {
    socket.send(JSON.stringify(frame));
  }

  function enqueueModal(modal: PendingModal): void {
    modalQueue.push(modal);
    showNextModal();
  }

  function closeActiveModal(): void {
    activeModal?.hide();
    activeModal = undefined;
    activeModalCleanup?.();
    activeModalCleanup = undefined;
    tui.setFocus(editor);
    tui.requestRender();
  }

  function finishActiveModal(): void {
    closeActiveModal();
    showNextModal();
  }

  function showNextModal(): void {
    if (activeModal || modalQueue.length === 0) {
      return;
    }

    const modal = modalQueue.shift();
    if (!modal) {
      return;
    }

    if (modal.type === 'approval') {
      showApprovalModal(modal.approvalInfo);
      return;
    }

    showClarificationModal(modal.clarificationInfo);
  }

  function showApprovalModal(approvalInfo: ApprovalInfo): void {
    const { dialog, selectList } = createApprovalDialog(tui, approvalInfo);
    activeModal = tui.showOverlay(dialog, { width: '60%', maxHeight: '80%', anchor: 'center' });

    selectList.onSelect = (item) => {
      const approved = item.value === 'yes';
      const approvalSessionId = state.approvalSessionIds.get(approvalInfo.runId);
      if (!approvalSessionId) {
        messageLog.addMessage({
          type: 'system',
          content: 'Error: No sessionId tracked for this approval.',
          timestamp: new Date(),
        });
        return;
      }
      sendFrame({
        type: 'approval.resolve',
        sessionId: approvalSessionId,
        runId: approvalInfo.runId,
        approved,
      });
      state.pendingApprovalRunId = undefined;
      state.approvalSessionIds.delete(approvalInfo.runId);
      statusBar.invalidate();
      finishActiveModal();
    };

    selectList.onCancel = () => {
      finishActiveModal();
    };

    tui.setFocus(selectList);
  }

  function showClarificationModal(clarificationInfo: ClarificationInfo): void {
    const dialog = createClarificationDialog(tui, clarificationInfo);
    activeModal = tui.showOverlay(dialog, { width: '75%', maxHeight: '85%', anchor: 'center' });
    activeModalCleanup = tui.addInputListener((data) => {
      if (data === '\x1b') {
        finishActiveModal();
        return { consume: true };
      }
      return undefined;
    });

    const editorInstance = dialog.getEditor();
    editorInstance.onSubmit = (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return;
      }
      const clarificationSessionId = state.clarificationSessionIds.get(clarificationInfo.runId);
      if (!clarificationSessionId) {
        messageLog.addMessage({
          type: 'system',
          content: 'Error: No sessionId tracked for this clarification.',
          timestamp: new Date(),
        });
        return;
      }
      sendFrame({
        type: 'clarification.resolve',
        sessionId: clarificationSessionId,
        runId: clarificationInfo.runId,
        message: trimmed,
      });
      state.pendingClarificationRunId = undefined;
      state.clarificationSessionIds.delete(clarificationInfo.runId);
      statusBar.invalidate();
      finishActiveModal();
    };
    tui.setFocus(editorInstance);
  }

  socket.addEventListener('open', () => {
    state.connected = true;
    statusBar.invalidate();
    tui.requestRender();
    socketReady.resolve();
  });

  socket.addEventListener('message', async (event) => {
    const frame = parseFrame(event.data);

    if (options.verbose && (frame.type !== 'agent.event' || state.eventMode !== 'off')) {
      messageLog.addMessage({
        type: 'system',
        content: `< ${JSON.stringify(frame)}`,
        timestamp: new Date(),
      });
    }

    switch (frame.type) {
      case 'session.opened':
        messageLog.addMessage({
          type: 'system',
          content: `Session opened: ${frame.sessionId} (${frame.status})`,
          timestamp: new Date(),
        });
        statusBar.invalidate();
        tui.requestRender();
        if (pendingSessionOpen) {
          pendingSessionOpen.resolve(frame);
          pendingSessionOpen = undefined;
          break;
        }
        break;

      case 'session.updated':
        hydratePendingApprovalFromSessionUpdate(state, frame);
        messageLog.addMessage({
          type: 'system',
          content: `Session updated: ${frame.status} (activeRunId=${frame.activeRunId ?? 'none'})`,
          timestamp: new Date(),
        });
        statusBar.invalidate();
        break;

      case 'message.output':
        messageLog.addMessage({
          type: 'assistant',
          content: frame.message.content,
          timestamp: new Date(),
        });
        tui.requestRender();
        break;

      case 'run.output':
        if (frame.status === 'failed') {
          state.lastFailedRunId = frame.runId;
          if (frame.sessionId) {
            state.failedRunSessionIds.set(frame.runId, frame.sessionId);
          }
          messageLog.addMessage({
            type: 'system',
            content: `${shortRunId(frame.runId)} failed: ${frame.error ?? 'unknown error'}`,
            timestamp: new Date(),
          });
          if (state.pendingClarificationRunId === frame.runId) {
            state.pendingClarificationRunId = undefined;
            state.clarificationSessionIds.delete(frame.runId);
          }
        } else {
          if (isClarificationRequestOutput(frame.output)) {
            state.pendingClarificationRunId = frame.runId;
            if (frame.sessionId) {
              state.clarificationSessionIds.set(frame.runId, frame.sessionId);
            }
            messageLog.addMessage({
              type: 'system',
              content: `clarification requested for run ${frame.runId}: ${frame.output.message}`,
              timestamp: new Date(),
            });
            statusBar.invalidate();
            tui.requestRender();
            enqueueModal({
              type: 'clarification',
              clarificationInfo: {
                runId: frame.runId,
                message: frame.output.message,
                suggestedQuestions: frame.output.suggestedQuestions,
                sessionId: frame.sessionId,
              },
            });
          } else {
            if (state.pendingClarificationRunId === frame.runId) {
              state.pendingClarificationRunId = undefined;
              state.clarificationSessionIds.delete(frame.runId);
            }
            messageLog.addMessage({
              type: 'run',
              content: formatRunOutput(frame.output),
              timestamp: new Date(),
            });
            tui.requestRender();
          }
        }
        statusBar.invalidate();
        tui.requestRender();
        break;

      case 'approval.requested':
        state.pendingApprovalRunId = frame.runId;
        if (frame.sessionId) {
          state.approvalSessionIds.set(frame.runId, frame.sessionId);
        }
        messageLog.addMessage({
          type: 'system',
          content: `approval requested for run ${frame.runId}${frame.toolName ? ` (${frame.toolName})` : ''}${frame.reason ? `\nreason: ${frame.reason}` : ''}`,
          timestamp: new Date(),
        });
        statusBar.invalidate();
        tui.requestRender();
        enqueueModal({
          type: 'approval',
          approvalInfo: {
            runId: frame.runId,
            toolName: frame.toolName,
            reason: frame.reason,
            sessionId: frame.sessionId,
          },
        });
        break;

      case 'agent.event':
        recordLiveAgentEvent(state, frame);
        recordFailedRunFromAgentEvent(state, frame);
        if (state.eventMode === 'off') {
          tui.requestRender();
          break;
        }
        messageLog.addMessage({
          type: 'event',
          content: formatCompactAgentEventFrame(frame, { prefixStyle: 'seq' }),
          timestamp: new Date(),
        });
        tui.requestRender();
        break;

      case 'error':
        messageLog.addMessage({
          type: 'system',
          content: `error[${frame.code}]: ${frame.message}`,
          timestamp: new Date(),
        });
        tui.requestRender();
        break;

      case 'pong':
        messageLog.addMessage({
          type: 'system',
          content: `pong${frame.id ? ` (${frame.id})` : ''}`,
          timestamp: new Date(),
        });
        tui.requestRender();
        break;
    }
  });

  socket.addEventListener('close', (event) => {
    state.connected = false;
    statusBar.invalidate();
    tui.requestRender();
    messageLog.addMessage({
      type: 'system',
      content: `Socket closed (${event.code}${event.reason ? `: ${event.reason}` : ''})`,
      timestamp: new Date(),
    });
    rejectIfPending(socketReady, new Error('Socket closed before the socket finished opening.'));
    if (pendingSessionOpen) {
      rejectIfPending(pendingSessionOpen, new Error('Socket closed before an additional session.opened was received.'));
      pendingSessionOpen = undefined;
    }
    resolveIfPending(closed, { code: event.code, reason: event.reason });
  });

  socket.addEventListener('error', () => {
    messageLog.addMessage({
      type: 'system',
      content: 'WebSocket error encountered.',
      timestamp: new Date(),
    });
  });

  tui.onDebug = () => {
    messageLog.addMessage({
      type: 'system',
      content: `Debug: sessionId=${state.sessionId ?? 'none'}, runSessionId=${state.runSessionId ?? 'none'}, pendingApproval=${state.pendingApprovalRunId ?? 'none'}`,
      timestamp: new Date(),
    });
    tui.requestRender();
  };

  async function openAdditionalSession(sessionId?: string): Promise<SessionOpenedFrame> {
    await socketReady.promise;
    if (pendingSessionOpen) {
      throw new Error('A session.open request is already in flight.');
    }
    pendingSessionOpen = createDeferred<SessionOpenedFrame>();
    sendFrame({
      type: 'session.open',
      channelId: options.channel,
      ...(sessionId ? { sessionId } : {}),
    });
    try {
      return await pendingSessionOpen.promise;
    } finally {
      pendingSessionOpen = undefined;
    }
  }

  async function ensureChatSessionId(): Promise<string> {
    const chatTarget = selectInteractiveSession('chat', state);
    if (chatTarget.sessionId) {
      return chatTarget.sessionId;
    }

    const chatSession = await openAdditionalSession();
    recordInteractiveSession(state, 'chat', chatSession.sessionId);
    messageLog.addMessage({
      type: 'system',
      content: `Chat session ready: ${chatSession.sessionId}`,
      timestamp: new Date(),
    });
    statusBar.invalidate();
    tui.requestRender();
    return chatSession.sessionId;
  }

  async function ensureRunSessionId(): Promise<string> {
    const runTarget = selectInteractiveSession('run', state);
    if (runTarget.sessionId) {
      return runTarget.sessionId;
    }

    const runSession = await openAdditionalSession();
    recordInteractiveSession(state, 'run', runSession.sessionId);
    messageLog.addMessage({
      type: 'system',
      content: `Run session ready: ${runSession.sessionId}`,
      timestamp: new Date(),
    });
    statusBar.invalidate();
    tui.requestRender();
    return runSession.sessionId;
  }

  await socketReady.promise;

  if (options.sessionId) {
    const attachedSession = await openAdditionalSession(options.sessionId);
    recordInteractiveSession(state, getInteractiveSessionMode(attachedSession), attachedSession.sessionId);
  }

  editor.onSubmit = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;

    if (trimmed === '/exit' || trimmed === '/quit') {
      socket.close();
      return;
    }

    if (trimmed === '/help') {
      messageLog.addMessage({
        type: 'system',
        content: HELP_TEXT,
        timestamp: new Date(),
      });
      tui.requestRender();
      return;
    }

    if (trimmed === '/session') {
      messageLog.addMessage({
        type: 'system',
        content: `chatSessionId=${state.sessionId ?? '(none)'}\nrunSessionId=${state.runSessionId ?? '(none)'}`,
        timestamp: new Date(),
      });
      tui.requestRender();
      return;
    }

    if (trimmed === '/clear') {
      messageLog.clear();
      tui.requestRender();
      return;
    }

    if (isEventsCommand(trimmed)) {
      const { eventMode, message } = parseEventsCommand(trimmed, state.eventMode);
      state.eventMode = eventMode;
      messageLog.addMessage({
        type: 'system',
        content: message,
        timestamp: new Date(),
      });
      statusBar.invalidate();
      tui.requestRender();
      return;
    }

    if (trimmed === '/ping') {
      sendFrame({ type: 'ping', id: `ping-${Date.now()}` });
      return;
    }

    if (trimmed.startsWith('/run ')) {
      try {
        const runSessionId = await ensureRunSessionId();
        messageLog.addMessage({
          type: 'user',
          content: trimmed,
          timestamp: new Date(),
        });
        sendFrame({
          type: 'run.start',
          sessionId: runSessionId,
          goal: trimmed.slice('/run '.length).trim(),
        });
        tui.requestRender();
      } catch (error) {
        messageLog.addMessage({
          type: 'system',
          content: `Error: ${error instanceof Error ? error.message : String(error)}`,
          timestamp: new Date(),
        });
        tui.requestRender();
      }
      return;
    }

    if (trimmed === '/retry' || trimmed.startsWith('/retry ')) {
      try {
        const runId = parseRetryCommand(trimmed, state.lastFailedRunId);
        const retrySessionId = state.failedRunSessionIds.get(runId) ?? state.runSessionId;
        if (!retrySessionId) {
          throw new Error(`No run sessionId is tracked for run "${runId}". Reattach the run session or pass a runId from this client session.`);
        }
        sendFrame({
          type: 'run.retry',
          sessionId: retrySessionId,
          runId,
        });
        statusBar.invalidate();
        tui.requestRender();
      } catch (error) {
        messageLog.addMessage({
          type: 'system',
          content: `Error: ${error instanceof Error ? error.message : String(error)}`,
          timestamp: new Date(),
        });
        tui.requestRender();
      }
      return;
    }

    if (trimmed.startsWith('/approve')) {
      try {
        const { runId, approved } = parseApproveCommand(trimmed, state.pendingApprovalRunId);
        const approvalSessionId = state.approvalSessionIds.get(runId);
        if (!approvalSessionId) {
          throw new Error(`No sessionId is tracked for run "${runId}". Wait for approval.requested or pass a runId from this client session.`);
        }
        sendFrame({
          type: 'approval.resolve',
          sessionId: approvalSessionId,
          runId,
          approved,
        });
        state.pendingApprovalRunId = undefined;
        state.approvalSessionIds.delete(runId);
        statusBar.invalidate();
        tui.requestRender();
      } catch (error) {
        messageLog.addMessage({
          type: 'system',
          content: `Error: ${error instanceof Error ? error.message : String(error)}`,
          timestamp: new Date(),
        });
        tui.requestRender();
      }
      return;
    }

    if (trimmed.startsWith('/clarify')) {
      try {
        const { runId, message: clarificationMessage } = parseClarifyCommand(
          trimmed,
          state.pendingClarificationRunId,
          new Set(state.clarificationSessionIds.keys()),
        );
        const clarificationSessionId = state.clarificationSessionIds.get(runId);
        if (!clarificationSessionId) {
          throw new Error(
            `No sessionId is tracked for run "${runId}". /clarify expects the runId from a formal clarification request, not a sessionId or rootRunId. Wait for a clarification request from this client first.`,
          );
        }
        sendFrame({
          type: 'clarification.resolve',
          sessionId: clarificationSessionId,
          runId,
          message: clarificationMessage,
        });
        state.pendingClarificationRunId = undefined;
        state.clarificationSessionIds.delete(runId);
        statusBar.invalidate();
        tui.requestRender();
      } catch (error) {
        messageLog.addMessage({
          type: 'system',
          content: `Error: ${error instanceof Error ? error.message : String(error)}`,
          timestamp: new Date(),
        });
        tui.requestRender();
      }
      return;
    }

    try {
      const sessionId = await ensureChatSessionId();
      messageLog.addMessage({
        type: 'user',
        content: trimmed,
        timestamp: new Date(),
      });
      sendFrame({
        type: 'message.send',
        sessionId,
        content: trimmed,
      });
      tui.requestRender();
    } catch (error) {
      messageLog.addMessage({
        type: 'system',
        content: `Error: ${error instanceof Error ? error.message : String(error)}`,
        timestamp: new Date(),
      });
      tui.requestRender();
    }
  };

  tui.start();
  try {
    await closed.promise;
  } finally {
    tui.stop();
  }
}

function resolveIfPending<T>(deferred: Deferred<T>, value: T): void {
  if (!deferred.isSettled()) {
    deferred.resolve(value);
  }
}

function rejectIfPending<T>(deferred: Deferred<T>, reason: unknown): void {
  if (!deferred.isSettled()) {
    deferred.reject(reason);
  }
}

function hydratePendingApprovalFromSessionUpdate(state: TuiClientState, frame: SessionUpdatedFrame): void {
  if (frame.status === 'awaiting_approval' && frame.activeRunId) {
    state.pendingApprovalRunId = frame.activeRunId;
    state.approvalSessionIds.set(frame.activeRunId, frame.sessionId);
    return;
  }

  if (state.pendingApprovalRunId && frame.status !== 'awaiting_approval') {
    state.approvalSessionIds.delete(state.pendingApprovalRunId);
    state.pendingApprovalRunId = undefined;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(USAGE);
    return;
  }

  const options = await parseArgs(args);
  const state: TuiClientState = {
    channel: options.channel,
    tenantId: options.tenantId,
    roles: options.roles,
    eventMode: 'compact',
    approvalSessionIds: new Map(),
    clarificationSessionIds: new Map(),
    failedRunSessionIds: new Map(),
    connected: false,
  };
  const token = options.token ?? (await mintLocalDevJwt({
    subject: options.subject,
    tenantId: options.tenantId,
    roles: options.roles,
  })).token;
  const socketUrl = await resolveSocketUrl(options);

  if (!input.isTTY || !output.isTTY) {
    console.error('This client requires a TTY. Use --message or --run for non-interactive usage with the regular client:');
    console.error('  bun run gateway:client:local --help');
    process.exit(1);
  }

  await runTuiMode(options, token, socketUrl, state);
}

if (import.meta.main) {
  await main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to run local gateway WebSocket client: ${message}`);
    console.error(`Tip: ensure the gateway is running and check ${GATEWAY_CONFIG_PATH} for local config.`);
    process.exit(1);
  });
}
