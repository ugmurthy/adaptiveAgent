import { SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InMemoryArtifactStore,
  InMemoryServiceStore,
  ServiceSdk,
  type AgentRegistry,
  type ServiceActor,
} from '@adaptive-agent/service-sdk';

import { createJwtAuthenticator } from './http-auth.js';
import { buildHttpServer } from './http-server.js';

const actor: ServiceActor = { tenantId: 'tenant-1', userId: 'alice' };
const apps: Awaited<ReturnType<typeof buildHttpServer>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('Phase 4 HTTP API', () => {
  it('submits and polls every workload kind', async () => {
    const { app } = await fixture();
    const submissions = [
      ['/v1/jobs/run', { schemaVersion: 1, agentId: 'agent', goal: 'run' }, 'run'],
      ['/v1/jobs/chat', { schemaVersion: 1, agentId: 'agent', message: 'chat' }, 'chat'],
      ['/v1/jobs/swarm', { schemaVersion: 1, coordinatorAgentId: 'agent', workerAgentIds: ['worker'], objective: 'swarm' }, 'swarm'],
      ['/v1/jobs/orchestration', { schemaVersion: 1, orchestratorAgentId: 'agent', agentIds: ['worker'], objective: 'orchestrate' }, 'orchestration'],
    ] as const;

    for (const [url, payload, kind] of submissions) {
      const submitted = await app.inject({ method: 'POST', url, headers: auth(), payload });
      expect(submitted.statusCode).toBe(202);
      const { jobId } = submitted.json<{ jobId: string }>();
      const polled = await app.inject({ method: 'GET', url: `/v1/jobs/${jobId}`, headers: auth() });
      expect(polled.statusCode).toBe(200);
      expect(polled.json()).toMatchObject({ id: jobId, kind, ownerUserId: 'alice' });
    }
  });

  it('preserves typed requests, results, and errors while polling', async () => {
    const { app, sdk, store } = await fixture();
    const succeeded = await sdk.submitRun(actor, { schemaVersion: 1, agentId: 'agent', goal: 'nested result', input: { count: 2 } });
    store.jobRows.set(succeeded.id, { ...succeeded, state: 'succeeded', result: { schemaVersion: 1, value: { answer: ['a', 2] }, completedAt: now } });
    const success = await app.inject({ method: 'GET', url: `/v1/jobs/${succeeded.id}`, headers: auth() });
    expect(success.json()).toMatchObject({ request: { goal: 'nested result', input: { count: 2 } }, result: { schemaVersion: 1, value: { answer: ['a', 2] } } });

    const failed = await sdk.submitRun(actor, { schemaVersion: 1, agentId: 'agent', goal: 'failure' });
    store.jobRows.set(failed.id, { ...failed, state: 'failed', error: { schemaVersion: 1, code: 'run_failed', message: 'Agent execution failed.', retryable: true } });
    const failure = await app.inject({ method: 'GET', url: `/v1/jobs/${failed.id}`, headers: auth() });
    expect(failure.json()).toMatchObject({ error: { schemaVersion: 1, code: 'run_failed', message: 'Agent execution failed.', retryable: true } });
  });

  it('forwards idempotency keys across client retries', async () => {
    const { app, store } = await fixture();
    const request = { method: 'POST' as const, url: '/v1/jobs/run', headers: auth('alice', { 'idempotency-key': 'same-request' }), payload: { schemaVersion: 1, agentId: 'agent', goal: 'run' } };
    const first = await app.inject(request);
    const second = await app.inject(request);

    expect(second.json()).toEqual(first.json());
    expect(store.jobRows.size).toBe(1);
    expect(store.outboxRows).toHaveLength(1);
  });

  it('authenticates every v1 route and does not enumerate another user job', async () => {
    const { app, sdk } = await fixture();
    const job = await sdk.submitRun(actor, { schemaVersion: 1, agentId: 'agent', goal: 'private' });

    expect((await app.inject({ method: 'GET', url: `/v1/jobs/${job.id}` })).statusCode).toBe(401);
    const read = await app.inject({ method: 'GET', url: `/v1/jobs/${job.id}`, headers: auth('bob') });
    const control = await app.inject({ method: 'POST', url: `/v1/jobs/${job.id}/cancel`, headers: auth('bob'), payload: {} });
    expect(read.statusCode).toBe(404);
    expect(control.statusCode).toBe(404);
    expect(read.json()).toEqual(publicError('not_found', 'Resource not found.', false));
  });

  it('rejects attempts to supply server-owned execution configuration', async () => {
    const { app, store } = await fixture();
    for (const override of [{ model: 'unsafe' }, { tools: ['shell'] }, { configPath: '/tmp/agent.json' }, { workspace: '/tmp' }]) {
      const response = await app.inject({ method: 'POST', url: '/v1/jobs/run', headers: auth(), payload: { schemaVersion: 1, agentId: 'agent', goal: 'run', ...override } });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual(publicError('invalid_request', 'Invalid request.', false));
    }
    expect(store.jobRows.size).toBe(0);
  });

  it('maps all control, event, and artifact operations', async () => {
    const { app, sdk, store } = await fixture();
    const cases = [
      ['cancel', 'running', {}],
      ['retry', 'failed', {}],
      ['recover', 'failed', {}],
      ['resume', 'failed', {}],
      ['continue', 'succeeded', {}],
      ['steer', 'running', { guidance: 'focus' }],
      ['approval', 'waiting_approval', { approved: true }],
      ['clarification', 'waiting_clarification', { answer: 'details' }],
    ] as const;

    for (const [route, state, payload] of cases) {
      const job = await sdk.submitRun(actor, { schemaVersion: 1, agentId: 'agent', goal: route });
      store.jobRows.set(job.id, { ...job, state });
      const response = await app.inject({ method: 'POST', url: `/v1/jobs/${job.id}/${route}`, headers: auth(), payload });
      expect(response.statusCode, route).toBe(200);
    }

    const job = await sdk.submitRun(actor, { schemaVersion: 1, agentId: 'agent', goal: 'lists' });
    store.eventRows.push({ schemaVersion: 1, id: uuid(900), jobId: job.id, sequence: 2, type: 'job.progress', data: { step: 2 }, occurredAt: now });
    store.artifactRows.push({ schemaVersion: 1, id: uuid(901), tenantId: actor.tenantId, ownerUserId: actor.userId, jobId: job.id, filename: 'result.txt', mediaType: 'text/plain', byteSize: 4, contentHash: 'hash', status: 'available', createdAt: now });
    const events = await app.inject({ method: 'GET', url: `/v1/jobs/${job.id}/events?afterSequence=1&limit=10`, headers: auth() });
    const artifacts = await app.inject({ method: 'GET', url: `/v1/jobs/${job.id}/artifacts`, headers: auth() });
    expect(events.json()).toMatchObject([{ sequence: 2, type: 'job.progress' }]);
    expect(artifacts.json()).toMatchObject([{ filename: 'result.txt', status: 'available' }]);
  });

  it('reports liveness and failed readiness without authentication', async () => {
    const { app } = await fixture({ ready: async () => false });
    expect((await app.inject({ method: 'GET', url: '/health/live' })).json()).toEqual({ status: 'ok' });
    const readiness = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toEqual(publicError('not_ready', 'Service is not ready.', true));
  });

  it('preserves sanitized framework status codes for parsing, payload, and rate limits', async () => {
    const malformedFixture = await fixture();
    const malformed = await malformedFixture.app.inject({ method: 'POST', url: '/v1/jobs/run', headers: { ...auth(), 'content-type': 'application/json' }, payload: '{' });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual(publicError('invalid_request', 'Invalid request.', false));

    const payloadFixture = await fixture({ bodyLimit: 100 });
    const oversized = await payloadFixture.app.inject({ method: 'POST', url: '/v1/jobs/run', headers: auth(), payload: { schemaVersion: 1, agentId: 'agent', goal: 'x'.repeat(200) } });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toEqual(publicError('payload_too_large', 'Request payload is too large.', false));

    const rateFixture = await fixture({ rateLimit: 1 });
    await rateFixture.app.inject({ method: 'GET', url: '/v1/jobs/unknown', headers: auth() });
    const limited = await rateFixture.app.inject({ method: 'GET', url: '/v1/jobs/unknown', headers: auth() });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual(publicError('rate_limited', 'Rate limit exceeded.', true));
  });

  it('sanitizes unexpected backend errors', async () => {
    const { app } = await fixture({ registryError: new Error('postgres://user:secret@private/provider-token') });
    const response = await app.inject({ method: 'POST', url: '/v1/jobs/run', headers: auth(), payload: { schemaVersion: 1, agentId: 'agent', goal: 'run' } });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('secret');
    expect(response.body).not.toContain('provider-token');
    expect(response.json()).toEqual(publicError('internal_error', 'Internal server error.', true));
  });
});

describe('JWT authentication', () => {
  it('derives actor identity only from verified issuer, audience, and claims', async () => {
    const secret = 'a-test-secret-that-is-long-enough-for-hs256';
    const authenticate = createJwtAuthenticator({ issuer: 'https://issuer.example', audience: 'adaptive-agent', hmacSecret: secret });
    const { app } = await fixture({ authenticate });
    const token = await new SignJWT({ tenant_id: 'tenant-1' }).setProtectedHeader({ alg: 'HS256' }).setIssuer('https://issuer.example').setAudience('adaptive-agent').setSubject('alice').setExpirationTime('5m').sign(new TextEncoder().encode(secret));
    const accepted = await app.inject({ method: 'POST', url: '/v1/jobs/run', headers: { authorization: `Bearer ${token}` }, payload: { schemaVersion: 1, agentId: 'agent', goal: 'run' } });
    expect(accepted.statusCode).toBe(202);

    const wrongAudience = await new SignJWT({ tenant_id: 'tenant-1' }).setProtectedHeader({ alg: 'HS256' }).setIssuer('https://issuer.example').setAudience('other').setSubject('alice').setExpirationTime('5m').sign(new TextEncoder().encode(secret));
    expect((await app.inject({ method: 'GET', url: '/v1/jobs/unknown', headers: { authorization: `Bearer ${wrongAudience}` } })).statusCode).toBe(401);
    const noExpiration = await new SignJWT({ tenant_id: 'tenant-1' }).setProtectedHeader({ alg: 'HS256' }).setIssuer('https://issuer.example').setAudience('adaptive-agent').setSubject('alice').sign(new TextEncoder().encode(secret));
    expect((await app.inject({ method: 'GET', url: '/v1/jobs/unknown', headers: { authorization: `Bearer ${noExpiration}` } })).statusCode).toBe(401);
  });
});

const now = '2026-01-01T00:00:00.000Z';

async function fixture(options: { ready?: () => Promise<boolean>; registryError?: Error; authenticate?: (request: Parameters<ReturnType<typeof createJwtAuthenticator>>[0]) => Promise<ServiceActor>; bodyLimit?: number; rateLimit?: number } = {}) {
  const store = new InMemoryServiceStore();
  let nextId = 0;
  const registry: AgentRegistry = {
    async resolve(agentId, workload) {
      if (options.registryError) throw options.registryError;
      return { profile: { agentId, version: '1', contentHash: `hash-${agentId}` }, allowedWorkloads: [workload] };
    },
  };
  const sdk = new ServiceSdk({
    persistence: store,
    artifacts: new InMemoryArtifactStore(store),
    registry,
    authorization: { async authorize() { return true; } },
    clock: { now: () => new Date(now) },
    ids: { generate: () => uuid(++nextId) },
  });
  const authenticate = options.authenticate ?? (async (request) => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) throw new Error('unauthorized');
    return { tenantId: 'tenant-1', userId: authorization.slice(7) };
  });
  const app = await buildHttpServer({ sdk, authenticate, ready: options.ready, logger: false, bodyLimit: options.bodyLimit, rateLimit: options.rateLimit ?? 10_000 });
  apps.push(app);
  return { app, sdk, store };
}

function auth(user = 'alice', extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${user}`, ...extra };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

function publicError(code: string, message: string, retryable: boolean) {
  return { error: { schemaVersion: 1, code, message, retryable } };
}
