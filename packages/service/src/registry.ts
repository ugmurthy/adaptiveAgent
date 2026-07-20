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
}
export interface AgentManifest { agents: AgentManifestEntry[] }

export class AllowlistedAgentRegistry {
  private constructor(private readonly entries: Map<string, AgentManifestEntry>) {}

  static async load(path: string): Promise<AllowlistedAgentRegistry> {
    const manifestPath = resolve(path);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AgentManifest;
    const entries = new Map<string, AgentManifestEntry>();
    for (const entry of manifest.agents) {
      if (entries.has(entry.id)) throw new Error(`Duplicate registry agent ${entry.id}`);
      entries.set(entry.id, { ...entry, configPath: resolve(dirname(manifestPath), entry.configPath) });
    }
    return new AllowlistedAgentRegistry(entries);
  }

  firstAgentId(): string {
    const id = this.entries.keys().next().value;
    if (!id) throw new Error('Agent registry is empty');
    return id;
  }

  list():Array<{id:string;version:string;allowedWorkloads:JobKind[]}> { return [...this.entries.values()].map(({id,version,allowedWorkloads})=>({id,version,allowedWorkloads:[...allowedWorkloads]})); }

  async resolve(id: string, workload: JobKind): Promise<{ entry: AgentManifestEntry; config: ResolvedAgentSdkConfig }> {
    const entry = this.entries.get(id);
    if (!entry || !entry.allowedWorkloads.includes(workload)) throw new Error(`Agent ${id} is not allowed for ${workload}`);
    return this.loadEntry(entry);
  }

  async resolvePinned(profile: AgentProfileRef, workload: JobKind): Promise<{ entry: AgentManifestEntry; config: ResolvedAgentSdkConfig }> {
    const resolved = await this.resolve(profile.agentId, workload);
    if (resolved.entry.version !== profile.version || resolved.entry.contentHash !== profile.contentHash) {
      throw new Error(`Agent ${profile.agentId} no longer matches the profile pinned by the service job`);
    }
    return resolved;
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
