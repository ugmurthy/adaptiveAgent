import type { ArtifactMetadataStore, ServiceTransaction, TransactionalServiceStore } from './ports.js';
import type { ServicePostgresClient, ServicePostgresPool } from './postgres-migrations.js';
import type { ArtifactMetadata, AuditRecord, IdempotencyOperation, IdempotencyRecord, JobRunLink, OutboxRecord, PublicEventEnvelope, ServiceActor, ServiceJob } from './types.js';

const OWNED_JOB = `select * from service_jobs where id=$1 and tenant_id=$2 and owner_user_id=$3`;
interface JobRow { id:string; tenant_id:string; owner_user_id:string; kind:ServiceJob['kind']; state:ServiceJob['state']; session_id:string; coordinator_run_id:string|null; request:ServiceJob['request']; profile_refs:ServiceJob['profiles']; command_version:number; processed_command_version:number; pending_command:ServiceJob['pendingCommand']; result:ServiceJob['result']|null; error:ServiceJob['error']|null; created_at:string; updated_at:string }
const mapJob = (r: JobRow): ServiceJob => ({ schemaVersion:1,id:r.id,tenantId:r.tenant_id,ownerUserId:r.owner_user_id,kind:r.kind,state:r.state,sessionId:r.session_id,coordinatorRunId:r.coordinator_run_id ?? undefined,request:r.request,profiles:r.profile_refs,commandVersion:r.command_version,processedCommandVersion:r.processed_command_version,pendingCommand:r.pending_command,result:r.result ?? undefined,error:r.error ?? undefined,createdAt:r.created_at,updatedAt:r.updated_at });
export class PostgresServiceStore implements TransactionalServiceStore {
  jobs; links; idempotency; events; outbox; audit;
  constructor(readonly pool: ServicePostgresPool) { const direct = new PostgresTransactionStore(pool); this.jobs=direct; this.links=direct; this.idempotency=direct; this.events=direct; this.outbox=direct; this.audit=direct; }
  async transaction<T>(operation:(tx:ServiceTransaction)=>Promise<T>):Promise<T> { const client=await this.pool.connect(); try { await client.query('BEGIN'); const result=await operation(new PostgresTransactionStore(client)); await client.query('COMMIT'); return result; } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); } }
}
export class PostgresTransactionStore implements ServiceTransaction {
  constructor(private readonly db: ServicePostgresClient) {}
  async createJob(j:ServiceJob) { await this.db.query(`insert into service_jobs(id,tenant_id,owner_user_id,kind,state,session_id,coordinator_run_id,request,profile_refs,command_version,processed_command_version,pending_command,result,error,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16)`,[j.id,j.tenantId,j.ownerUserId,j.kind,j.state,j.sessionId,j.coordinatorRunId??null,JSON.stringify(j.request),JSON.stringify(j.profiles),j.commandVersion,j.processedCommandVersion,JSON.stringify(j.pendingCommand),j.result?JSON.stringify(j.result):null,j.error?JSON.stringify(j.error):null,j.createdAt,j.updatedAt]); }
  async getOwned(a:ServiceActor,id:string) { const q=await this.db.query<JobRow>(OWNED_JOB,[id,a.tenantId,a.userId]); return q.rows[0] ? mapJob(q.rows[0]) : undefined; }
  async updateOwned(a:ServiceActor,j:ServiceJob) { const q=await this.db.query(`update service_jobs set state=$4,command_version=$5,processed_command_version=$6,pending_command=$7::jsonb,updated_at=$8 where id=$1 and tenant_id=$2 and owner_user_id=$3`,[j.id,a.tenantId,a.userId,j.state,j.commandVersion,j.processedCommandVersion,JSON.stringify(j.pendingCommand),j.updatedAt]); return q.rowCount===1; }
  async add(x:JobRunLink) { await this.db.query(`insert into service_job_run_links(job_id,run_id,role,linked_at) values($1,$2,$3,$4)`,[x.jobId,x.runId,x.role,x.linkedAt]); }
  async listLinksOwned(a:ServiceActor,jobId:string) { const owner=await this.getOwned(a,jobId); if(!owner)return undefined; const q=await this.db.query<any>(`select l.* from service_job_run_links l join service_jobs j on j.id=l.job_id where l.job_id=$1 and j.tenant_id=$2 and j.owner_user_id=$3 order by l.linked_at`,[jobId,a.tenantId,a.userId]); return q.rows.map(r=>({jobId:r.job_id,runId:r.run_id,role:r.role,linkedAt:r.linked_at} as JobRunLink)); }
  async listEventsOwned(a:ServiceActor,jobId:string,after=0,limit=100):Promise<PublicEventEnvelope[]|undefined> { const owner=await this.getOwned(a,jobId); if(!owner)return undefined; const q=await this.db.query<any>(`select e.* from service_public_events e join service_jobs j on j.id=e.job_id where e.job_id=$1 and j.tenant_id=$2 and j.owner_user_id=$3 and e.sequence>$4 order by e.sequence limit $5`,[jobId,a.tenantId,a.userId,after,limit]); return q.rows.map(r=>({schemaVersion:1,id:r.id,jobId:r.job_id,sequence:Number(r.sequence),type:r.event_type,data:r.data,occurredAt:r.occurred_at} satisfies PublicEventEnvelope)); }
  async getIdempotency(a:ServiceActor,op:IdempotencyOperation,key:string) { const q=await this.db.query<any>(`select * from service_idempotency_keys where tenant_id=$1 and user_id=$2 and operation=$3 and idempotency_key=$4`,[a.tenantId,a.userId,op,key]); const r=q.rows[0]; return r ? {tenantId:r.tenant_id,userId:r.user_id,operation:r.operation,key:r.idempotency_key,requestHash:r.request_hash,jobId:r.job_id,createdAt:r.created_at} as IdempotencyRecord : undefined; }
  async createIdempotency(r:IdempotencyRecord) { await this.db.query(`insert into service_idempotency_keys(tenant_id,user_id,operation,idempotency_key,request_hash,job_id,created_at) values($1,$2,$3,$4,$5,$6,$7)`,[r.tenantId,r.userId,r.operation,r.key,r.requestHash,r.jobId,r.createdAt]); }
  async appendOutbox(r:OutboxRecord) { await this.db.query(`insert into service_outbox(id,job_id,command_version,command,created_at) values($1,$2,$3,$4::jsonb,$5)`,[r.id,r.jobId,r.commandVersion,JSON.stringify(r.command),r.createdAt]); }
  async appendAudit(r:AuditRecord) { await this.db.query(`insert into service_audit_records(id,tenant_id,user_id,job_id,action,data,occurred_at) values($1,$2,$3,$4,$5,$6::jsonb,$7)`,[r.id,r.tenantId,r.userId,r.jobId,r.action,r.data?JSON.stringify(r.data):null,r.occurredAt]); }
}

interface ArtifactRow { id:string; tenant_id:string; owner_user_id:string; job_id:string; run_id:string|null; tool_execution_id:string|null; original_filename:string; media_type:string; byte_size:string|number; content_hash:string; status:ArtifactMetadata['status']; created_at:string|Date; available_at:string|Date|null; expires_at:string|Date|null; deleted_at:string|Date|null }
const iso = (value:string|Date):string => value instanceof Date ? value.toISOString() : value;
export const mapArtifactRow = (r:ArtifactRow):ArtifactMetadata => ({
  schemaVersion:1,id:r.id,tenantId:r.tenant_id,ownerUserId:r.owner_user_id,jobId:r.job_id,
  runId:r.run_id??undefined,toolExecutionId:r.tool_execution_id??undefined,filename:r.original_filename,
  mediaType:r.media_type,byteSize:Number(r.byte_size),contentHash:r.content_hash,status:r.status,
  createdAt:iso(r.created_at),availableAt:r.available_at?iso(r.available_at):undefined,
  expiresAt:r.expires_at?iso(r.expires_at):undefined,deletedAt:r.deleted_at?iso(r.deleted_at):undefined,
});

export class PostgresArtifactMetadataStore implements ArtifactMetadataStore {
  constructor(private readonly db:ServicePostgresClient) {}
  async listOwned(actor:ServiceActor,jobId:string):Promise<ArtifactMetadata[]|undefined> {
    const owner=await this.db.query(`select 1 from service_jobs where id=$1 and tenant_id=$2 and owner_user_id=$3`,[jobId,actor.tenantId,actor.userId]);
    if(!owner.rowCount)return undefined;
    const rows=await this.db.query<ArtifactRow>(`select a.* from service_artifacts a join service_jobs j on j.id=a.job_id where a.job_id=$1 and j.tenant_id=$2 and j.owner_user_id=$3 and a.status <> 'deleted' and (a.expires_at is null or a.expires_at>now()) order by a.created_at,a.id`,[jobId,actor.tenantId,actor.userId]);
    return rows.rows.map(mapArtifactRow);
  }
}
