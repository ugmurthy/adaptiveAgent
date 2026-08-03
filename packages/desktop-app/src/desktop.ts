import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface ResolvedConfiguration {
  agent: { id: string; name: string; description?: string; defaultInvocationMode: string };
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
  activeRunId?: string;
  executionHealth: 'ready' | 'error';
  traceHealth: 'starting' | 'ready' | 'error';
  traceError?: string;
}

export interface ProgressEvent { runId: string; kind: string; message: string; }
export interface RunFinishedEvent { runId?: string; result?: unknown; error?: string; }

export const getDesktopState = () => invoke<DesktopState>('desktop_state');
export const reloadSettings = () => invoke<DesktopState>('reload_settings');
export const startRun = (task: string) => invoke<void>('start_run', { task });
export const stopRun = () => invoke<void>('stop_run');

export async function subscribe(
  progress: (event: ProgressEvent) => void,
  finished: (event: RunFinishedEvent) => void,
  state: (event: DesktopState) => void,
): Promise<UnlistenFn> {
  const unlisten = await Promise.all([
    listen<ProgressEvent>('adaptive-agent://progress', ({ payload }) => progress(payload)),
    listen<RunFinishedEvent>('adaptive-agent://run-finished', ({ payload }) => finished(payload)),
    listen<DesktopState>('adaptive-agent://state', ({ payload }) => state(payload)),
  ]);
  return () => unlisten.forEach((fn) => fn());
}
