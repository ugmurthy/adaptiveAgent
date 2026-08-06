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
export interface RunSummary { itemId: string; runId: string; title: string; createdAt: string; invocationKind: 'run'|'chat'; status: string; cancelRequested: boolean; occupiesSlot: boolean; steerable: boolean; pendingApproval?:PendingApproval; }
export interface RunRecoveryPlan { runId:string; status:string; action:'resume_same_run'|'retry_same_run'|'continue_new_run'|'requires_user_action'|'requires_reconciliation'|'not_recoverable'; executable:boolean; reason:string; }
export interface StartedRun { itemId: string; runId: string; }
export interface ChatMessage { id: string; ordinal: number; role: 'user'|'assistant'; content: string; runId?: string; }
export interface Chat { itemId:string; title:string; createdAt:string; sessionId:string; pinnedAgentId:string; pinnedAgentName:string; pinnedAgentFingerprint:string; messages:ChatMessage[]; readOnlyReason?:string; occupied:boolean; }
export type ProductDeletionTarget = {kind:'item';itemId:string}|{kind:'run';runId:string}|{kind:'chat-turn';itemId:string;ordinal:number};
export interface DeletionPreview { target:ProductDeletionTarget; label:string; runCount:number; planCount:number; occupied:boolean; warning:string; }
export interface WorkspaceArtifact { path:string; }
export interface ArtifactPreview { name:string; kind:'text'|'markdown'|'html'|'json'|'image'|'video'; mimeType:string; content:string; }

export interface TracePrivacy { messages:boolean; reasoning:boolean; rawToolPayloads:boolean; }
export interface TraceReport {
  summary?: { status?:string; reason?:string };
  rootRuns?: unknown[];
  timeline?: Array<Record<string, unknown>>;
  runTree?: unknown[];
  usage?: { total?: { promptTokens?:number; completionTokens?:number; reasoningTokens?:number; totalTokens?:number; estimatedCostUSD?:number }; toolAccounting?: { unpricedRequests?:number }; [key:string]:unknown };
  performance?: Record<string, unknown>;
  diagnostics?: { performance?: { toolAccounting?: { unpricedRequests?:number } }; [key:string]:unknown };
  llmMessages?: unknown[];
  warnings?: string[];
}
export interface TraceEvent { rootRunId:string; revision:number; finalRefresh:boolean; report?:TraceReport; error?:string; }

export interface RunFinishedEvent { runId: string; result?: unknown; error?: string; }

export const getDesktopState = () => invoke<DesktopState>('desktop_state');
export const reloadSettings = () => invoke<DesktopState>('reload_settings');
export const startRun = (task: string) => invoke<StartedRun>('start_run', { task });
export const stopRun = (runId: string) => invoke<void>('stop_run', { runId });
export const getRunRecoveryPlan = (runId:string) => invoke<RunRecoveryPlan>('get_run_recovery_plan',{runId});
export const recoverRun = (plan:RunRecoveryPlan) => invoke<void>('recover_run',{
  runId:plan.runId,
  expectedStatus:plan.status,
  expectedAction:plan.action,
});
export const steerRun = (runId:string,message:string) => invoke<void>('steer_run',{runId,message});
export const getRunResult = (runId: string) => invoke<unknown | null>('get_run_result', { runId });
export const getRunOverview = (runId: string) => invoke<TraceReport>('get_run_overview', { runId });
export const resolveApproval = (pending:PendingApproval,approved:boolean) => invoke<void>('resolve_approval',{rootRunId:pending.rootRunId,approvalRunId:pending.approvalRunId,approvalId:pending.approvalId,approved});
export const createChat = (title:string) => invoke<Chat>('create_chat',{title});
export const listChats = () => invoke<Chat[]>('list_chats');
export const loadChat = (itemId:string) => invoke<Chat>('load_chat',{itemId});
export const sendChatTurn = (itemId:string,content:string) => invoke<StartedRun>('send_chat_turn',{itemId,content});
export const previewHistoryDeletion = (target:ProductDeletionTarget) => invoke<DeletionPreview>('preview_history_deletion',{target});
export const deleteHistory = (target:ProductDeletionTarget) => invoke<void>('delete_history',{target});
export const listWorkspaceArtifacts = () => invoke<WorkspaceArtifact[]>('list_workspace_artifacts');
export const readArtifact = (path:string) => invoke<ArtifactPreview>('read_artifact',{path});
export const selectTrace = (rootRunId?:string) => invoke<number>('select_trace',{rootRunId});
export const getTracePrivacy = () => invoke<TracePrivacy>('get_trace_privacy');
export const setTracePrivacy = (privacy:TracePrivacy) => invoke<TracePrivacy>('set_trace_privacy',{privacy});
export const quitWait = () => invoke<DesktopState>('quit_wait');
export const quitTerminate = () => invoke<DesktopState>('quit_terminate');
export const quitCancel = () => invoke<DesktopState>('quit_cancel');

export async function subscribe(
  activity: (event: ActivityEvent) => void,
  finished: (event: RunFinishedEvent) => void,
  state: (event: DesktopState) => void,
  trace: (event: TraceEvent) => void,
): Promise<UnlistenFn> {
  const unlisten = await Promise.all([
    listen<ActivityEvent>('adaptive-agent://activity', ({ payload }) => activity(payload)),
    listen<RunFinishedEvent>('adaptive-agent://run-finished', ({ payload }) => {
      if (payload && typeof payload.runId === 'string' && payload.runId.length > 0) finished(payload);
    }),
    listen<DesktopState>('adaptive-agent://state', ({ payload }) => state(payload)),
    listen<TraceEvent>('adaptive-agent://trace', ({ payload }) => trace(payload)),
  ]);
  return () => unlisten.forEach((fn) => fn());
}
