import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('Postgres migration files', () => {
  it('declares all required gateway-owned tables', async () => {
    const sql = await readFile(new URL('../migrations/001_gateway_postgres.sql', import.meta.url), 'utf-8');

    expect(sql).toContain('create table if not exists gateway_sessions');
    expect(sql).toContain('create table if not exists gateway_transcript_messages');
    expect(sql).toContain('create table if not exists gateway_session_run_links');
    expect(sql).toContain('create table if not exists gateway_cron_jobs');
    expect(sql).toContain('create table if not exists gateway_cron_runs');
  });

  it('declares all required runtime durability tables', async () => {
    const sql = await readFile(new URL('../../core/migrations/001_runtime_postgres.sql', import.meta.url), 'utf-8');
    const deltaSql = await readFile(new URL('../../core/migrations/002_tool_observability.sql', import.meta.url), 'utf-8');

    expect(sql).toContain('create table if not exists agent_runs');
    expect(sql).toContain('session_id text');
    expect(sql).toContain('agent_runs_session_idx');
    expect(sql).toContain('create table if not exists agent_events');
    expect(sql).toContain('create table if not exists run_snapshots');
    expect(sql).toContain('create table if not exists plans');
    expect(sql).toContain('create table if not exists plan_steps');
    expect(sql).toContain('create table if not exists plan_executions');
    expect(sql).toContain('create table if not exists tool_executions');
    expect(deltaSql).toContain('alter table agent_events');
    expect(deltaSql).toContain('add column if not exists tool_call_id');
    expect(deltaSql).toContain('alter table tool_executions');
    expect(deltaSql).toContain('add column if not exists input jsonb');
    expect(deltaSql).toContain('add column if not exists child_run_id uuid');
  });
});
