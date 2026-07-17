import { createHash } from 'node:crypto';
import type { AgentRegistry, ArtifactMetadataStore, AuthorizationPolicy, Clock, IdGenerator, TransactionalServiceStore } from './ports.js';
import { IdempotencyConflictError, InvalidJobStateError, ServiceNotFoundError, type AgentProfileRef, type ChatRequest, type CommandKind, type ControlOptions, type IdempotencyOperation, type JsonValue, type JobKind, type JobState, type OrchestratedRunRequest, type RunRequest, type ServiceActor, type ServiceJob, type ServiceJobRequest, type SubmissionOptions, type SwarmRunRequest } from './types.js';

export interface ServiceSdkDependencies { persistence: TransactionalServiceStore; registry: AgentRegistry; authorization: AuthorizationPolicy; artifacts: ArtifactMetadataStore; clock: Clock; ids: IdGenerator }
const CONTROL_STATES: Record<Exclude<CommandKind, 'execute'>, readonly JobState[]> = {
  cancel: ['accepted','queued','running','waiting_approval','waiting_clarification'], retry: ['failed','cancelled'], recover: ['failed'], resume: ['waiting_approval','waiting_clarification','failed'], continue: ['failed','succeeded'], steer: ['running','waiting_approval','waiting_clarification'], resolve_approval: ['waiting_approval'], resolve_clarification: ['waiting_clarification']
};
export class ServiceSdk {
  constructor(private readonly deps: ServiceSdkDependencies) {}
  submitRun(actor: ServiceActor, request: RunRequest, options?: SubmissionOptions) { return this.submit(actor, 'run', request, [request.agentId], options); }
  submitChat(actor: ServiceActor, request: ChatRequest, options?: SubmissionOptions) { return this.submit(actor, 'chat', request, [request.agentId], options); }
  submitSwarmRun(actor: ServiceActor, request: SwarmRunRequest, options?: SubmissionOptions) { return this.submit(actor, 'swarm', request, [request.coordinatorAgentId, ...request.workerAgentIds], options); }
  submitOrchestratedRun(actor: ServiceActor, request: OrchestratedRunRequest, options?: SubmissionOptions) { return this.submit(actor, 'orchestration', request, [request.orchestratorAgentId, ...request.agentIds], options); }
  async getJob(actor: ServiceActor, jobId: string) { await this.authorize(actor, 'get'); return this.owned(actor, jobId); }
  cancelJob(actor: ServiceActor, jobId: string, options?: ControlOptions) { return this.control(actor, jobId, 'cancel', undefined, options); }
  retryJob(actor: ServiceActor, jobId: string, options?: ControlOptions) { return this.control(actor, jobId, 'retry', undefined, options); }
  recoverJob(actor: ServiceActor, jobId: string, options?: ControlOptions) { return this.control(actor, jobId, 'recover', undefined, options); }
  resumeJob(actor: ServiceActor, jobId: string, options?: ControlOptions) { return this.control(actor, jobId, 'resume', undefined, options); }
  continueJob(actor: ServiceActor, jobId: string, options?: ControlOptions) { return this.control(actor, jobId, 'continue', undefined, options); }
  steerJob(actor: ServiceActor, jobId: string, guidance: string, options?: ControlOptions) { return this.control(actor, jobId, 'steer', { message: guidance }, options); }
  resolveApproval(actor: ServiceActor, jobId: string, approved: boolean, options?: ControlOptions) { return this.control(actor, jobId, 'resolve_approval', { approved }, options); }
  resolveClarification(actor: ServiceActor, jobId: string, answer: string, options?: ControlOptions) { return this.control(actor, jobId, 'resolve_clarification', { answer }, options); }
  async listEvents(actor: ServiceActor, jobId: string, afterSequence = 0, limit = 100) { await this.authorize(actor, 'listEvents'); const rows = await this.deps.persistence.events.listEventsOwned(actor, jobId, afterSequence, limit); if (!rows) throw new ServiceNotFoundError(); return rows; }
  async listArtifacts(actor: ServiceActor, jobId: string) { await this.authorize(actor, 'listArtifacts'); const rows = await this.deps.artifacts.listOwned(actor, jobId); if (!rows) throw new ServiceNotFoundError(); return rows; }
  private async submit(actor: ServiceActor, kind: JobKind, request: ServiceJobRequest, agentIds: string[], options?: SubmissionOptions): Promise<ServiceJob> {
    await this.authorize(actor, `submit:${kind}`); const profiles: AgentProfileRef[] = [];
    for (const id of [...new Set(agentIds)]) { const found = await this.deps.registry.resolve(id, kind); if (!found || !found.allowedWorkloads.includes(kind)) throw new ServiceNotFoundError(); profiles.push(found.profile); }
    const requestHash = stableHash({ kind, request }); const now = this.deps.clock.now().toISOString();
    return this.deps.persistence.transaction(async tx => {
      if (options?.idempotencyKey) { const old = await tx.getIdempotency(actor, kind, options.idempotencyKey); if (old) { if (old.requestHash !== requestHash) throw new IdempotencyConflictError(); const job = await tx.getOwned(actor, old.jobId); if (!job) throw new ServiceNotFoundError(); return job; } }
      const jobId = this.deps.ids.generate(), sessionId = this.deps.ids.generate();
      const job: ServiceJob = { schemaVersion: 1, id: jobId, tenantId: actor.tenantId, ownerUserId: actor.userId, kind, state: 'accepted', sessionId, request, profiles, commandVersion: 1, processedCommandVersion: 0, pendingCommand: { kind: 'execute', version: 1, requestedAt: now }, createdAt: now, updatedAt: now };
      await tx.createJob(job); await tx.appendOutbox({ id: this.deps.ids.generate(), jobId, commandVersion: 1, command: job.pendingCommand, createdAt: now });
      if (options?.idempotencyKey) await tx.createIdempotency({ ...actor, operation: kind, key: options.idempotencyKey, requestHash, jobId, createdAt: now });
      await tx.appendAudit({ id: this.deps.ids.generate(), ...actor, jobId, action: `submit:${kind}`, occurredAt: now }); return job;
    });
  }
  private async control(actor: ServiceActor, jobId: string, kind: Exclude<CommandKind,'execute'>, payload?: JsonValue, options?: ControlOptions): Promise<ServiceJob> {
    await this.authorize(actor, kind); return this.deps.persistence.transaction(async tx => { const operation: IdempotencyOperation = `control:${kind}`; const requestHash = stableHash({ jobId, kind, payload: payload ?? null }); if (options?.idempotencyKey) { const old = await tx.getIdempotency(actor, operation, options.idempotencyKey); if (old) { if (old.requestHash !== requestHash) throw new IdempotencyConflictError(); const original = await tx.getOwned(actor, old.jobId); if (!original) throw new ServiceNotFoundError(); return original; } } const job = await tx.getOwned(actor, jobId); if (!job) throw new ServiceNotFoundError(); if (!CONTROL_STATES[kind].includes(job.state)) throw new InvalidJobStateError(job.state, kind);
      const now = this.deps.clock.now().toISOString(), version = job.commandVersion + 1; const updated = { ...job, state: kind === 'cancel' ? 'cancelling' as const : job.state, commandVersion: version, pendingCommand: { kind, version, payload, requestedAt: now }, updatedAt: now };
      if (!await tx.updateOwned(actor, updated)) throw new ServiceNotFoundError(); await tx.appendOutbox({ id: this.deps.ids.generate(), jobId, commandVersion: version, command: updated.pendingCommand, createdAt: now }); if (options?.idempotencyKey) await tx.createIdempotency({ ...actor, operation, key: options.idempotencyKey, requestHash, jobId, createdAt: now }); await tx.appendAudit({ id: this.deps.ids.generate(), ...actor, jobId, action: kind, occurredAt: now, data: payload }); return updated; });
  }
  private async authorize(actor: ServiceActor, op: string) { if (!await this.deps.authorization.authorize(actor, op)) throw new ServiceNotFoundError(); }
  private async owned(actor: ServiceActor, id: string) { const job = await this.deps.persistence.jobs.getOwned(actor, id); if (!job) throw new ServiceNotFoundError(); return job; }
}
function stableHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(sort(value))).digest('hex'); }
function sort(value: unknown): unknown { if (Array.isArray(value)) return value.map(sort); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k, sort(v)])); return value; }
