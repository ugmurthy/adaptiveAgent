import type { ArtifactMetadataStore, ServiceTransaction, TransactionalServiceStore } from './ports.js';
import type { ArtifactMetadata, AuditRecord, IdempotencyOperation, IdempotencyRecord, JobRunLink, OutboxRecord, PublicEventEnvelope, ServiceActor, ServiceJob } from './types.js';

export class InMemoryServiceStore implements TransactionalServiceStore, ServiceTransaction {
  readonly jobRows = new Map<string, ServiceJob>(); readonly linkRows: JobRunLink[] = []; readonly idempotencyRows = new Map<string, IdempotencyRecord>(); readonly eventRows: PublicEventEnvelope[] = []; readonly outboxRows: OutboxRecord[] = []; readonly auditRows: AuditRecord[] = []; readonly artifactRows: ArtifactMetadata[] = [];
  jobs = this; links = this; idempotency = this; events = this; outbox = this; audit = this;
  failAfterJobCreate = false;
  async transaction<T>(operation: (tx: ServiceTransaction) => Promise<T>): Promise<T> { const snapshot = structuredClone({ jobs: [...this.jobRows], links: this.linkRows, idem: [...this.idempotencyRows], outbox: this.outboxRows, audit: this.auditRows }); try { return await operation(this); } catch (error) { this.jobRows.clear(); snapshot.jobs.forEach(x => this.jobRows.set(...x)); this.linkRows.splice(0,Infinity,...snapshot.links); this.idempotencyRows.clear(); snapshot.idem.forEach(x => this.idempotencyRows.set(...x)); this.outboxRows.splice(0,Infinity,...snapshot.outbox); this.auditRows.splice(0,Infinity,...snapshot.audit); throw error; } }
  async createJob(job: ServiceJob) { this.jobRows.set(job.id, structuredClone(job)); if (this.failAfterJobCreate) throw new Error('injected transaction failure'); }
  async getOwned(actor: ServiceActor, id: string) { const j = this.jobRows.get(id); return j?.tenantId === actor.tenantId && j.ownerUserId === actor.userId ? structuredClone(j) : undefined; }
  async updateOwned(actor: ServiceActor, job: ServiceJob) { if (!await this.getOwned(actor, job.id)) return false; this.jobRows.set(job.id, structuredClone(job)); return true; }
  async add(link: JobRunLink) { this.linkRows.push(structuredClone(link)); }
  async listLinksOwned(actor: ServiceActor, jobId: string) { if (!await this.getOwned(actor, jobId)) return undefined; return this.linkRows.filter(x => x.jobId === jobId); }
  async listEventsOwned(actor: ServiceActor, jobId: string, afterSequence = 0, limit = 100) { if (!await this.getOwned(actor, jobId)) return undefined; return this.eventRows.filter(x => x.jobId === jobId && x.sequence > afterSequence).slice(0, limit); }
  async getIdempotency(actor: ServiceActor, op: IdempotencyOperation, key: string) { return this.idempotencyRows.get(`${actor.tenantId}:${actor.userId}:${op}:${key}`); }
  async createIdempotency(row: IdempotencyRecord) { this.idempotencyRows.set(`${row.tenantId}:${row.userId}:${row.operation}:${row.key}`, structuredClone(row)); }
  async appendOutbox(row: OutboxRecord) { if (this.outboxRows.some(x => x.jobId === row.jobId && x.commandVersion === row.commandVersion)) throw new Error('duplicate command version'); this.outboxRows.push(structuredClone(row)); }
  async appendAudit(row: AuditRecord) { this.auditRows.push(structuredClone(row)); }
  async listArtifactsOwned(actor: ServiceActor, jobId: string) { if (!await this.getOwned(actor, jobId)) return undefined; return this.artifactRows.filter(x => x.jobId === jobId); }
}

// ArtifactMetadataStore has a deliberately distinct adapter to avoid ambiguity with event/link list methods.
export class InMemoryArtifactStore implements ArtifactMetadataStore {
  constructor(private readonly service: InMemoryServiceStore) {}
  async listOwned(actor: ServiceActor, jobId: string) { return this.service.listArtifactsOwned(actor, jobId); }
}
