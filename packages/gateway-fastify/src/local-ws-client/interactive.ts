import type { AgentEventFrame, SessionOpenedFrame } from '../protocol.js';
import type { EventStreamMode } from './common.js';

export interface InteractiveSessionSelection {
  sessionId?: string;
  shouldOpenSession: boolean;
}

export interface InteractiveSessionState {
  sessionId?: string;
  runSessionId?: string;
}

export interface FailedRunTrackingState {
  lastFailedRunId?: string;
  failedRunSessionIds: Map<string, string>;
}

export function recordInteractiveSession(
  state: InteractiveSessionState,
  mode: 'chat' | 'run',
  sessionId: string,
): void {
  if (mode === 'run') {
    state.runSessionId = sessionId;
    if (state.sessionId === sessionId) {
      state.sessionId = undefined;
    }
    return;
  }

  state.sessionId = sessionId;
  if (state.runSessionId === sessionId) {
    state.runSessionId = undefined;
  }
}

export function recordFailedRunFromAgentEvent(
  state: FailedRunTrackingState,
  frame: Pick<AgentEventFrame, 'eventType' | 'runId' | 'sessionId'>,
): void {
  if (frame.eventType !== 'run.failed' || !frame.runId) {
    return;
  }

  state.lastFailedRunId = frame.runId;
  if (frame.sessionId) {
    state.failedRunSessionIds.set(frame.runId, frame.sessionId);
  }
}

export function recordRootRunRetryTarget(
  state: InteractiveSessionState & FailedRunTrackingState,
  rootRunId: string,
  sessionId: string,
): void {
  recordInteractiveSession(state, 'run', sessionId);
  state.lastFailedRunId = rootRunId;
  state.failedRunSessionIds.set(rootRunId, sessionId);
}

export function getInteractiveSessionMode(frame: Pick<SessionOpenedFrame, 'invocationMode'>): 'chat' | 'run' {
  return frame.invocationMode === 'run' ? 'run' : 'chat';
}

export function selectInteractiveSession(
  mode: 'chat' | 'run',
  state: Pick<InteractiveSessionState, 'sessionId' | 'runSessionId'>,
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

export function isEventsCommand(command: string): boolean {
  return command === '/event' || command.startsWith('/event ') || command === '/events' || command.startsWith('/events ');
}

export function parseRetryCommand(command: string, lastFailedRunId?: string): string {
  const parts = command.split(/\s+/).filter((part) => part.length > 0);
  const args = parts.slice(1);
  if (args.length === 0 && lastFailedRunId) {
    return lastFailedRunId;
  }

  if (args.length !== 1) {
    throw new Error('Usage: /retry <runId> or retry the most recent failed run with /retry.');
  }

  return args[0];
}

export function parseInterruptCommand(command: string): string {
  const parts = command.split(/\s+/).filter((part) => part.length > 0);
  const args = parts.slice(1);
  if (args.length !== 1) {
    throw new Error('Usage: /interrupt <runId>');
  }

  return args[0];
}

export function parseSteerCommand(command: string): { runId: string; message: string; role?: 'user' | 'system' } {
  let remainder = command.slice('/steer'.length).trim();
  let role: 'user' | 'system' | undefined;

  if (remainder.startsWith('--role ')) {
    const roleMatch = /^--role\s+(user|system)\s+(.+)$/s.exec(remainder);
    if (!roleMatch) {
      throw new Error('Usage: /steer [--role user|system] <runId> <message>');
    }
    role = roleMatch[1] as 'user' | 'system';
    remainder = roleMatch[2].trim();
  }

  const runIdMatch = /^(\S+)\s+(.+)$/s.exec(remainder);
  if (!runIdMatch) {
    throw new Error('Usage: /steer [--role user|system] <runId> <message>');
  }

  const message = runIdMatch[2].trim();
  if (!message) {
    throw new Error('Steer message must not be empty.');
  }

  return {
    runId: runIdMatch[1],
    message,
    ...(role ? { role } : {}),
  };
}

export function parseApproveCommand(command: string, pendingRunId?: string): { runId: string; approved: boolean } {
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
