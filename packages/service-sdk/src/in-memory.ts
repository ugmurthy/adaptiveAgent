import type { ArtifactMetadataStore, ServiceTransaction, TransactionalServiceStore } from './ports.js';
import type { AdminJobListOptions, ArtifactMetadata, AuditRecord, IdempotencyOperation, IdempotencyRecord, JobListOptions, JobRunLink, OutboxRecord, PublicEventEnvelope, ServiceActor, ServiceJob } from './types.js';

export class InMemoryServiceStore implements TransactionalServiceStore, ServiceTransaction {
  readonly jobRows = new Map<string, ServiceJob>(); readonly linkRows: JobRunLink[] = []; readonly idempotencyRows = new Map<string, IdempotencyRecord>(); readonly eventRows: PublicEventEnvelope[] = []; readonly outboxRows: OutboxRecord[] = []; readonly auditRows: AuditRecord[] = []; readonly artifactRows: ArtifactMetadata[] = [];
  jobs = this; links = this; idempotency = this; events = this; outbox = this; audit = this; admin = this;
  failAfterJobCreate = false;
  async transaction<T>(operation: (tx: ServiceTransaction) => Promise<T>): Promise<T> { const snapshot = structuredClone({ jobs: [...this.jobRows], links: this.linkRows, idem: [...this.idempotencyRows], outbox: this.outboxRows, audit: this.auditRows }); try { return await operation(this); } catch (error) { this.jobRows.clear(); snapshot.jobs.forEach(x => this.jobRows.set(...x)); this.linkRows.splice(0,Infinity,...snapshot.links); this.idempotencyRows.clear(); snapshot.idem.forEach(x => this.idempotencyRows.set(...x)); this.outboxRows.splice(0,Infinity,...snapshot.outbox); this.auditRows.splice(0,Infinity,...snapshot.audit); throw error; } }
  async createJob(job: ServiceJob) { this.jobRows.set(job.id, structuredClone(job)); if (this.failAfterJobCreate) throw new Error('injected transaction failure'); }
  async getOwned(actor: ServiceActor, id: string) { const j = this.jobRows.get(id); return j?.tenantId === actor.tenantId && j.ownerUserId === actor.userId ? structuredClone(j) : undefined; }
  async updateOwned(actor: ServiceActor, job: ServiceJob) { if (!await this.getOwned(actor, job.id)) return false; this.jobRows.set(job.id, structuredClone(job)); return true; }
  async listOwned(actor:ServiceActor,o:JobListOptions) { return this.page([...this.jobRows.values()].filter(j=>j.tenantId===actor.tenantId&&j.ownerUserId===actor.userId),o); }
  async getAny(id:string) { const j=this.jobRows.get(id); return j&&structuredClone(j); }
  async updateAny(job:ServiceJob) { if(!this.jobRows.has(job.id))return false;this.jobRows.set(job.id,structuredClone(job));return true; }
  async listAll(o:AdminJobListOptions) { return this.page([...this.jobRows.values()].filter(j=>(!o.tenantId||j.tenantId===o.tenantId)&&(!o.ownerUserId||j.ownerUserId===o.ownerUserId)),o); }
  private page(rows:ServiceJob[],o:JobListOptions) { const limit=o.limit??50,offset=o.offset??0;const filtered=rows.filter(j=>(!o.kind||j.kind===o.kind)&&(!o.state||j.state===o.state)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));return {items:structuredClone(filtered.slice(offset,offset+limit)),total:filtered.length,limit,offset}; }
  async add(link: JobRunLink) { this.linkRows.push(structuredClone(link)); }
  async listLinksOwned(actor: ServiceActor, jobId: string) { if (!await this.getOwned(actor, jobId)) return undefined; return this.linkRows.filter(x => x.jobId === jobId); }
  async listEventsOwned(actor: ServiceActor, jobId: string, afterSequence = 0, limit = 100) { if (!await this.getOwned(actor, jobId)) return undefined; return this.eventRows.filter(x => x.jobId === jobId && x.sequence > afterSequence).slice(0, limit); }
  async getIdempotency(actor: ServiceActor, op: IdempotencyOperation, key: string) { return this.idempotencyRows.get(`${actor.tenantId}:${actor.userId}:${op}:${key}`); }
  async createIdempotency(row: IdempotencyRecord) { this.idempotencyRows.set(`${row.tenantId}:${row.userId}:${row.operation}:${row.key}`, structuredClone(row)); }
  async appendOutbox(row: OutboxRecord) { if (this.outboxRows.some(x => x.jobId === row.jobId && x.commandVersion === row.commandVersion)) throw new Error('duplicate command version'); this.outboxRows.push(structuredClone(row)); }
  async appendAudit(row: AuditRecord) { this.auditRows.push(structuredClone(row)); }
  async listForJob(jobId:string) { return structuredClone(this.auditRows.filter(x=>x.jobId===jobId)); }
  async overview() { const jobs=[...this.jobRows.values()];const jobsByState:Record<string,number>={};jobs.forEach(j=>jobsByState[j.state]=(jobsByState[j.state]??0)+1);return {totalJobs:jobs.length,totalTenants:new Set(jobs.map(j=>j.tenantId)).size,totalUsers:new Set(jobs.map(j=>`${j.tenantId}\0${j.ownerUserId}`)).size,jobsByState}; }
  async listTenants() { const ids=new Set([...this.jobRows.values()].map(j=>j.tenantId));return [...ids].map(tenantId=>({tenantId,jobCount:[...this.jobRows.values()].filter(j=>j.tenantId===tenantId).length})); }
  async listUsers(tenantId:string|undefined,limit:number,offset:number) { const keys=new Set([...this.jobRows.values()].filter(j=>!tenantId||j.tenantId===tenantId).map(j=>`${j.tenantId}\0${j.ownerUserId}`));const all=[...keys].map(k=>{const [t,u]=k.split('\0');return {tenantId:t!,userId:u!,jobCount:[...this.jobRows.values()].filter(j=>j.tenantId===t&&j.ownerUserId===u).length};});return {items:all.slice(offset,offset+limit),total:all.length,limit,offset}; }
  async listEvents(jobId:string,after=0,limit=100) { return this.eventRows.filter(x=>x.jobId===jobId&&x.sequence>after).slice(0,limit); }
  async listLinks(jobId:string) { return this.linkRows.filter(x=>x.jobId===jobId); }
  async listArtifactsOwned(actor: ServiceActor, jobId: string) { if (!await this.getOwned(actor, jobId)) return undefined; return this.artifactRows.filter(x => x.jobId === jobId); }
}

// ArtifactMetadataStore has a deliberately distinct adapter to avoid ambiguity with event/link list methods.
export class InMemoryArtifactStore implements ArtifactMetadataStore {
  constructor(private readonly service: InMemoryServiceStore) {}
  async listOwned(actor: ServiceActor, jobId: string) { return this.service.listArtifactsOwned(actor, jobId); }
  async listAny(jobId:string) { return this.service.artifactRows.filter(x=>x.jobId===jobId); }
}
