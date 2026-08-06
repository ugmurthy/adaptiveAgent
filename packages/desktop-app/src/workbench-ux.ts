import type { RunRecoveryPlan } from './desktop';

export type ComposerMode = 'auto' | 'task' | 'chat';

export function resolveComposerMode(mode: ComposerMode, prompt: string): 'task' | 'chat' {
  if (mode !== 'auto') return mode;
  return /^(chat:|discuss:|talk about\b)/i.test(prompt.trim()) ? 'chat' : 'task';
}

export interface ResultArtifact { path: string; detail?: string }

export function resultDisplayContent(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  for (const key of ['summary', 'report', 'content']) {
    if (typeof record[key] === 'string') return record[key];
  }
  return value;
}

export function extractResultArtifacts(value: unknown): ResultArtifact[] {
  const unwrapped = value && typeof value === 'object' && 'status' in value && 'output' in value
    ? (value as { output?: unknown }).output : value;
  if (unwrapped && typeof unwrapped === 'object') {
    const record = unwrapped as Record<string, unknown>;
    const list = Array.isArray(record.artifacts) ? record.artifacts : Array.isArray(record.files) ? record.files : [];
    return list.flatMap((item) => {
      if (typeof item === 'string') return [{ path: item }];
      if (!item || typeof item !== 'object') return [];
      const entry = item as Record<string, unknown>;
      const path = entry.path ?? entry.name ?? entry.filename;
      return typeof path === 'string' ? [{ path, detail: typeof entry.type === 'string' ? entry.type : undefined }] : [];
    });
  }
  if (typeof unwrapped !== 'string') return [];
  const matches = unwrapped.match(/(?:^|[\s`'"(])([\w./-]+\.(?:pdf|csv|json|md|txt|png|jpe?g|svg|html|docx?|xlsx?|zip))(?:$|[\s`'"),.:;])/g) ?? [];
  return [...new Set(matches.map((match) => match.trim().replace(/^[`'"(]|[`'"),.:;]$/g, '')))].map((path) => ({ path }));
}

export function recoveryActionLabel(plan?: RunRecoveryPlan): string {
  if (!plan?.executable) return '';
  if (plan.status === 'failed' && plan.action === 'retry_same_run') return 'Recover run';
  if (plan.status === 'interrupted' && plan.action === 'resume_same_run') return 'Recover run';
  return '';
}
