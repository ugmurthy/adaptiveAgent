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
import { buildHttpServer, type ArtifactDownloader } from './http-server.js';
import { InMemoryEventBus } from './event-bus.js';

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

  it('lists safe agents and protects platform admin routes', async () => {
    const authenticate = async (request: Parameters<ReturnType<typeof createJwtAuthenticator>>[0]): Promise<ServiceActor> => {
      const name = request.headers.authorization?.slice(7) ?? '';
      return name === 'admin'
        ? { tenantId: 'operations', userId: 'root', roles: ['platform_admin'] }
        : { tenantId: 'tenant-1', userId: name };
    };
    const { app, sdk, store } = await fixture({
      authenticate,
      catalog: { list: () => [{ id: 'agent', version: '1', allowedWorkloads: ['run'] }] },
    });
    const job = await sdk.submitRun(actor, { schemaVersion: 1, agentId: 'agent', goal: 'admin view' });
    store.jobRows.set(job.id, { ...job, state: 'running' });

    const catalog = await app.inject({ method: 'GET', url: '/v1/agents', headers: auth() });
    expect(catalog.json()).toEqual({ items: [{ id: 'agent', version: '1', allowedWorkloads: ['run'] }] });
    expect(catalog.body).not.toContain('configPath');
    expect(catalog.body).not.toContain('contentHash');
    expect((await app.inject({ method: 'GET', url: '/v1/admin/jobs', headers: auth() })).statusCode).toBe(403);

    const listed = await app.inject({ method: 'GET', url: '/v1/admin/jobs?tenantId=tenant-1', headers: auth('admin') });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ total: 1, limit: 50, offset: 0, items: [{ id: job.id, ownerUserId: 'alice' }] });
    const cancelled = await app.inject({ method: 'POST', url: `/v1/admin/jobs/${job.id}/cancel`, headers: auth('admin', { 'idempotency-key': 'admin-cancel' }), payload: {} });
    expect(cancelled.statusCode).toBe(200);
    expect(store.auditRows).toContainEqual(expect.objectContaining({ userId: 'root', jobId: job.id, action: 'admin:cancel' }));
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

  it('proxies private downloads with safe attachment headers and authoritative actor identity',async()=>{
    let received:unknown;
    const artifactDownloader:ArtifactDownloader={download:async(inputActor,jobId,artifactId)=>{
      received={inputActor,jobId,artifactId};
      return {metadata:{filename:'private report.txt',mediaType:'text/plain',byteSize:6},data:new TextEncoder().encode('secret')};
    }};
    const {app,sdk}=await fixture({artifactDownloader});
    const job=await sdk.submitRun(actor,{schemaVersion:1,agentId:'agent',goal:'artifact'});
    const response=await app.inject({method:'GET',url:`/v1/jobs/${job.id}/artifacts/artifact-1/download`,headers:auth()});
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('secret');
    expect(response.headers['content-disposition']).toContain('attachment; filename="private_report.txt"');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(received).toEqual({inputActor:actor,jobId:job.id,artifactId:'artifact-1'});
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

  it('maps a configured admin role and accepts browser WebSocket subprotocol credentials only on the WS route', async () => {
    const secret = 'a-test-secret-that-is-long-enough-for-hs256';
    const authenticate = createJwtAuthenticator({ issuer: 'https://issuer.example', audience: 'adaptive-agent', hmacSecret: secret, adminRole: 'service-admin' });
    const { app } = await fixture({ authenticate });
    const token = await new SignJWT({ tenant_id: 'tenant-1', roles: ['service-admin'] }).setProtectedHeader({ alg: 'HS256' }).setIssuer('https://issuer.example').setAudience('adaptive-agent').setSubject('alice').setExpirationTime('5m').sign(new TextEncoder().encode(secret));

    const admin = await app.inject({ method: 'GET', url: '/v1/admin/overview', headers: { authorization: `Bearer ${token}` } });
    expect(admin.statusCode).toBe(200);
    const rejectedHttp = await app.inject({ method: 'GET', url: '/v1/agents', headers: { 'sec-websocket-protocol': `adaptive-agent, bearer.${token}` } });
    expect(rejectedHttp.statusCode).toBe(401);
    const ws = await app.injectWS('/v1/ws', { headers: { 'sec-websocket-protocol': `adaptive-agent, bearer.${token}` } });
    expect(ws.readyState).toBe(ws.OPEN);
    ws.terminate();
  });
});

describe('Phase 5 WebSocket API', () => {
  it('replays from a cursor, receives live wakeups, and rejects cross-user subscriptions', async () => {
    const { app, sdk, store, eventBus } = await fixture();
    const job=await sdk.submitRun(actor,{schemaVersion:1,agentId:'agent',goal:'events'});
    store.eventRows.push(
      {schemaVersion:1,id:uuid(910),jobId:job.id,sequence:1,type:'run.created',data:{},occurredAt:now},
      {schemaVersion:1,id:uuid(911),jobId:job.id,sequence:2,type:'step.started',data:{stepId:'one'},occurredAt:now},
    );
    const ws=await app.injectWS('/v1/ws',{headers:auth()});
    const replay=receiveMessages(ws,2);
    ws.send(JSON.stringify({operation:'subscribe',requestId:'sub-1',jobId:job.id,afterSequence:1}));
    expect(await replay).toMatchObject([
      {type:'response',requestId:'sub-1',data:{subscribed:true}},
      {type:'event',event:{sequence:2,type:'step.started'}},
    ]);

    store.eventRows.push({schemaVersion:1,id:uuid(912),jobId:job.id,sequence:3,type:'step.completed',data:{stepId:'one'},occurredAt:now});
    const live=receiveMessages(ws,1);await eventBus.publish({jobId:job.id,sequence:3});
    expect(await live).toMatchObject([{type:'event',event:{sequence:3,type:'step.completed'}}]);
    ws.terminate();

    const other=await app.injectWS('/v1/ws',{headers:auth('bob')});
    const denied=receiveMessages(other,1);
    other.send(JSON.stringify({operation:'subscribe',requestId:'private',jobId:job.id,afterSequence:0}));
    expect(await denied).toMatchObject([{type:'error',requestId:'private',error:{code:'not_found'}}]);
    other.terminate();
  });

  it('uses the shared submission path and rejects server-owned overrides',async()=>{
    const {app,store}=await fixture();const ws=await app.injectWS('/v1/ws',{headers:auth()});
    const invalid=receiveMessages(ws,1);ws.send(JSON.stringify({operation:'submit',requestId:'bad',kind:'run',request:{schemaVersion:1,agentId:'agent',goal:'run',model:'unsafe'}}));
    expect(await invalid).toMatchObject([{type:'error',requestId:'bad',error:{code:'invalid_request'}}]);expect(store.jobRows.size).toBe(0);
    const accepted=receiveMessages(ws,1);ws.send(JSON.stringify({operation:'submit',requestId:'good',kind:'run',request:{schemaVersion:1,agentId:'agent',goal:'run'}}));
    expect(await accepted).toMatchObject([{type:'response',requestId:'good',data:{schemaVersion:1}}]);expect(store.jobRows.size).toBe(1);ws.terminate();
  });
});

const now = '2026-01-01T00:00:00.000Z';

async function fixture(options: { ready?: () => Promise<boolean>; registryError?: Error; authenticate?: (request: Parameters<ReturnType<typeof createJwtAuthenticator>>[0]) => Promise<ServiceActor>; catalog?:{list():Array<{id:string;version:string;allowedWorkloads:readonly string[]}>}; artifactDownloader?:ArtifactDownloader; bodyLimit?: number; rateLimit?: number } = {}) {
  const store = new InMemoryServiceStore();
  const eventBus=new InMemoryEventBus();
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
  const app = await buildHttpServer({ sdk, authenticate, catalog:options.catalog, artifacts:options.artifactDownloader, eventBus, ready: options.ready, logger: false, bodyLimit: options.bodyLimit, rateLimit: options.rateLimit ?? 10_000 });
  await app.ready();
  apps.push(app);
  return { app, sdk, store, eventBus };
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

function receiveMessages(socket:{once(event:'message',listener:(data:unknown)=>void):unknown},count:number):Promise<any[]> {
  return new Promise((resolve,reject)=>{const messages:any[]=[];const read=()=>socket.once('message',data=>{try{messages.push(JSON.parse(String(data)));if(messages.length===count)resolve(messages);else read();}catch(error){reject(error);}});read();setTimeout(()=>reject(new Error('Timed out waiting for WebSocket messages')),2000).unref();});
}
