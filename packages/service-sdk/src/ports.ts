import type { AdminJobListOptions, AdminOverview, AgentProfileRef, ArtifactMetadata, AuditRecord, IdempotencyOperation, IdempotencyRecord, JobListOptions, JobRunLink, OutboxRecord, Page, PublicEventEnvelope, ServiceActor, ServiceJob, TenantSummary, UserSummary, WorkloadClass } from './types.js';
export interface JobStore { createJob(job: ServiceJob): Promise<void>; getOwned(actor: ServiceActor, jobId: string): Promise<ServiceJob | undefined>; updateOwned(actor: ServiceActor, job: ServiceJob): Promise<boolean>; listOwned(actor:ServiceActor, options:JobListOptions):Promise<Page<ServiceJob>>; getAny(jobId:string):Promise<ServiceJob|undefined>; updateAny(job:ServiceJob):Promise<boolean>; listAll(options:AdminJobListOptions):Promise<Page<ServiceJob>> }
export interface JobRunLinkStore { add(link: JobRunLink): Promise<void>; listLinksOwned(actor: ServiceActor, jobId: string): Promise<JobRunLink[] | undefined> }
export interface IdempotencyStore { getIdempotency(actor: ServiceActor, operation: IdempotencyOperation, key: string): Promise<IdempotencyRecord | undefined>; createIdempotency(record: IdempotencyRecord): Promise<void> }
export interface PublicEventStore { listEventsOwned(actor: ServiceActor, jobId: string, afterSequence?: number, limit?: number): Promise<PublicEventEnvelope[] | undefined> }
export interface OutboxStore { appendOutbox(record: OutboxRecord): Promise<void> }
export interface AuditStore { appendAudit(record: AuditRecord): Promise<void>; listForJob(jobId:string):Promise<AuditRecord[]> }
export interface AdminStore { overview():Promise<AdminOverview>; listTenants():Promise<TenantSummary[]>; listUsers(tenantId:string|undefined,limit:number,offset:number):Promise<Page<UserSummary>>; listEvents(jobId:string,after?:number,limit?:number):Promise<PublicEventEnvelope[]>; listLinks(jobId:string):Promise<JobRunLink[]> }
export interface ServiceTransaction extends JobStore, JobRunLinkStore, IdempotencyStore, OutboxStore, AuditStore {}
export interface TransactionalServiceStore { transaction<T>(operation: (tx: ServiceTransaction) => Promise<T>): Promise<T>; jobs: JobStore; links: JobRunLinkStore; idempotency: IdempotencyStore; events: PublicEventStore; outbox: OutboxStore; audit: AuditStore; admin:AdminStore }
export interface QueuePublisher { publish(payload: { jobId: string }): Promise<void> }
export interface AgentRegistry { resolve(agentId: string, workload: WorkloadClass): Promise<{ profile: AgentProfileRef; allowedWorkloads: readonly WorkloadClass[] } | undefined> }
export interface AuthorizationPolicy { authorize(actor: ServiceActor, operation: string): Promise<boolean> }
export interface ArtifactMetadataStore { listOwned(actor: ServiceActor, jobId: string): Promise<ArtifactMetadata[] | undefined>; listAny(jobId:string):Promise<ArtifactMetadata[]> }
export interface ArtifactStorage { put(storageKey: string, data: Uint8Array): Promise<void>; get(storageKey: string): Promise<Uint8Array | undefined>; delete(storageKey: string): Promise<void> }
export interface Clock { now(): Date }
export interface IdGenerator { generate(): string }
