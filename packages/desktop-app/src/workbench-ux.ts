import type { RunRecoveryPlan } from './desktop';

export type ComposerMode = 'auto' | 'task' | 'chat';

export function resolveComposerMode(mode: ComposerMode, prompt: string): 'task' | 'chat' {
  if (mode !== 'auto') return mode;
  return /^(chat:|discuss:|talk about\b)/i.test(prompt.trim()) ? 'chat' : 'task';
}

export interface ResultArtifact { path: string; detail?: string; runId?: string }

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
  const matches = unwrapped.match(/(?:^|[\s`'"(])([\w./-]+\.(?:pdf|csv|json|md|markdown|txt|log|xml|ya?ml|png|jpe?g|gif|webp|bmp|svg|html?|docx?|xlsx?|zip|mp4|webm|mov|m4v|ogv))(?:$|[\s`'"),.:;])/g) ?? [];
  return [...new Set(matches.map((match) => match.trim().replace(/^[`'"(]|[`'"),.:;]$/g, '')))].map((path) => ({ path }));
}

export function resolveResultArtifactPaths(
  artifacts: ResultArtifact[],
  workspaceArtifacts: Array<{ path: string }>,
): ResultArtifact[] {
  return artifacts.map((artifact) => {
    const reference = artifact.path.replaceAll('\\', '/');
    const matches = workspaceArtifacts.filter(({ path }) => {
      const candidate = path.replaceAll('\\', '/');
      return candidate === reference || candidate.endsWith(`/${reference}`);
    });
    return matches.length === 1 ? { ...artifact, path: matches[0]!.path } : artifact;
  });
}

export function historyResultArtifacts(
  results: unknown[],
  workspaceArtifacts: Array<{ path: string }>,
): ResultArtifact[] {
  const resolved = resolveResultArtifactPaths(results.flatMap(extractResultArtifacts), workspaceArtifacts);
  const available = new Set(workspaceArtifacts.map((artifact) => artifact.path));
  return [...new Map(
    resolved.filter((artifact) => available.has(artifact.path)).map((artifact) => [artifact.path, artifact]),
  ).values()];
}

export function recoveryActionLabel(plan?: RunRecoveryPlan): string {
  if (!plan?.executable) return '';
  if (plan.status === 'failed' && plan.action === 'retry_same_run') return 'Recover run';
  if (plan.status === 'interrupted' && plan.action === 'resume_same_run') return 'Recover run';
  return '';
}
