#!/usr/bin/env bun

import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

import type { SessionOpenedFrame } from './protocol.js';
import { GATEWAY_CONFIG_PATH, loadLocalGatewayConnectionConfig } from './local-dev.js';
import { mintLocalDevJwt } from './local-dev-jwt.js';
import { formatCompactAgentEventFrame } from './local-event-format.js';
import {
  type ClientOptions,
  type EventStreamMode,
  createDeferred,
  hydratePendingApprovalFromSessionUpdate,
  normalizeConnectHost,
  parseCsv,
  parseFrame,
  parsePort,
  rejectIfPending,
  requireValue,
  resolveIfPending,
  resolveSocketUrl,
  sendFrame,
} from './local-ws-client/common.js';
import {
  getInteractiveSessionMode,
  isEventsCommand,
  parseClarifyCommand,
  parseEventsCommand,
  parseRetryCommand,
  parseApproveCommand,
  recordFailedRunFromAgentEvent,
  recordInteractiveSession,
  selectInteractiveSession,
  type FailedRunTrackingState,
  type InteractiveSessionState,
} from './local-ws-client/interactive.js';
import {
  formatVerboseAgentEventFrame,
  isClarificationRequestOutput,
  renderMarkedValue,
  shortRunId,
} from './local-ws-client/render.js';

export { formatCompactAgentEventFrame } from './local-event-format.js';
export type { EventStreamMode } from './local-ws-client/common.js';
export type { FailedRunTrackingState } from './local-ws-client/interactive.js';
export {
  getInteractiveSessionMode,
  parseClarifyCommand,
  parseEventsCommand,
  parseRetryCommand,
  recordFailedRunFromAgentEvent,
  recordInteractiveSession,
  selectInteractiveSession,
} from './local-ws-client/interactive.js';

interface ClientState extends InteractiveSessionState, FailedRunTrackingState {
  pendingApprovalRunId?: string;
  pendingClarificationRunId?: string;
  eventMode: EventStreamMode;
  approvalSessionIds: Map<string, string>;
  clarificationSessionIds: Map<string, string>;
}

const HELP_TEXT = `Commands:
  <text>                     send a chat message with message.send
  /run <goal>                send run.start via a dedicated run session
  /retry [runId]             retry a failed run in the current run session
  /approve [runId] [yes|no]  resolve the pending approval for the session
  /clarify [runId] <text>    answer a pending clarification for a run
  /event [on [verbose]|off]  stream one-line, detailed, or muted realtime agent.event frames
  /ping                      send a ping frame
  /session                   print the active session id
  /help                      show this help
  /exit                      close the socket and exit`;

const USAGE = `Usage:
  bun run ./packages/gateway-fastify/src/local-ws-client.ts [options]

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
  bun run gateway:ws-client
  bun run gateway:ws-client --message "Hello there"
  bun run gateway:ws-client --run "Summarize the repository"
  bun run gateway:ws-client --sub alice --tenant acme --role admin`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(USAGE);
    return;
  }

  const options = await parseArgs(args);
  const state: ClientState = {
    eventMode: 'compact',
    approvalSessionIds: new Map(),
    clarificationSessionIds: new Map(),
    failedRunSessionIds: new Map(),
  };
  const token = options.token ?? (await mintLocalDevJwt({
    subject: options.subject,
    tenantId: options.tenantId,
    roles: options.roles,
  })).token;
  const socketUrl = await resolveSocketUrl(options);

  console.log(`Connecting to ${socketUrl}`);

  const BunWebSocket = WebSocket as {
    new (url: string | URL, options?: Bun.WebSocketOptions): WebSocket;
  };
  const socket = new BunWebSocket(socketUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const socketReady = createDeferred<void>();
  let pendingSessionOpen: ReturnType<typeof createDeferred<SessionOpenedFrame>> | undefined;
  const terminalFrame = createDeferred<unknown>();
  let terminalFrameRequired = false;
  const closed = createDeferred<{ code: number; reason: string }>();

  socket.addEventListener('open', () => {
    socketReady.resolve();
  });

  socket.addEventListener('message', (event) => {
    const frame = parseFrame(event.data);

    if (options.verbose && (frame.type !== 'agent.event' || state.eventMode !== 'off')) {
      console.log(`< ${JSON.stringify(frame)}`);
    }

    switch (frame.type) {
      case 'session.opened':
        console.log(`Session opened: ${frame.sessionId} (${frame.status})`);
        if (pendingSessionOpen) {
          pendingSessionOpen.resolve(frame);
          pendingSessionOpen = undefined;
          break;
        }
        break;
      case 'session.updated':
        hydratePendingApprovalFromSessionUpdate(state, frame);
        console.log(`Session updated: ${frame.status} (activeRunId=${frame.activeRunId ?? 'none'})`);
        break;
      case 'message.output':
        console.log('assistant>');
        console.log(renderMarkedValue(frame.message.content));
        resolveIfPending(terminalFrame, frame);
        break;
      case 'run.output':
        if (frame.status === 'failed') {
          console.log(`${shortRunId(frame.runId)} failed: ${frame.error ?? 'unknown error'}`);
          state.lastFailedRunId = frame.runId;
          if (frame.sessionId) {
            state.failedRunSessionIds.set(frame.runId, frame.sessionId);
          }
          if (state.pendingClarificationRunId === frame.runId) {
            state.pendingClarificationRunId = undefined;
            state.clarificationSessionIds.delete(frame.runId);
          }
        } else if (isClarificationRequestOutput(frame.output)) {
          state.pendingClarificationRunId = frame.runId;
          if (frame.sessionId) {
            state.clarificationSessionIds.set(frame.runId, frame.sessionId);
          }
          console.log(`clarification requested for run ${frame.runId}`);
          console.log(`question: ${frame.output.message}`);
          if (frame.output.suggestedQuestions.length > 0) {
            console.log(`suggested: ${frame.output.suggestedQuestions.join(' | ')}`);
          }
          console.log('Use /clarify <text> or /clarify <runId> <text> in interactive mode.');
        } else {
          if (state.pendingClarificationRunId === frame.runId) {
            state.pendingClarificationRunId = undefined;
            state.clarificationSessionIds.delete(frame.runId);
          }
          console.log('run output>');
          console.log(renderMarkedValue(frame.output));
        }
        resolveIfPending(terminalFrame, frame);
        break;
      case 'approval.requested':
        state.pendingApprovalRunId = frame.runId;
        if (frame.sessionId) {
          state.approvalSessionIds.set(frame.runId, frame.sessionId);
        }
        console.log(`approval requested for run ${frame.runId}${frame.toolName ? ` (${frame.toolName})` : ''}`);
        if (frame.reason) {
          console.log(`reason: ${frame.reason}`);
        }
        console.log('Use /approve yes or /approve no in interactive mode.');
        resolveIfPending(terminalFrame, frame);
        break;
      case 'agent.event':
        recordFailedRunFromAgentEvent(state, frame);
        if (state.eventMode === 'off') {
          break;
        }

        if (!options.verbose) {
          console.log(state.eventMode === 'compact' ? formatCompactAgentEventFrame(frame) : formatVerboseAgentEventFrame(frame));
        }
        break;
      case 'error':
        console.log(`error[${frame.code}]: ${frame.message}`);
        resolveIfPending(terminalFrame, frame);
        break;
      case 'pong':
        console.log(`pong${frame.id ? ` (${frame.id})` : ''}`);
        break;
    }
  });

  socket.addEventListener('close', (event) => {
    console.log(`Socket closed (${event.code}${event.reason ? `: ${event.reason}` : ''})`);
    rejectIfPending(socketReady, new Error('Socket closed before the socket finished opening.'));
    if (pendingSessionOpen) {
      rejectIfPending(pendingSessionOpen, new Error('Socket closed before an additional session.opened was received.'));
      pendingSessionOpen = undefined;
    }
    if (terminalFrameRequired) {
      rejectIfPending(terminalFrame, new Error('Socket closed before a terminal response was received.'));
    }
    closed.resolve({ code: event.code, reason: event.reason });
  });

  socket.addEventListener('error', () => {
    console.log('WebSocket error encountered.');
  });

  async function openAdditionalSession(sessionId?: string): Promise<SessionOpenedFrame> {
    await socketReady.promise;
    if (pendingSessionOpen) {
      throw new Error('A session.open request is already in flight. Wait for it to finish before opening another session.');
    }

    pendingSessionOpen = createDeferred<SessionOpenedFrame>();
    sendFrame(socket, {
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
    console.log(`Chat session ready: ${chatSession.sessionId}`);
    return chatSession.sessionId;
  }

  async function ensureRunSessionId(): Promise<string> {
    const runTarget = selectInteractiveSession('run', state);
    if (runTarget.sessionId) {
      return runTarget.sessionId;
    }

    const runSession = await openAdditionalSession();
    recordInteractiveSession(state, 'run', runSession.sessionId);
    console.log(`Run session ready: ${runSession.sessionId}`);
    return runSession.sessionId;
  }

  await socketReady.promise;

  if (options.sessionId) {
    const attachedSession = await openAdditionalSession(options.sessionId);
    recordInteractiveSession(state, getInteractiveSessionMode(attachedSession), attachedSession.sessionId);
  }

  if (options.message) {
    const sessionId = await ensureChatSessionId();
    terminalFrameRequired = true;
    sendFrame(socket, {
      type: 'message.send',
      sessionId,
      content: options.message,
    });
    await terminalFrame.promise;
    socket.close();
    await closed.promise;
    return;
  }

  if (options.runGoal) {
    const runSessionId = await ensureRunSessionId();
    terminalFrameRequired = true;
    sendFrame(socket, {
      type: 'run.start',
      sessionId: runSessionId,
      goal: options.runGoal,
    });
    await terminalFrame.promise;
    socket.close();
    await closed.promise;
    return;
  }

  if (!input.isTTY || !output.isTTY) {
    throw new Error('Interactive mode requires a TTY. Use --message or --run for non-interactive usage.');
  }

  console.log(HELP_TEXT);

  const rl = createInterface({ input, output });

  try {
    while (true) {
      const line = (await rl.question('gateway> ')).trim();
      if (line.length === 0) {
        continue;
      }

      if (line === '/exit' || line === '/quit') {
        socket.close();
        break;
      }

      if (line === '/help') {
        console.log(HELP_TEXT);
        continue;
      }

      if (line === '/session') {
        console.log(`chatSessionId=${state.sessionId ?? '(none)'}`);
        console.log(`runSessionId=${state.runSessionId ?? '(none)'}`);
        continue;
      }

      if (isEventsCommand(line)) {
        const { eventMode, message } = parseEventsCommand(line, state.eventMode);
        state.eventMode = eventMode;
        console.log(message);
        continue;
      }

      if (line === '/ping') {
        sendFrame(socket, { type: 'ping', id: `ping-${Date.now()}` });
        continue;
      }

      if (line.startsWith('/run ')) {
        const runSessionId = await ensureRunSessionId();
        sendFrame(socket, {
          type: 'run.start',
          sessionId: runSessionId,
          goal: line.slice('/run '.length).trim(),
        });
        continue;
      }

      if (line === '/retry' || line.startsWith('/retry ')) {
        const runId = parseRetryCommand(line, state.lastFailedRunId);
        const retrySessionId = state.failedRunSessionIds.get(runId) ?? state.runSessionId;
        if (!retrySessionId) {
          throw new Error(`No run sessionId is tracked for run "${runId}". Reattach the run session or pass a runId from this client session.`);
        }
        sendFrame(socket, {
          type: 'run.retry',
          sessionId: retrySessionId,
          runId,
        });
        continue;
      }

      if (line.startsWith('/approve')) {
        const { runId, approved } = parseApproveCommand(line, state.pendingApprovalRunId);
        const approvalSessionId = state.approvalSessionIds.get(runId);
        if (!approvalSessionId) {
          throw new Error(
            `No sessionId is tracked for run "${runId}". Wait for approval.requested or pass a runId from this client session.`,
          );
        }
        sendFrame(socket, {
          type: 'approval.resolve',
          sessionId: approvalSessionId,
          runId,
          approved,
        });
        continue;
      }

      if (line.startsWith('/clarify')) {
        const { runId, message } = parseClarifyCommand(
          line,
          state.pendingClarificationRunId,
          new Set(state.clarificationSessionIds.keys()),
        );
        const clarificationSessionId = state.clarificationSessionIds.get(runId);
        if (!clarificationSessionId) {
          throw new Error(
            `No sessionId is tracked for run "${runId}". /clarify expects the runId from a formal clarification request, not a sessionId or rootRunId. Wait for a clarification request from this client first.`,
          );
        }
        sendFrame(socket, {
          type: 'clarification.resolve',
          sessionId: clarificationSessionId,
          runId,
          message,
        });
        continue;
      }

      const sessionId = await ensureChatSessionId();
      sendFrame(socket, {
        type: 'message.send',
        sessionId,
        content: line,
      });
    }
  } finally {
    rl.close();
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
    await closed.promise;
  }
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

if (import.meta.main) {
  await main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to run local gateway WebSocket client: ${message}`);
    console.error(`Tip: ensure the gateway is running and check ${GATEWAY_CONFIG_PATH} for local config.`);
    process.exit(1);
  });
}
