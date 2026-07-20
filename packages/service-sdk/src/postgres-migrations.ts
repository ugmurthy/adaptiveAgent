export interface ServicePostgresMigration { name: string; sql: string }
export const SERVICE_POSTGRES_MIGRATIONS: ServicePostgresMigration[] = [{ name: 'service:001_jobs', sql: `
create table if not exists service_tenants (id text primary key, created_at timestamptz not null default now());
create table if not exists service_users (tenant_id text not null references service_tenants(id), id text not null, created_at timestamptz not null default now(), primary key (tenant_id,id));
create table if not exists service_jobs (
 id uuid primary key, tenant_id text not null, owner_user_id text not null, kind text not null, state text not null,
 session_id text not null, coordinator_run_id uuid, request jsonb not null, profile_refs jsonb not null,
 command_version integer not null, pending_command jsonb not null, result jsonb, error jsonb,
 created_at timestamptz not null, updated_at timestamptz not null,
 foreign key (tenant_id,owner_user_id) references service_users(tenant_id,id), check (command_version >= 1));
create index if not exists service_jobs_owner_idx on service_jobs(tenant_id,owner_user_id,created_at desc);
create index if not exists service_jobs_state_idx on service_jobs(state,updated_at);
create table if not exists service_job_run_links (job_id uuid not null references service_jobs(id) on delete cascade, run_id uuid not null references agent_runs(id) on delete cascade, role text not null, linked_at timestamptz not null, primary key(job_id,run_id,role));
create index if not exists service_job_run_links_run_idx on service_job_run_links(run_id);
create table if not exists service_idempotency_keys (tenant_id text not null, user_id text not null, operation text not null, idempotency_key text not null, request_hash text not null, job_id uuid not null references service_jobs(id), created_at timestamptz not null, primary key(tenant_id,user_id,operation,idempotency_key));
create table if not exists service_public_events (id uuid primary key, job_id uuid not null references service_jobs(id) on delete cascade, sequence bigint not null, event_type text not null, data jsonb not null, occurred_at timestamptz not null, source_event_id text, unique(job_id,sequence), unique(job_id,source_event_id));
create index if not exists service_public_events_replay_idx on service_public_events(job_id,sequence);
create table if not exists service_outbox (id uuid primary key, job_id uuid not null references service_jobs(id) on delete cascade, command_version integer not null, command jsonb not null, created_at timestamptz not null, published_at timestamptz, unique(job_id,command_version));
create index if not exists service_outbox_pending_idx on service_outbox(created_at) where published_at is null;
create table if not exists service_audit_records (id uuid primary key, tenant_id text not null, user_id text not null, job_id uuid not null references service_jobs(id), action text not null, data jsonb, occurred_at timestamptz not null);
create index if not exists service_audit_job_idx on service_audit_records(tenant_id,user_id,job_id,occurred_at desc);
` }, { name: 'service:002_processed_command', sql: `
alter table service_jobs add column if not exists processed_command_version integer not null default 0;
alter table service_jobs drop constraint if exists service_jobs_processed_command_check;
alter table service_jobs add constraint service_jobs_processed_command_check check (processed_command_version >= 0 and processed_command_version <= command_version);
` }, { name: 'service:003_outbox_processing', sql: `
alter table service_outbox add column if not exists processed_at timestamptz;
alter table service_outbox add column if not exists lease_owner text;
alter table service_outbox add column if not exists lease_expires_at timestamptz;
create index if not exists service_outbox_processing_idx
  on service_outbox(job_id, command_version)
  where processed_at is null;
create index if not exists service_outbox_lease_idx
  on service_outbox(lease_expires_at)
  where processed_at is null;
` }, { name: 'service:004_artifacts', sql: `
create unique index if not exists service_jobs_authoritative_owner_idx
  on service_jobs(id,tenant_id,owner_user_id);
create table if not exists service_artifacts (
 id uuid primary key,
 tenant_id text not null,
 owner_user_id text not null,
 job_id uuid not null,
 run_id uuid,
 tool_execution_id text,
 storage_key text not null unique,
 original_filename text not null,
 media_type text not null,
 byte_size bigint not null,
 content_hash text not null,
 status text not null,
 created_at timestamptz not null,
 updated_at timestamptz not null,
 available_at timestamptz,
 expires_at timestamptz,
 deleted_at timestamptz,
 foreign key (job_id,tenant_id,owner_user_id)
   references service_jobs(id,tenant_id,owner_user_id) on delete cascade,
 check (byte_size >= 0),
 check (status in ('uploading','scanning','available','quarantined','deleted'))
);
create index if not exists service_artifacts_owner_idx
  on service_artifacts(job_id,tenant_id,owner_user_id,created_at);
create index if not exists service_artifacts_reconcile_idx
  on service_artifacts(status,expires_at,updated_at);
create table if not exists service_access_audit_records (
 id uuid primary key,
 tenant_id text not null,
 user_id text not null,
 action text not null,
 target_job_id text not null,
 target_artifact_id text,
 allowed boolean not null,
 occurred_at timestamptz not null
);
create index if not exists service_access_audit_actor_idx
  on service_access_audit_records(tenant_id,user_id,occurred_at desc);
` }, { name: 'service:005_admin_audit', sql: `
alter table service_audit_records alter column job_id drop not null;
create index if not exists service_jobs_admin_filter_idx on service_jobs(tenant_id,owner_user_id,kind,state,created_at desc);
` }];
export interface ServicePostgresClient { query<T = Record<string,unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> }
export interface ServicePostgresTransactionClient extends ServicePostgresClient { release(): void }
export interface ServicePostgresPool extends ServicePostgresClient { connect(): Promise<ServicePostgresTransactionClient> }
export async function runServicePostgresMigrations(pool: ServicePostgresPool): Promise<void> { const tx = await pool.connect(); try { await tx.query('BEGIN'); await tx.query("select pg_advisory_xact_lock(hashtext('adaptive-agent:migrations'))"); await tx.query('create table if not exists adaptive_agent_migrations (name text primary key, applied_at timestamptz not null default now())'); for (const migration of SERVICE_POSTGRES_MIGRATIONS) { const old = await tx.query('select name from adaptive_agent_migrations where name=$1',[migration.name]); if (!old.rowCount) { await tx.query(migration.sql); await tx.query('insert into adaptive_agent_migrations(name) values($1)',[migration.name]); } } await tx.query('COMMIT'); } catch (e) { await tx.query('ROLLBACK'); throw e; } finally { tx.release(); } }
