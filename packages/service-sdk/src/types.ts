export const SERVICE_API_VERSION = 1 as const;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface ServiceActor { tenantId: string; userId: string; roles?: readonly string[] }
export type JobKind = 'run' | 'chat' | 'swarm' | 'orchestration';
export type JobState = 'accepted' | 'queued' | 'running' | 'waiting_approval' | 'waiting_clarification' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled';
export type WorkloadClass = JobKind;
export interface AgentProfileRef { agentId: string; version: string; contentHash: string }
export interface ServiceFileRef { artifactId: string }
export interface RunRequest { schemaVersion: 1; agentId: string; goal: string; input?: JsonValue; fileRefs?: ServiceFileRef[] }
export interface ChatRequest { schemaVersion: 1; agentId: string; message: string; conversationId?: string; fileRefs?: ServiceFileRef[] }
export interface SwarmRunRequest { schemaVersion: 1; coordinatorAgentId: string; workerAgentIds: string[]; objective: string; fileRefs?: ServiceFileRef[] }
export interface OrchestratedRunRequest { schemaVersion: 1; orchestratorAgentId: string; agentIds: string[]; objective: string; fileRefs?: ServiceFileRef[] }
export type ServiceJobRequest = RunRequest | ChatRequest | SwarmRunRequest | OrchestratedRunRequest;
export interface SubmissionOptions { idempotencyKey?: string }
export interface ControlOptions { idempotencyKey?: string }
export interface ServiceResult { schemaVersion: 1; value: JsonValue; completedAt: string }
export interface ServiceError { schemaVersion: 1; code: string; message: string; retryable: boolean }
export type JobRunRole = 'root' | 'coordinator' | 'worker' | 'quality' | 'synthesizer' | 'child' | 'continuation';
export interface JobRunLink { jobId: string; runId: string; role: JobRunRole; linkedAt: string }
export type CommandKind = 'execute' | 'cancel' | 'retry' | 'recover' | 'resume' | 'continue' | 'steer' | 'resolve_approval' | 'resolve_clarification';
export type IdempotencyOperation = JobKind | `control:${Exclude<CommandKind, 'execute'>}`;
export interface PendingCommand { kind: CommandKind; version: number; payload?: JsonValue; requestedAt: string }
export interface ServiceJob { schemaVersion: 1; id: string; tenantId: string; ownerUserId: string; kind: JobKind; state: JobState; sessionId: string; coordinatorRunId?: string; request: ServiceJobRequest; profiles: AgentProfileRef[]; commandVersion: number; processedCommandVersion: number; pendingCommand: PendingCommand; result?: ServiceResult; error?: ServiceError; createdAt: string; updatedAt: string }
export interface PublicEventEnvelope { schemaVersion: 1; id: string; jobId: string; sequence: number; type: string; data: JsonValue; occurredAt: string }
export type ArtifactStatus = 'uploading' | 'scanning' | 'available' | 'quarantined' | 'deleted';
export interface ArtifactMetadata { schemaVersion: 1; id: string; tenantId: string; ownerUserId: string; jobId: string; runId?: string; toolExecutionId?: string; filename: string; mediaType: string; byteSize: number; contentHash: string; status: ArtifactStatus; createdAt: string; availableAt?: string; expiresAt?: string; deletedAt?: string }
export interface OutboxRecord { id: string; jobId: string; commandVersion: number; command: PendingCommand; createdAt: string; publishedAt?: string; processedAt?: string; leaseOwner?: string; leaseExpiresAt?: string }
export interface AuditRecord { id: string; tenantId: string; userId: string; jobId?: string; action: string; occurredAt: string; data?: JsonValue }
export interface Page<T> { items: T[]; total: number; limit: number; offset: number }
export interface JobListOptions { kind?: JobKind; state?: JobState; limit?: number; offset?: number }
export interface AdminJobListOptions extends JobListOptions { tenantId?: string; ownerUserId?: string }
export interface TenantSummary { tenantId: string; jobCount: number }
export interface UserSummary { tenantId: string; userId: string; jobCount: number }
export interface AdminOverview { totalJobs: number; totalTenants: number; totalUsers: number; jobsByState: Partial<Record<JobState, number>> }
export interface IdempotencyRecord { tenantId: string; userId: string; operation: IdempotencyOperation; key: string; requestHash: string; jobId: string; createdAt: string }
export class ServiceNotFoundError extends Error { constructor() { super('Resource not found.'); this.name = 'ServiceNotFoundError'; } }
export class ServiceForbiddenError extends Error { constructor() { super('Forbidden.'); this.name = 'ServiceForbiddenError'; } }
export class IdempotencyConflictError extends Error { constructor() { super('Idempotency key was already used with a different request.'); this.name = 'IdempotencyConflictError'; } }
export class InvalidJobStateError extends Error { constructor(state: JobState, command: CommandKind) { super(`Command ${command} is not valid while job is ${state}.`); this.name = 'InvalidJobStateError'; } }
