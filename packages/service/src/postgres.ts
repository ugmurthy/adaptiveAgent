import type {
  CommandKind,
  JobKind,
  JobRunLink,
  JobRunRole,
  JobState,
  PendingCommand,
  ServiceError,
  ServiceJob,
  ServiceResult,
} from '@adaptive-agent/service-sdk';
import type { Pool, PoolClient } from 'pg';

export interface DispatchRecord {
  id: string;
  jobId: string;
  commandVersion: number;
  kind: JobKind;
}

export interface ClaimedJob {
  job: ServiceJob;
  links: JobRunLink[];
  commandVersion: number;
  command: PendingCommand;
  leaseOwner: string;
  recovery: boolean;
}

export type ClaimResult =
  | { action: 'ack' }
  | { action: 'process'; claim: ClaimedJob };

interface CommandRow {
  id: string;
  command_version: number;
  command: PendingCommand;
}

const TERMINAL_STATES = new Set<JobState>(['succeeded', 'failed', 'cancelled']);

export class ServiceBackendStore {
  constructor(
    private readonly pool: Pool,
    private readonly staleAfterMs = 60_000,
    private readonly commandLeaseMs = 5 * 60_000,
  ) {}

  async dispatchBatch(limit: number, publish: (record: DispatchRecord) => Promise<void>): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<DispatchRecord>(`
        select o.id, o.job_id as "jobId", o.command_version as "commandVersion", j.kind
        from service_outbox o
        join service_jobs j on j.id = o.job_id
        where o.published_at is null
        order by o.created_at
        for update of o skip locked
        limit $1`, [limit]);

      for (const record of result.rows) {
        await publish(record);
        await client.query('update service_outbox set published_at = now() where id = $1', [record.id]);
      }

      await client.query('COMMIT');
      return result.rowCount ?? result.rows.length;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async claim(jobId: string): Promise<ClaimResult> {
    return this.transaction(async (client) => {
      const result = await client.query('select * from service_jobs where id = $1 for update', [jobId]);
      const row = result.rows[0];
      if (!row) return { action: 'ack' };

      const persistedJob = mapJob(row);
      const commandResult = await client.query<CommandRow>(`
        select id, command_version, command
        from service_outbox
        where job_id = $1
          and processed_at is null
          and (lease_expires_at is null or lease_expires_at <= now())
        order by command_version
        for update skip locked
        limit 1`, [jobId]);
      const commandRow = commandResult.rows[0];
      if (!commandRow) return { action: 'ack' };

      const command = commandRow.command;
      const commandVersion = Number(commandRow.command_version);

      // A command can already be reflected in the durable job when its queue
      // acknowledgement was lost or execution won a race with cancellation.
      // Mark only that command complete; later commands remain claimable.
      const executeAlreadyReflected = command.kind === 'execute' && (
        TERMINAL_STATES.has(persistedJob.state)
        || persistedJob.state === 'waiting_approval'
        || persistedJob.state === 'waiting_clarification'
      );
      const cancelLostRace = command.kind === 'cancel' && TERMINAL_STATES.has(persistedJob.state);
      if (executeAlreadyReflected || cancelLostRace) {
        await markCommandProcessed(client, jobId, commandVersion);
        await advanceProcessedCursor(client, jobId);
        return { action: 'ack' };
      }

      const leaseOwner = crypto.randomUUID();
      await client.query(`
        update service_outbox
        set lease_owner = $3,
            lease_expires_at = now() + ($4 * interval '1 millisecond')
        where job_id = $1 and command_version = $2`,
      [jobId, commandVersion, leaseOwner, this.commandLeaseMs]);

      const nextState = command.kind === 'cancel'
        ? 'cancelling'
        : command.kind === 'steer'
          ? persistedJob.state
          : 'running';
      await client.query('update service_jobs set state = $2, updated_at = now() where id = $1', [jobId, nextState]);

      const links = await client.query<JobRunLink>(`
        select job_id as "jobId", run_id as "runId", role, linked_at as "linkedAt"
        from service_job_run_links
        where job_id = $1
        order by linked_at`, [jobId]);

      return {
        action: 'process',
        claim: {
          job: {
            ...persistedJob,
            state: nextState,
            commandVersion,
            pendingCommand: command,
          },
          links: links.rows,
          commandVersion,
          command,
          leaseOwner,
          recovery: links.rows.length > 0,
        },
      };
    });
  }

  async findStale(limit: number): Promise<DispatchRecord[]> {
    const result = await this.pool.query<DispatchRecord>(`
      select o.id,
             o.job_id as "jobId",
             o.command_version as "commandVersion",
             j.kind
      from service_outbox o
      join service_jobs j on j.id = o.job_id
      where o.processed_at is null
        and (o.lease_expires_at is null or o.lease_expires_at <= now())
        and o.created_at < now() - ($1 * interval '1 millisecond')
      order by o.created_at
      limit $2`, [this.staleAfterMs, limit]);
    return result.rows;
  }

  async complete(
    claim: Pick<ClaimedJob, 'job' | 'commandVersion' | 'command' | 'leaseOwner'>,
    state: JobState,
    result?: ServiceResult,
    error?: ServiceError,
  ): Promise<boolean> {
    return this.transaction(async (client) => {
      const commandResult = await client.query<{ lease_owner: string | null; processed_at: string | null }>(`
        select lease_owner, processed_at
        from service_outbox
        where job_id = $1 and command_version = $2
        for update`, [claim.job.id, claim.commandVersion]);
      const commandRow = commandResult.rows[0];
      if (!commandRow || commandRow.processed_at || commandRow.lease_owner !== claim.leaseOwner) return false;

      const jobResult = await client.query('select * from service_jobs where id = $1 for update', [claim.job.id]);
      const current = jobResult.rows[0] ? mapJob(jobResult.rows[0]) : undefined;
      if (!current) return false;

      const nextState = resolveCompletedState(current.state, claim.command.kind, state);
      await client.query(`
        update service_jobs
        set state = $2,
            result = case when $3::jsonb is null then result else $3::jsonb end,
            error = $4::jsonb,
            updated_at = now()
        where id = $1`, [
        claim.job.id,
        nextState,
        result ? JSON.stringify(result) : null,
        error ? JSON.stringify(error) : null,
      ]);
      await markCommandProcessed(client, claim.job.id, claim.commandVersion);
      await advanceProcessedCursor(client, claim.job.id);
      return true;
    });
  }

  async defer(
    claim: Pick<ClaimedJob, 'job' | 'commandVersion' | 'leaseOwner'>,
    state: JobState,
  ): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(`
        update service_outbox
        set lease_owner = null,
            lease_expires_at = now() + ($4 * interval '1 millisecond')
        where job_id = $1 and command_version = $2 and lease_owner = $3 and processed_at is null`,
      [claim.job.id, claim.commandVersion, claim.leaseOwner, this.staleAfterMs]);
      await client.query('update service_jobs set state = $2, updated_at = now() where id = $1', [claim.job.id, state]);
    });
  }

  async link(jobId: string, runId: string, role: JobRunRole): Promise<void> {
    await this.pool.query(`
      insert into service_job_run_links(job_id, run_id, role, linked_at)
      values($1, $2, $3, now())
      on conflict do nothing`, [jobId, runId, role]);
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await operation(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

async function markCommandProcessed(client: PoolClient, jobId: string, commandVersion: number): Promise<void> {
  await client.query(`
    update service_outbox
    set processed_at = now(), lease_owner = null, lease_expires_at = null
    where job_id = $1 and command_version = $2`, [jobId, commandVersion]);
}

async function advanceProcessedCursor(client: PoolClient, jobId: string): Promise<void> {
  await client.query(`
    update service_jobs
    set processed_command_version = greatest(
      processed_command_version,
      coalesce((
        select min(command_version) - 1
        from service_outbox
        where job_id = $1 and processed_at is null
      ), command_version)
    )
    where id = $1`, [jobId]);
}

function resolveCompletedState(current: JobState, command: CommandKind, outcome: JobState): JobState {
  if (command === 'steer') return current;
  if (command === 'execute' && (current === 'cancelling' || current === 'cancelled')) return current;
  return outcome;
}

function mapJob(row: Record<string, any>): ServiceJob {
  return {
    schemaVersion: 1,
    id: row.id,
    tenantId: row.tenant_id,
    ownerUserId: row.owner_user_id,
    kind: row.kind,
    state: row.state,
    sessionId: row.session_id,
    coordinatorRunId: row.coordinator_run_id ?? undefined,
    request: row.request,
    profiles: row.profile_refs,
    commandVersion: Number(row.command_version),
    processedCommandVersion: Number(row.processed_command_version),
    pendingCommand: row.pending_command as PendingCommand,
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    createdAt: toTimestamp(row.created_at),
    updatedAt: toTimestamp(row.updated_at),
  };
}

function toTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
