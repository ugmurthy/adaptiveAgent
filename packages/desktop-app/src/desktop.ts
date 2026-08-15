import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ActivityEvent } from './activity';

export interface ResolvedConfiguration {
  agent: { id: string; configPath?: string; name: string; description?: string; defaultInvocationMode: string; configurationFingerprint: string };
  model: { provider: string; model: string; credentialAvailable: boolean };
  inference: { mode: string; tier: string };
  runtime: { mode: string; sqlitePath?: string };
  workspace: { root: string; shellCwd: string };
  interaction: { approvalMode: string; clarificationMode: string };
}

export interface EditableDesktopSettings {
  agent: { configPath?: string; id: string };
  inference: { mode: 'byok' | 'local' | 'gateway'; tier: 'low' | 'medium' | 'high' | 'xtra-high' };
  workspace: { root: string; shellCwd: string };
  interaction: { approvalMode: 'auto' | 'manual' | 'reject'; clarificationMode: 'interactive' | 'fail' };
}

export interface DesktopState {
  agentId: string;
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

export interface DesktopRecentWork {
  itemId: string;
  runId: string;
  title: string;
  status: string;
  createdAt: string;
  invocationKind: 'run' | 'chat';
}
export interface DesktopCatalogAgent {
  id: string;
  name: string;
  description?: string;
  configPath: string;
  archived: boolean;
  validationState: string;
  configurationFingerprint: string;
  status: 'starting' | 'ready' | 'running' | 'stopping' | 'error' | 'unavailable';
  occupiedSlots: number;
  capacity: number;
  attention: 'none' | 'approval' | 'recovery' | 'error';
  recentWork: DesktopRecentWork[];
}
export type DesktopCatalogDiagnostic = Record<string, unknown>;
export interface DesktopCatalogStatus {
  loading: boolean;
  error?: string;
  currentAgentId?: string;
  diagnostics: DesktopCatalogDiagnostic[];
  agents: DesktopCatalogAgent[];
  quitState: DesktopState['quitState'];
}
export interface WindowPresentation {
  x?: number; y?: number; width?: number; height?: number;
  inspectorWidth?: number;
  inspectorOpen: boolean;
  selection?: import('./workbench-state').WorkbenchSelection;
}
export interface DesktopWindowBootstrap {
  kind: 'studio' | 'agent';
  agentId?: string;
  state?: DesktopState;
  presentation?: WindowPresentation;
}
export interface AgentWindowOpen {
  agentId: string;
  disposition: 'created' | 'focused';
  openWindows: number;
  maxWindows: number;
}
export interface AgentConfigPreview {
  path: string;
  agentsDir: string;
  exists: boolean;
  duplicatePaths: string[];
  targetFingerprint: string;
  agent: Record<string, unknown>;
}
export interface AgentCreatePrepared extends AgentConfigPreview {
  brief: string;
  generatorAgent: { requested:string; id:string; name:string };
  draft: Record<string, unknown>;
  notes: string[];
  recommendations: string[];
}
export interface AgentProfileMove {
  agentId: string;
  previousPath: string;
  configPath: string;
  archived: boolean;
}
export type DesktopAttachmentKind='file'|'image'|'audio';
export interface AttachmentDraft { id:string; name:string; kind:DesktopAttachmentKind; sizeBytes:number; mimeType?:string; }

export interface PendingApproval { rootRunId:string; approvalRunId:string; approvalId:string; parentRunId?:string; toolName:string; message:string; decisionInFlight:boolean; }
export interface RunSummary { itemId: string; runId: string; title: string; createdAt: string; invocationKind: 'run'|'chat'; status: string; cancelRequested: boolean; occupiesSlot: boolean; steerable: boolean; artifactsAvailable: boolean; artifactsUnavailableReason?: string; pendingApproval?:PendingApproval; }
export interface RunRecoveryPlan { runId:string; status:string; action:'resume_same_run'|'retry_same_run'|'continue_new_run'|'requires_user_action'|'requires_reconciliation'|'not_recoverable'; executable:boolean; reason:string; }
export interface StartedRun { itemId: string; runId: string; executionId:string; mode:'direct'|'catalog'; }
export interface ChatMessage { id: string; ordinal: number; role: 'user'|'assistant'; content: string; runId?: string; attachments?:AttachmentDraft[]; }
export interface Chat { itemId:string; title:string; createdAt:string; sessionId:string; pinnedAgentId:string; pinnedAgentName:string; pinnedAgentFingerprint:string; pinnedAgentConfigPath?:string; messages:ChatMessage[]; readOnlyReason?:string; occupied:boolean; }
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
export interface TraceEvent { agentId:string; rootRunId:string; revision:number; finalRefresh:boolean; report?:TraceReport; error?:string; }

export interface RunFinishedEvent { agentId:string; runId: string; result?: unknown; error?: string; }

export interface DesktopBootstrap { currentAgentId:string; catalog?:unknown; state:DesktopState }
export type AgentActivityEvent = ActivityEvent & { agentId:string };

export interface DesktopApi {
  getDesktopState():Promise<DesktopState>; reloadSettings():Promise<DesktopState>;
  saveSettings(settings:EditableDesktopSettings):Promise<DesktopState>;
  selectAttachments(existingAttachmentIds?:string[]):Promise<AttachmentDraft[]>; discardAttachmentDraft(attachmentId:string):Promise<void>;
  startRun(task:string,attachmentIds?:string[]):Promise<StartedRun>; stopRun(runId:string):Promise<void>;
  getRunRecoveryPlan(runId:string):Promise<RunRecoveryPlan>; recoverRun(plan:RunRecoveryPlan):Promise<void>; steerRun(runId:string,message:string):Promise<void>;
  getRunResult(runId:string):Promise<unknown|null>; getRunOverview(runId:string):Promise<TraceReport>; resolveApproval(pending:PendingApproval,approved:boolean):Promise<void>;
  createChat(title:string):Promise<Chat>; listChats():Promise<Chat[]>; loadChat(itemId:string):Promise<Chat>; sendChatTurn(itemId:string,content:string,attachmentIds?:string[]):Promise<StartedRun>;
  previewHistoryDeletion(target:ProductDeletionTarget):Promise<DeletionPreview>; deleteHistory(target:ProductDeletionTarget):Promise<void>;
  listWorkspaceArtifacts():Promise<WorkspaceArtifact[]>; readArtifact(path:string):Promise<ArtifactPreview>; selectTrace(rootRunId?:string):Promise<number>;
  getTracePrivacy():Promise<TracePrivacy>; setTracePrivacy(privacy:TracePrivacy):Promise<TracePrivacy>;
  subscribe(activity:(event:AgentActivityEvent)=>void,finished:(event:RunFinishedEvent)=>void,state:(event:DesktopState)=>void,trace:(event:TraceEvent)=>void):Promise<UnlistenFn>;
}

export const desktopBootstrap=()=>invoke<DesktopBootstrap>('desktop_bootstrap');
export const desktopWindowBootstrap=()=>invoke<DesktopWindowBootstrap>('desktop_window_bootstrap');
export const getDesktopCatalogStatus=()=>invoke<DesktopCatalogStatus>('desktop_catalog_status');
export const openAgentWindow=(agentId:string)=>invoke<AgentWindowOpen>('open_agent_window',{agentId});
export const generateAgentDraft=(brief:string,generatorAgent?:string)=>invoke<AgentCreatePrepared>('generate_agent_draft',{brief,generatorAgent});
export const validateAgentConfig=(agent:Record<string,unknown>,generatorAgent?:string)=>invoke<AgentConfigPreview>('validate_agent_config',{agent,generatorAgent});
export const saveAgentConfig=(agent:Record<string,unknown>,generatorAgent:string|undefined,overwrite:boolean,expectedPath:string,expectedTargetFingerprint:string)=>invoke<AgentConfigPreview>('save_agent_config',{agent,generatorAgent,overwrite,expectedPath,expectedTargetFingerprint});
export const exportAgentConfig=(agentId:string,configPath:string)=>invoke<string|null>('export_agent_config',{agentId,configPath});
export const archiveAgentConfig=(agentId:string,configPath:string)=>invoke<AgentProfileMove>('archive_agent_config',{agentId,configPath});
export const restoreAgentConfig=(agentId:string,configPath:string)=>invoke<AgentProfileMove>('restore_agent_config',{agentId,configPath});
export const saveWindowPresentation=(presentation:{inspectorWidth:number;inspectorOpen:boolean;selection:import('./workbench-state').WorkbenchSelection})=>invoke<void>('save_window_presentation',{presentation});
export const listenCatalogStatusChanged=(callback:()=>void)=>listen('adaptive-agent://catalog-status-changed',()=>callback());

export function createDesktopApi(agentId:string):DesktopApi {
  if (!agentId) throw new Error('agentId is required');
  const args=<T extends object>(value?:T)=>({agentId,...value});
  return {
    getDesktopState:()=>invoke('desktop_state',args()), reloadSettings:()=>invoke('reload_settings',args()), saveSettings:(settings)=>invoke('save_settings',args({settings})),
    selectAttachments:(existingAttachmentIds=[])=>invoke('select_attachments',args({existingAttachmentIds})), discardAttachmentDraft:(attachmentId)=>invoke('discard_attachment_draft',args({attachmentId})),
    startRun:(task,attachmentIds=[])=>invoke('start_run',args({task,attachmentIds})), stopRun:(runId)=>invoke('stop_run',args({runId})), getRunRecoveryPlan:(runId)=>invoke('get_run_recovery_plan',args({runId})),
    recoverRun:(plan)=>invoke('recover_run',args({runId:plan.runId,expectedStatus:plan.status,expectedAction:plan.action})), steerRun:(runId,message)=>invoke('steer_run',args({runId,message})),
    getRunResult:(runId)=>invoke('get_run_result',args({runId})), getRunOverview:(runId)=>invoke('get_run_overview',args({runId})), resolveApproval:(pending,approved)=>invoke('resolve_approval',args({rootRunId:pending.rootRunId,approvalRunId:pending.approvalRunId,approvalId:pending.approvalId,approved})),
    createChat:(title)=>invoke('create_chat',args({title})), listChats:()=>invoke('list_chats',args()), loadChat:(itemId)=>invoke('load_chat',args({itemId})), sendChatTurn:(itemId,content,attachmentIds=[])=>invoke('send_chat_turn',args({itemId,content,attachmentIds})),
    previewHistoryDeletion:(target)=>invoke('preview_history_deletion',args({target})), deleteHistory:(target)=>invoke('delete_history',args({target})), listWorkspaceArtifacts:()=>invoke('list_workspace_artifacts',args()), readArtifact:(path)=>invoke('read_artifact',args({path})),
    selectTrace:(rootRunId)=>invoke('select_trace',args({rootRunId})), getTracePrivacy:()=>invoke('get_trace_privacy',args()), setTracePrivacy:(privacy)=>invoke('set_trace_privacy',args({privacy})),
    subscribe:async(activity,finished,state,trace)=>{ const registrations=await Promise.allSettled([
      listen<AgentActivityEvent>('adaptive-agent://activity',({payload})=>{if(payload.agentId===agentId)activity(payload)}),
      listen<RunFinishedEvent>('adaptive-agent://run-finished',({payload})=>{if(payload.agentId===agentId&&payload.runId)finished(payload)}),
      listen<DesktopState>('adaptive-agent://state',({payload})=>{if(payload.agentId===agentId)state(payload)}),
      listen<TraceEvent>('adaptive-agent://trace',({payload})=>{if(payload.agentId===agentId)trace(payload)}),
    ]); const unlisten=registrations.flatMap(result=>result.status==='fulfilled'?[result.value]:[]); const failed=registrations.find(result=>result.status==='rejected'); if(failed){unlisten.forEach(fn=>fn()); throw failed.reason;} let active=true; return ()=>{if(!active)return; active=false; unlisten.forEach(fn=>fn());}; },
  };
}

let compatibilityApi:Promise<DesktopApi>|undefined;
const currentApi=()=>compatibilityApi??=(desktopBootstrap().then(value=>createDesktopApi(value.currentAgentId)));

export const getDesktopState = () => currentApi().then(api=>api.getDesktopState());
export const reloadSettings = () => currentApi().then(api=>api.reloadSettings());
export const saveSettings = (settings: EditableDesktopSettings) => currentApi().then(api=>api.saveSettings(settings));
export const selectAttachments=(ids:string[]=[])=>currentApi().then(api=>api.selectAttachments(ids));
export const discardAttachmentDraft=(id:string)=>currentApi().then(api=>api.discardAttachmentDraft(id));
export const startRun=(task:string,ids:string[]=[])=>currentApi().then(api=>api.startRun(task,ids));
export const stopRun=(id:string)=>currentApi().then(api=>api.stopRun(id));
export const getRunRecoveryPlan=(id:string)=>currentApi().then(api=>api.getRunRecoveryPlan(id));
export const recoverRun=(plan:RunRecoveryPlan)=>currentApi().then(api=>api.recoverRun(plan));
export const steerRun=(id:string,message:string)=>currentApi().then(api=>api.steerRun(id,message));
export const getRunResult=(id:string)=>currentApi().then(api=>api.getRunResult(id));
export const getRunOverview=(id:string)=>currentApi().then(api=>api.getRunOverview(id));
export const resolveApproval=(pending:PendingApproval,approved:boolean)=>currentApi().then(api=>api.resolveApproval(pending,approved));
export const createChat=(title:string)=>currentApi().then(api=>api.createChat(title));
export const listChats=()=>currentApi().then(api=>api.listChats());
export const loadChat=(id:string)=>currentApi().then(api=>api.loadChat(id));
export const sendChatTurn=(id:string,content:string,ids:string[]=[])=>currentApi().then(api=>api.sendChatTurn(id,content,ids));
export const previewHistoryDeletion=(target:ProductDeletionTarget)=>currentApi().then(api=>api.previewHistoryDeletion(target));
export const deleteHistory=(target:ProductDeletionTarget)=>currentApi().then(api=>api.deleteHistory(target));
export const listWorkspaceArtifacts=()=>currentApi().then(api=>api.listWorkspaceArtifacts());
export const readArtifact=(path:string)=>currentApi().then(api=>api.readArtifact(path));
export const selectTrace=(id?:string)=>currentApi().then(api=>api.selectTrace(id));
export const getTracePrivacy=()=>currentApi().then(api=>api.getTracePrivacy());
export const setTracePrivacy=(privacy:TracePrivacy)=>currentApi().then(api=>api.setTracePrivacy(privacy));
export const quitWait = () => invoke<DesktopState>('quit_wait');
export const quitTerminate = () => invoke<DesktopState>('quit_terminate');
export const quitCancel = () => invoke<DesktopState>('quit_cancel');

export async function subscribe(
  activity: (event: ActivityEvent) => void,
  finished: (event: RunFinishedEvent) => void,
  state: (event: DesktopState) => void,
  trace: (event: TraceEvent) => void,
): Promise<UnlistenFn> {
  return (await currentApi()).subscribe(activity,finished,state,trace);
}
