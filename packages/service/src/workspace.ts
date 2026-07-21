import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import type { ServiceJob } from '@adaptive-agent/service-sdk';

export interface SandboxPolicy {
  prepare(job: ServiceJob, workspace: JobWorkspace): Promise<void>;
  close?(job: ServiceJob, workspace: JobWorkspace): Promise<void>;
}
export interface JobWorkspace { root: string; artifacts: string; modelContext?: string }
export interface WorkspaceManager {
  create(job: ServiceJob, options?: { prepare?: boolean }): Promise<JobWorkspace>;
  prepare?(job: ServiceJob, workspace: JobWorkspace): Promise<void>;
  close(job: ServiceJob, workspace: JobWorkspace): Promise<void>;
}

export class LocalWorkspaceManager implements WorkspaceManager {
  constructor(private readonly configuredRoot: string, private readonly policy: SandboxPolicy = { prepare: async () => undefined }) {}

  async create(job: ServiceJob, options: { prepare?: boolean } = {}): Promise<JobWorkspace> {
    const base = resolve(this.configuredRoot);
    await mkdir(base, { recursive: true, mode: 0o700 });
    const normalizedId = `${job.id.replace(/[^a-zA-Z0-9_-]/g, '_')}-${randomUUID()}`;
    const root = resolve(join(base, normalizedId));
    if (root !== base && !root.startsWith(`${base}${sep}`)) throw new Error('Job workspace escapes configured root');
    const artifacts = join(root, 'artifacts');
    await mkdir(root, { recursive: true, mode: 0o700 });
    if ((await lstat(root)).isSymbolicLink()) throw new Error('Job workspace must not be a symbolic link');
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    if ((await lstat(artifacts)).isSymbolicLink()) throw new Error('Artifact directory must not be a symbolic link');
    const canonicalBase = await realpath(base);
    const canonicalRoot = await realpath(root);
    if (!canonicalRoot.startsWith(`${canonicalBase}${sep}`)) throw new Error('Job workspace resolves outside configured root');
    const workspace = { root: canonicalRoot, artifacts: await realpath(artifacts) };
    if (options.prepare === false) return workspace;
    try {
      await this.prepare(job, workspace);
      return workspace;
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  async prepare(job: ServiceJob, workspace: JobWorkspace): Promise<void> {
    await this.policy.prepare(job, workspace);
  }

  async close(job: ServiceJob, workspace: JobWorkspace): Promise<void> {
    await this.policy.close?.(job, workspace);
  }
}
