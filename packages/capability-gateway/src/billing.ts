import type { Pool, PoolClient, QueryResult } from 'pg';
import type {
  AccountUsageParams,
  AccountUsageResult,
  InferenceTier,
} from '@adaptive-agent/gateway-protocol';
import { GatewayError } from './errors.js';

export type BillingStatus = 'active' | 'completed' | 'failed' | 'cancelled';

export interface BillingRecord {
  accountId: string;
  tenantId: string;
  subject: string;
  permitId: string;
  capability: 'model/generate';
  callId: string;
  requestHash: string;
  requestedTier: InferenceTier;
  routePolicyVersion: string;
  selectedRouteIndex?: number;
  provider?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  status: BillingStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface BillingStore {
  begin(record: BillingRecord): Promise<boolean>;
  finish(record: BillingRecord): Promise<void>;
  get(accountId: string, callId: string): Promise<BillingRecord | null>;
  listUsage(accountId: string, params: AccountUsageParams): Promise<AccountUsageResult>;
  close?(): Promise<void>;
}

export class InMemoryBillingStore implements BillingStore {
  readonly records = new Map<string, BillingRecord>();

  async begin(record: BillingRecord): Promise<boolean> {
    const key = billingKey(record.accountId, record.callId);
    if (this.records.has(key)) return false;
    this.records.set(key, structuredClone(record));
    return true;
  }

  async finish(record: BillingRecord): Promise<void> {
    if (record.status === 'active') {
      throw new Error('A terminal billing update requires a terminal status');
    }
    const key = billingKey(record.accountId, record.callId);
    const existing = this.records.get(key);
    if (!existing || existing.requestHash !== record.requestHash) {
      throw new GatewayError('idempotency_conflict', { callId: record.callId });
    }
    if (existing.status !== 'active') {
      if (sameTerminalBillingRecord(existing, record)) return;
      throw new GatewayError('idempotency_conflict', { callId: record.callId });
    }
    this.records.set(key, structuredClone(record));
  }

  async get(accountId: string, callId: string): Promise<BillingRecord | null> {
    return structuredClone(this.records.get(billingKey(accountId, callId)) ?? null);
  }

  async listUsage(
    accountId: string,
    params: AccountUsageParams,
  ): Promise<AccountUsageResult> {
    const offset = parseCursor(params.cursor);
    const limit = params.limit ?? 100;
    const matches = [...this.records.values()]
      .filter((record) =>
        record.accountId === accountId &&
        record.status === 'completed' &&
        record.updatedAt >= params.from &&
        record.updatedAt <= params.to,
      )
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    const page = matches.slice(offset, offset + limit);
    return {
      items: page.map((record) => ({
        capability: record.capability,
        units: record.totalTokens,
        cost: record.cost,
        occurredAt: record.updatedAt,
      })),
      ...(offset + page.length < matches.length
        ? { nextCursor: String(offset + page.length) }
        : {}),
    };
  }
}

interface PostgresQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
}

export const BILLING_INSERT_SQL = `
insert into capability_gateway_billing (
  account_id, tenant_id, subject_id, permit_id, capability, call_id,
  request_hash, requested_tier, route_policy_version, selected_route_index,
  provider, model, input_tokens, output_tokens, total_tokens, cost,
  status, created_at, updated_at, completed_at
) values (
  $1, $2, $3, $4, $5, $6,
  $7, $8, $9, $10,
  $11, $12, $13, $14, $15, $16,
  $17, $18, $19, $20
)
on conflict (account_id, call_id) do nothing
returning account_id
`;

export const BILLING_FINISH_SQL = `
update capability_gateway_billing
set selected_route_index = $4,
    provider = $5,
    model = $6,
    input_tokens = $7,
    output_tokens = $8,
    total_tokens = $9,
    cost = $10,
    status = $11,
    updated_at = $12,
    completed_at = $13
where account_id = $1
  and call_id = $2
  and request_hash = $3
  and status = 'active'
`;

export class PostgresBillingStore implements BillingStore {
  constructor(
    private readonly db: PostgresQueryable & Partial<Pick<Pool, 'end'>>,
    private readonly ownsPool = false,
  ) {}

  async begin(record: BillingRecord): Promise<boolean> {
    const result = await this.db.query(BILLING_INSERT_SQL, billingInsertParameters(record));
    return (result.rowCount ?? result.rows.length) === 1;
  }

  async finish(record: BillingRecord): Promise<void> {
    if (record.status === 'active') {
      throw new Error('A terminal billing update requires a terminal status');
    }
    const result = await this.db.query(BILLING_FINISH_SQL, billingFinishParameters(record));
    if ((result.rowCount ?? result.rows.length) !== 1) {
      const existing = await this.get(record.accountId, record.callId);
      if (existing && sameTerminalBillingRecord(existing, record)) return;
      throw new GatewayError('idempotency_conflict', { callId: record.callId });
    }
  }

  async get(accountId: string, callId: string): Promise<BillingRecord | null> {
    const result = await this.db.query(
      'select * from capability_gateway_billing where account_id = $1 and call_id = $2',
      [accountId, callId],
    );
    return result.rows[0] ? billingRecordFromRow(result.rows[0]) : null;
  }

  async listUsage(
    accountId: string,
    params: AccountUsageParams,
  ): Promise<AccountUsageResult> {
    const offset = parseCursor(params.cursor);
    const limit = params.limit ?? 100;
    const result = await this.db.query(`
      select capability, total_tokens, cost, updated_at
      from capability_gateway_billing
      where account_id = $1
        and status = 'completed'
        and updated_at between $2 and $3
      order by updated_at, call_id
      limit $4 offset $5
    `, [accountId, params.from, params.to, limit + 1, offset]);
    const rows = result.rows.slice(0, limit);
    return {
      items: rows.map((row) => ({
        capability: String(row.capability),
        units: Number(row.total_tokens),
        cost: Number(row.cost),
        occurredAt: toIso(row.updated_at),
      })),
      ...(result.rows.length > limit ? { nextCursor: String(offset + limit) } : {}),
    };
  }

  async close(): Promise<void> {
    if (this.ownsPool && this.db.end) await this.db.end();
  }
}

export async function runBillingMigration(db: Pick<Pool | PoolClient, 'query'>): Promise<void> {
  const sql = await Bun.file(new URL('../migrations/001_capability_gateway_billing.sql', import.meta.url)).text();
  await db.query(sql);
}

export function billingInsertParameters(record: BillingRecord): unknown[] {
  return [
    record.accountId,
    record.tenantId,
    record.subject,
    record.permitId,
    record.capability,
    record.callId,
    record.requestHash,
    record.requestedTier,
    record.routePolicyVersion,
    record.selectedRouteIndex ?? null,
    record.provider ?? null,
    record.model ?? null,
    record.inputTokens,
    record.outputTokens,
    record.totalTokens,
    record.cost,
    record.status,
    record.createdAt,
    record.updatedAt,
    record.completedAt ?? null,
  ];
}

export function billingFinishParameters(record: BillingRecord): unknown[] {
  return [
    record.accountId,
    record.callId,
    record.requestHash,
    record.selectedRouteIndex ?? null,
    record.provider ?? null,
    record.model ?? null,
    record.inputTokens,
    record.outputTokens,
    record.totalTokens,
    record.cost,
    record.status,
    record.updatedAt,
    record.completedAt ?? null,
  ];
}

function billingRecordFromRow(row: Record<string, unknown>): BillingRecord {
  return {
    accountId: String(row.account_id),
    tenantId: String(row.tenant_id),
    subject: String(row.subject_id),
    permitId: String(row.permit_id),
    capability: 'model/generate',
    callId: String(row.call_id),
    requestHash: String(row.request_hash),
    requestedTier: row.requested_tier as InferenceTier,
    routePolicyVersion: String(row.route_policy_version),
    selectedRouteIndex: row.selected_route_index === null
      ? undefined
      : Number(row.selected_route_index),
    provider: row.provider === null ? undefined : String(row.provider),
    model: row.model === null ? undefined : String(row.model),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    totalTokens: Number(row.total_tokens),
    cost: Number(row.cost),
    status: row.status as BillingStatus,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    completedAt: row.completed_at === null ? undefined : toIso(row.completed_at),
  };
}

function billingKey(accountId: string, callId: string): string {
  return `${accountId}\u0000${callId}`;
}

function sameTerminalBillingRecord(left: BillingRecord, right: BillingRecord): boolean {
  return left.status !== 'active' &&
    left.accountId === right.accountId &&
    left.callId === right.callId &&
    left.requestHash === right.requestHash &&
    left.status === right.status &&
    left.selectedRouteIndex === right.selectedRouteIndex &&
    left.provider === right.provider &&
    left.model === right.model &&
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.totalTokens === right.totalTokens &&
    left.cost === right.cost;
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const parsed = Number(cursor);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new GatewayError('invalid_params');
  }
  return parsed;
}

function toIso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return date.toISOString();
}
