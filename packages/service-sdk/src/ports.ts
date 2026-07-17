import type { AgentProfileRef, ArtifactMetadata, AuditRecord, IdempotencyOperation, IdempotencyRecord, JobRunLink, OutboxRecord, PublicEventEnvelope, ServiceActor, ServiceJob, WorkloadClass } from './types.js';
export interface JobStore { createJob(job: ServiceJob): Promise<void>; getOwned(actor: ServiceActor, jobId: string): Promise<ServiceJob | undefined>; updateOwned(actor: ServiceActor, job: ServiceJob): Promise<boolean> }
export interface JobRunLinkStore { add(link: JobRunLink): Promise<void>; listLinksOwned(actor: ServiceActor, jobId: string): Promise<JobRunLink[] | undefined> }
export interface IdempotencyStore { getIdempotency(actor: ServiceActor, operation: IdempotencyOperation, key: string): Promise<IdempotencyRecord | undefined>; createIdempotency(record: IdempotencyRecord): Promise<void> }
export interface PublicEventStore { listEventsOwned(actor: ServiceActor, jobId: string, afterSequence?: number, limit?: number): Promise<PublicEventEnvelope[] | undefined> }
export interface OutboxStore { appendOutbox(record: OutboxRecord): Promise<void> }
export interface AuditStore { appendAudit(record: AuditRecord): Promise<void> }
export interface ServiceTransaction extends JobStore, JobRunLinkStore, IdempotencyStore, OutboxStore, AuditStore {}
export interface TransactionalServiceStore { transaction<T>(operation: (tx: ServiceTransaction) => Promise<T>): Promise<T>; jobs: JobStore; links: JobRunLinkStore; idempotency: IdempotencyStore; events: PublicEventStore; outbox: OutboxStore; audit: AuditStore }
export interface QueuePublisher { publish(payload: { jobId: string }): Promise<void> }
export interface AgentRegistry { resolve(agentId: string, workload: WorkloadClass): Promise<{ profile: AgentProfileRef; allowedWorkloads: readonly WorkloadClass[] } | undefined> }
export interface AuthorizationPolicy { authorize(actor: ServiceActor, operation: string): Promise<boolean> }
export interface ArtifactMetadataStore { listOwned(actor: ServiceActor, jobId: string): Promise<ArtifactMetadata[] | undefined> }
export interface ArtifactStorage { put(storageKey: string, data: Uint8Array): Promise<void>; get(storageKey: string): Promise<Uint8Array | undefined>; delete(storageKey: string): Promise<void> }
export interface Clock { now(): Date }
export interface IdGenerator { generate(): string }
