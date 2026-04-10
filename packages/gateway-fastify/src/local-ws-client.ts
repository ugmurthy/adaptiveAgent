#!/usr/bin/env bun

import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

import type { AgentEventFrame, OutboundFrame, SessionOpenedFrame } from './protocol.js';
import { GATEWAY_CONFIG_PATH, loadLocalGatewayConnectionConfig } from './local-dev.js';
import { mintLocalDevJwt } from './local-dev-jwt.js';

marked.use(markedTerminal() as never);

export type EventStreamMode = 'off' | 'compact' | 'verbose';

interface ClientOptions {
  url?: string;
  host?: string;
  port?: number;
  path?: string;
  channel: string;
  sessionId?: string;
  subject: string;
  tenantId?: string;
  roles: string[];
  token?: string;
  message?: string;
  runGoal?: string;
  verbose: boolean;
}

interface ClientState {
  sessionId?: string;
  runSessionId?: string;
  pendingApprovalRunId?: string;
  pendingClarificationRunId?: string;
  eventMode: EventStreamMode;
  approvalSessionIds: Map<string, string>;
  clarificationSessionIds: Map<string, string>;
}

const HELP_TEXT = `Commands:
  <text>                     send a chat message with message.send
  /run <goal>                send run.start via a dedicated run session
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
    sessionId: options.sessionId,
    eventMode: 'compact',
    approvalSessionIds: new Map(),
    clarificationSessionIds: new Map(),
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

  const sessionOpened = createDeferred<SessionOpenedFrame>();
  let pendingSessionOpen: ReturnType<typeof createDeferred<SessionOpenedFrame>> | undefined;
  const terminalFrame = createDeferred<OutboundFrame>();
  const closed = createDeferred<{ code: number; reason: string }>();

  socket.addEventListener('open', () => {
    sendFrame(socket, {
      type: 'session.open',
      channelId: options.channel,
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    });
  });

  socket.addEventListener('message', (event) => {
    const frame = parseFrame(event.data);

    if (options.verbose && (frame.type !== 'agent.event' || state.eventMode !== 'off')) {
      console.log(`< ${JSON.stringify(frame)}`);
    }

    switch (frame.type) {
      case 'session.opened':
        console.log(`Session opened: ${frame.sessionId} (${frame.status})`);
        if (!sessionOpened.isSettled()) {
          sessionOpened.resolve(frame);
          break;
        }

        if (pendingSessionOpen) {
          pendingSessionOpen.resolve(frame);
          pendingSessionOpen = undefined;
        }
        break;
      case 'session.updated':
        console.log(`Session updated: ${frame.status} (activeRunId=${frame.activeRunId ?? 'none'})`);
        break;
      case 'message.output':
        console.log('assistant>');
        console.log(renderMarkedValue(frame.message.content));
        resolveIfPending(terminalFrame, frame);
        break;
      case 'run.output':
        if (frame.status === 'failed') {
          console.log(`run failed: ${frame.error ?? 'unknown error'}`);
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
    rejectIfPending(sessionOpened, new Error('Socket closed before session.opened was received.'));
    if (pendingSessionOpen) {
      rejectIfPending(pendingSessionOpen, new Error('Socket closed before an additional session.opened was received.'));
      pendingSessionOpen = undefined;
    }
    rejectIfPending(terminalFrame, new Error('Socket closed before a terminal response was received.'));
    closed.resolve({ code: event.code, reason: event.reason });
  });

  socket.addEventListener('error', () => {
    console.log('WebSocket error encountered.');
  });

  const openedSession = await sessionOpened.promise;
  state.sessionId = openedSession.sessionId;

  async function openAdditionalSession(): Promise<SessionOpenedFrame> {
    if (pendingSessionOpen) {
      throw new Error('A session.open request is already in flight. Wait for it to finish before opening another session.');
    }

    pendingSessionOpen = createDeferred<SessionOpenedFrame>();
    sendFrame(socket, {
      type: 'session.open',
      channelId: options.channel,
    });

    try {
      return await pendingSessionOpen.promise;
    } finally {
      pendingSessionOpen = undefined;
    }
  }

  async function ensureRunSessionId(): Promise<string> {
    const runTarget = selectInteractiveSession('run', state);
    if (runTarget.sessionId) {
      return runTarget.sessionId;
    }

    const runSession = await openAdditionalSession();
    state.runSessionId = runSession.sessionId;
    console.log(`Run session ready: ${runSession.sessionId}`);
    return runSession.sessionId;
  }

  if (options.message) {
    ensureSessionId(state);
    sendFrame(socket, {
      type: 'message.send',
      sessionId: state.sessionId,
      content: options.message,
    });
    await terminalFrame.promise;
    socket.close();
    await closed.promise;
    return;
  }

  if (options.runGoal) {
    ensureSessionId(state);
    sendFrame(socket, {
      type: 'run.start',
      sessionId: state.sessionId,
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
            `No sessionId is tracked for run "${runId}". Wait for a clarification request from this client first.`,
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

      ensureSessionId(state);
      sendFrame(socket, {
        type: 'message.send',
        sessionId: state.sessionId,
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

async function resolveSocketUrl(options: ClientOptions): Promise<string> {
  if (options.url) {
    return options.url;
  }

  return `ws://${options.host ?? '127.0.0.1'}:${options.port ?? 8959}${options.path ?? '/ws'}?channelId=${encodeURIComponent(options.channel)}`;
}

function normalizeConnectHost(host: string | undefined): string {
  if (!host || host === '0.0.0.0' || host === '::') {
    return '127.0.0.1';
  }

  return host;
}

function sendFrame(socket: WebSocket, frame: Record<string, unknown>): void {
  socket.send(JSON.stringify(frame));
}

function parseFrame(raw: string | ArrayBuffer | Blob | Uint8Array): OutboundFrame {
  const text =
    typeof raw === 'string'
      ? raw
      : raw instanceof ArrayBuffer
        ? new TextDecoder().decode(raw)
        : raw instanceof Uint8Array
          ? new TextDecoder().decode(raw)
          : String(raw);

  return JSON.parse(text) as OutboundFrame;
}

function ensureSessionId(state: ClientState): asserts state is ClientState & { sessionId: string } {
  if (!state.sessionId) {
    throw new Error('No sessionId is available yet.');
  }
}

export interface InteractiveSessionSelection {
  sessionId?: string;
  shouldOpenSession: boolean;
}

export function selectInteractiveSession(
  mode: 'chat' | 'run',
  state: Pick<ClientState, 'sessionId' | 'runSessionId'>,
): InteractiveSessionSelection {
  if (mode === 'run') {
    if (state.runSessionId) {
      return {
        sessionId: state.runSessionId,
        shouldOpenSession: false,
      };
    }

    return { shouldOpenSession: true };
  }

  if (state.sessionId) {
    return {
      sessionId: state.sessionId,
      shouldOpenSession: false,
    };
  }

  return { shouldOpenSession: true };
}

export function parseClarifyCommand(
  command: string,
  pendingRunId?: string,
  trackedRunIds: ReadonlySet<string> = new Set(),
): { runId: string; message: string } {
  const parts = command.split(/\s+/).filter((part) => part.length > 0);
  const args = parts.slice(1);
  if (args.length === 0) {
    throw new Error('No clarification text available for /clarify. Pass /clarify <text> or /clarify <runId> <text>.');
  }

  let runId = pendingRunId;
  let messageParts = args;
  if (args.length >= 2 && trackedRunIds.has(args[0])) {
    runId = args[0];
    messageParts = args.slice(1);
  } else if (!runId && args.length >= 2) {
    runId = args[0];
    messageParts = args.slice(1);
  }

  if (!runId) {
    throw new Error('No runId available for /clarify. Pass /clarify <runId> <text> or wait for a clarification request.');
  }

  const message = messageParts.join(' ').trim();
  if (!message) {
    throw new Error('Clarification text must not be empty.');
  }

  return { runId, message };
}

export function parseEventsCommand(
  command: string,
  currentMode: EventStreamMode,
): { eventMode: EventStreamMode; message: string } {
  const parts = command.split(/\s+/).filter((part) => part.length > 0);
  const args = parts.slice(1);

  if (args.length === 0) {
    return {
      eventMode: currentMode,
      message:
        currentMode === 'off'
          ? 'Realtime events are off.'
          : `Realtime events are on (${currentMode === 'compact' ? 'one-line' : 'verbose'}).`,
    };
  }

  if (args.length === 1 && args[0] === 'off') {
    return {
      eventMode: 'off',
      message: 'Realtime events disabled.',
    };
  }

  if (args.length === 1 && args[0] === 'on') {
    return {
      eventMode: 'compact',
      message: 'Realtime events enabled (one-line).',
    };
  }

  if (args.length === 2 && args[0] === 'on' && args[1] === 'verbose') {
    return {
      eventMode: 'verbose',
      message: 'Realtime events enabled (verbose).',
    };
  }

  throw new Error('Usage: /event [on [verbose]|off]');
}

function parseApproveCommand(command: string, pendingRunId?: string): { runId: string; approved: boolean } {
  const parts = command.split(/\s+/).filter((part) => part.length > 0);
  const args = parts.slice(1);
  if (args.length === 0 && pendingRunId) {
    return { runId: pendingRunId, approved: true };
  }

  let runId = pendingRunId;
  let approved = true;

  for (const arg of args) {
    if (arg === 'yes' || arg === 'true') {
      approved = true;
      continue;
    }

    if (arg === 'no' || arg === 'false') {
      approved = false;
      continue;
    }

    runId = arg;
  }

  if (!runId) {
    throw new Error('No runId available for /approve. Pass /approve <runId> yes|no or wait for approval.requested.');
  }

  return { runId, approved };
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  return JSON.stringify(value, null, 2) ?? String(value);
}

function renderMarkedValue(value: unknown): string {
  return marked.parse(formatValue(value)) as string;
}

function isEventsCommand(command: string): boolean {
  return command === '/event' || command.startsWith('/event ') || command === '/events' || command.startsWith('/events ');
}

export function formatCompactAgentEventFrame(frame: AgentEventFrame): string {
  const payload = asRecord(frame.data);
  const prefix = compactEventPrefix(frame);

  switch (frame.eventType) {
    case 'run.created':
      return `${prefix} run created`;
    case 'run.status_changed': {
      const fromStatus = readString(payload, 'fromStatus') ?? 'unknown';
      const toStatus = readString(payload, 'toStatus') ?? 'unknown';
      return `${prefix} status ${fromStatus} -> ${toStatus}`;
    }
    case 'run.interrupted':
      return `${prefix} run interrupted`;
    case 'run.resumed':
      return `${prefix} run resumed`;
    case 'run.completed':
      return `${prefix} run completed`;
    case 'run.failed': {
      const error = readString(payload, 'error');
      return `${prefix} run failed${error ? `: ${error}` : ''}`;
    }
    case 'plan.created':
      return `${prefix} plan created`;
    case 'plan.execution_started':
      return `${prefix} plan execution started`;
    case 'step.started':
      return `${prefix} step ${frame.stepId ?? readString(payload, 'stepId') ?? 'unknown'} started`;
    case 'step.completed':
      return `${prefix} step ${frame.stepId ?? readString(payload, 'stepId') ?? 'unknown'} completed`;
    case 'tool.started':
      return `${prefix} tool ${readString(payload, 'toolName') ?? 'unknown'} started`;
    case 'tool.completed':
      return `${prefix} tool ${readString(payload, 'toolName') ?? 'unknown'} completed`;
    case 'tool.failed': {
      const toolName = readString(payload, 'toolName') ?? 'unknown';
      const error = readString(payload, 'error');
      return `${prefix} tool ${toolName} failed${error ? `: ${error}` : ''}`;
    }
    case 'delegate.spawned': {
      const delegateName = readString(payload, 'delegateName') ?? 'unknown';
      const childRunId = readString(payload, 'childRunId');
      return `${prefix} delegate.${delegateName} spawned ${childRunId ? shortRunId(childRunId) : 'child run'}`;
    }
    case 'approval.requested':
      return `${prefix} approval requested for ${readString(payload, 'toolName') ?? 'unknown'}`;
    case 'approval.resolved': {
      const toolName = readString(payload, 'toolName');
      const approved = payload.approved === true ? 'approved' : payload.approved === false ? 'rejected' : 'resolved';
      return `${prefix} approval ${approved}${toolName ? ` for ${toolName}` : ''}`;
    }
    case 'clarification.requested': {
      const message = readString(payload, 'message');
      return `${prefix} clarification requested${message ? `: ${message}` : ''}`;
    }
    case 'usage.updated': {
      const usage = asRecord(payload.usage);
      const promptTokens = readNumber(usage, 'promptTokens');
      const completionTokens = readNumber(usage, 'completionTokens');
      const totalTokens = readNumber(usage, 'totalTokens');
      const parts = [
        promptTokens === undefined ? undefined : `prompt=${promptTokens}`,
        completionTokens === undefined ? undefined : `completion=${completionTokens}`,
        totalTokens === undefined ? undefined : `total=${totalTokens}`,
      ].filter((part): part is string => part !== undefined);
      return `${prefix} usage updated${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`;
    }
    case 'snapshot.created': {
      const status = readString(payload, 'status');
      return `${prefix} snapshot created${status ? ` (${status})` : ''}`;
    }
    case 'replan.required': {
      const reason = readString(payload, 'reason') ?? readString(payload, 'replanReason');
      return `${prefix} replan required${reason ? `: ${reason}` : ''}`;
    }
    default:
      return `${prefix} ${frame.eventType}`;
  }
}

function formatVerboseAgentEventFrame(frame: AgentEventFrame): string {
  const correlation = [
    frame.sessionId ? `session=${frame.sessionId}` : undefined,
    frame.runId ? `run=${frame.runId}` : undefined,
    frame.rootRunId ? `root=${frame.rootRunId}` : undefined,
    frame.parentRunId ? `parent=${frame.parentRunId}` : undefined,
    frame.agentId ? `agent=${frame.agentId}` : undefined,
  ].filter((value): value is string => typeof value === 'string');

  const prefix = correlation.length > 0 ? `event> ${frame.eventType} (${correlation.join(', ')})` : `event> ${frame.eventType}`;

  if (frame.data === null || typeof frame.data === 'undefined') {
    return prefix;
  }

  const formattedData = formatValue(frame.data);
  if (formattedData.includes('\n')) {
    return `${prefix}\ndata: ${formattedData}`;
  }

  return `${prefix} data=${formattedData}`;
}

function compactEventPrefix(frame: AgentEventFrame): string {
  const runPrefix = frame.runId ? shortRunId(frame.runId) : 'run:unknown';
  const seq = frame.seq ?? '?';
  const time = frame.createdAt ? formatEventTime(frame.createdAt) : '--:--:--';
  return `[${time}] ${runPrefix} #${seq}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

function formatEventTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toISOString().slice(11, 19);
}

function shortRunId(runId: string): string {
  return `run:${runId.slice(0, 8)}`;
}

function isClarificationRequestOutput(
  value: unknown,
): value is { status: 'clarification_requested'; message: string; suggestedQuestions: string[] } {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as {
    status?: unknown;
    message?: unknown;
    suggestedQuestions?: unknown;
  };
  return (
    candidate.status === 'clarification_requested' &&
    typeof candidate.message === 'string' &&
    Array.isArray(candidate.suggestedQuestions) &&
    candidate.suggestedQuestions.every((entry) => typeof entry === 'string')
  );
}

function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (Number.isInteger(port) && port > 0) {
    return port;
  }

  throw new Error(`Invalid port: ${value}`);
}

function requireValue(flag: string, value: string | undefined): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }

  throw new Error(`Missing value for ${flag}.`);
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  let settled = false;

  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => {
      settled = true;
      res(value);
    };
    reject = (reason) => {
      settled = true;
      rej(reason);
    };
  });

  return {
    promise,
    resolve,
    reject,
    isSettled: () => settled,
  };
}

function resolveIfPending<T>(deferred: ReturnType<typeof createDeferred<T>>, value: T): void {
  if (!deferred.isSettled()) {
    deferred.resolve(value);
  }
}

function rejectIfPending<T>(deferred: ReturnType<typeof createDeferred<T>>, reason: unknown): void {
  if (!deferred.isSettled()) {
    deferred.reject(reason);
  }
}

if (import.meta.main) {
  await main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to run local gateway WebSocket client: ${message}`);
    console.error(`Tip: ensure the gateway is running and check ${GATEWAY_CONFIG_PATH} for local config.`);
    process.exit(1);
  });
}
