import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ActivityEvent } from './activity';

export interface ResolvedConfiguration {
  agent: { id: string; name: string; description?: string; defaultInvocationMode: string; configurationFingerprint: string };
  model: { provider: string; model: string; credentialAvailable: boolean };
  inference: { mode: string; tier: string };
  runtime: { mode: string; sqlitePath?: string };
  workspace: { root: string; shellCwd: string };
  interaction: { approvalMode: string; clarificationMode: string };
}

export interface DesktopState {
  status: 'starting' | 'ready' | 'running' | 'stopping' | 'error';
  configurationValid: boolean;
  configuration?: ResolvedConfiguration;
  error?: string;
  runs: RunSummary[];
  occupiedSlotCount: number;
  capacity: 3;
  executionHealth: 'ready' | 'error';
  traceHealth: 'starting' | 'ready' | 'error';
  traceError?: string;
  quitState: 'idle' | 'confirming' | 'draining' | 'approved';
}

export interface PendingApproval { rootRunId:string; approvalRunId:string; approvalId:string; parentRunId?:string; toolName:string; message:string; decisionInFlight:boolean; }
export interface RunSummary { itemId: string; runId: string; status: string; cancelRequested: boolean; occupiesSlot: boolean; pendingApproval?:PendingApproval; }
export interface StartedRun { itemId: string; runId: string; }
export interface ChatMessage { id: string; ordinal: number; role: 'user'|'assistant'; content: string; runId?: string; }
export interface Chat { itemId:string; title:string; sessionId:string; pinnedAgentId:string; pinnedAgentName:string; pinnedAgentFingerprint:string; messages:ChatMessage[]; readOnlyReason?:string; occupied:boolean; }

export interface RunFinishedEvent { runId: string; result?: unknown; error?: string; }

export const getDesktopState = () => invoke<DesktopState>('desktop_state');
export const reloadSettings = () => invoke<DesktopState>('reload_settings');
export const startRun = (task: string) => invoke<StartedRun>('start_run', { task });
export const stopRun = (runId: string) => invoke<void>('stop_run', { runId });
export const getRunResult = (runId: string) => invoke<unknown | null>('get_run_result', { runId });
export const resolveApproval = (pending:PendingApproval,approved:boolean) => invoke<void>('resolve_approval',{rootRunId:pending.rootRunId,approvalRunId:pending.approvalRunId,approvalId:pending.approvalId,approved});
export const createChat = (title:string) => invoke<Chat>('create_chat',{title});
export const listChats = () => invoke<Chat[]>('list_chats');
export const loadChat = (itemId:string) => invoke<Chat>('load_chat',{itemId});
export const sendChatTurn = (itemId:string,content:string) => invoke<StartedRun>('send_chat_turn',{itemId,content});
export const quitWait = () => invoke<DesktopState>('quit_wait');
export const quitTerminate = () => invoke<DesktopState>('quit_terminate');
export const quitCancel = () => invoke<DesktopState>('quit_cancel');

export async function subscribe(
  activity: (event: ActivityEvent) => void,
  finished: (event: RunFinishedEvent) => void,
  state: (event: DesktopState) => void,
): Promise<UnlistenFn> {
  const unlisten = await Promise.all([
    listen<ActivityEvent>('adaptive-agent://activity', ({ payload }) => activity(payload)),
    listen<RunFinishedEvent>('adaptive-agent://run-finished', ({ payload }) => {
      if (payload && typeof payload.runId === 'string' && payload.runId.length > 0) finished(payload);
    }),
    listen<DesktopState>('adaptive-agent://state', ({ payload }) => state(payload)),
  ]);
  return () => unlisten.forEach((fn) => fn());
}
