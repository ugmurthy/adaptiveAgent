import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadAgentSdkConfig, type ResolvedAgentSdkConfig } from '@adaptive-agent/agent-sdk';
import type { AgentProfileRef, JobKind } from '@adaptive-agent/service-sdk';

export interface AgentManifestEntry {
  id: string;
  configPath: string;
  version: string;
  contentHash: string;
  allowedWorkloads: JobKind[];
  participantIds?: string[];
  resumeCompatibleWith?: Array<{ version: string; contentHash: string }>;
}
export interface AgentManifest { agents: AgentManifestEntry[] }
export type AgentProfileResolutionPolicy = 'exact' | 'compatible' | 'latest';

export function agentProfileResolutionPolicy(value: string | undefined): AgentProfileResolutionPolicy {
  if (value === undefined || value === '' || value === 'exact') return 'exact';
  if (value === 'compatible' || value === 'latest') return value;
  throw new Error(`AGENT_PROFILE_RESOLUTION_POLICY must be exact, compatible, or latest; received ${value}`);
}

export class AllowlistedAgentRegistry {
  private constructor(
    private readonly entries: Map<string, AgentManifestEntry>,
    private readonly profileResolutionPolicy: AgentProfileResolutionPolicy,
  ) {}

  static async load(path: string, profileResolutionPolicy: AgentProfileResolutionPolicy = 'exact'): Promise<AllowlistedAgentRegistry> {
    const manifestPath = resolve(path);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AgentManifest;
    const entries = new Map<string, AgentManifestEntry>();
    for (const entry of manifest.agents) {
      if (entries.has(entry.id)) throw new Error(`Duplicate registry agent ${entry.id}`);
      entries.set(entry.id, { ...entry, configPath: resolve(dirname(manifestPath), entry.configPath) });
    }
    return new AllowlistedAgentRegistry(entries, profileResolutionPolicy);
  }

  firstAgentId(): string {
    const id = this.entries.keys().next().value;
    if (!id) throw new Error('Agent registry is empty');
    return id;
  }

  async validationFailures(): Promise<Array<{entry:AgentManifestEntry;error:unknown}>> {
    return (await Promise.all([...this.entries.values()].map(async entry => {
      try {
        await this.resolve(entry.id, entry.allowedWorkloads[0]!);
        return undefined;
      } catch (error) {
        return { entry, error };
      }
    }))).filter(failure => failure !== undefined);
  }

  async validate(): Promise<void> {
    const failures = await this.validationFailures();
    if (failures.length === 0) return;
    const details = failures.map(({entry,error}) => `- ${entry.id} (${entry.configPath}): ${error instanceof Error?error.message:String(error)}`).join('\n');
    throw new AggregateError(failures.map(failure => failure.error), `Agent registry validation failed for ${failures.length} profile(s):\n${details}`);
  }

  async list(onRejected?: (entry: AgentManifestEntry, error: unknown) => void):Promise<Array<{id:string;version:string;allowedWorkloads:JobKind[]}>> {
    const agents = await Promise.all([...this.entries.values()].map(async entry => {
      const {id,version,allowedWorkloads}=entry;
      try {
        await this.resolve(id, allowedWorkloads[0]!);
        return {id,version,allowedWorkloads:[...allowedWorkloads]};
      } catch (error) {
        onRejected?.(entry, error);
        return undefined;
      }
    }));
    return agents.filter(agent => agent !== undefined);
  }

  async resolve(id: string, workload: JobKind): Promise<{ entry: AgentManifestEntry; config: ResolvedAgentSdkConfig }> {
    const entry = this.entries.get(id);
    if (!entry || !entry.allowedWorkloads.includes(workload)) throw new Error(`Agent ${id} is not allowed for ${workload}`);
    const resolved = await this.loadEntry(entry);
    if (resolved.config.agent.tools.includes('shell_exec')) throw new Error(`Agent ${id} cannot use shell_exec in the shared service worker`);
    return resolved;
  }

  async resolvePinned(profile: AgentProfileRef, workload: JobKind): Promise<{ entry: AgentManifestEntry; config: ResolvedAgentSdkConfig }> {
    const resolved = await this.resolve(profile.agentId, workload);
    if (matchesProfile(resolved.entry, profile)) return resolved;
    if (this.profileResolutionPolicy === 'latest') return resolved;
    if (this.profileResolutionPolicy === 'compatible' && resolved.entry.resumeCompatibleWith?.some(candidate => matchesProfile(candidate, profile))) return resolved;
    throw new Error(`Agent ${profile.agentId} no longer matches the profile pinned by the service job under ${this.profileResolutionPolicy} resolution policy`);
  }

  async resolveBootstrap(id: string): Promise<{ entry: AgentManifestEntry; config: ResolvedAgentSdkConfig }> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Agent ${id} is not in the server registry`);
    return this.loadEntry(entry);
  }

  private async loadEntry(entry: AgentManifestEntry): Promise<{ entry: AgentManifestEntry; config: ResolvedAgentSdkConfig }> {
    const bytes = await readFile(entry.configPath);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== entry.contentHash) throw new Error(`Agent ${entry.id} content hash does not match registry`);
    const config = await loadAgentSdkConfig({ agentConfigPath: entry.configPath });
    if (config.agent.id !== entry.id) throw new Error(`Agent config ID ${config.agent.id} does not match registry ID ${entry.id}`);
    return { entry, config };
  }
}

function matchesProfile(candidate: { version: string; contentHash: string }, profile: AgentProfileRef): boolean {
  return candidate.version === profile.version && candidate.contentHash === profile.contentHash;
}
