import { PostgresArtifactMetadataStore, PostgresServiceStore, ServiceSdk, type AgentRegistry, type ServiceActor } from '@adaptive-agent/service-sdk';
import { AllowlistedAgentRegistry } from './registry.js';
import { createArtifactManagerFromEnv, createPoolFromEnv, positiveInt, runBackendMigrations } from './composition.js';
import { createJwtAuthenticator } from './http-auth.js';
import { buildHttpServer } from './http-server.js';
import { RedisEventBus } from './event-bus.js';

async function main(): Promise<void> {
  const env=process.env;
  if (!env.AGENT_REGISTRY_PATH) throw new Error('AGENT_REGISTRY_PATH is required');
  const pool=createPoolFromEnv(env);
  await runBackendMigrations(pool);
  const store=new PostgresServiceStore(pool);
  const registry=await AllowlistedAgentRegistry.load(env.AGENT_REGISTRY_PATH);
  const registryAdapter:AgentRegistry={resolve:async(id,kind)=>{try{const {entry}=await registry.resolve(id,kind);return {profile:{agentId:entry.id,version:entry.version,contentHash:entry.contentHash},allowedWorkloads:entry.allowedWorkloads};}catch{return undefined;}}};
  const artifactRuntime=createArtifactManagerFromEnv(pool,env);
  const artifacts=new PostgresArtifactMetadataStore(pool);
  const sdk=new ServiceSdk({persistence:store,registry:registryAdapter,artifacts,authorization:{authorize:async()=>true},clock:{now:()=>new Date()},ids:{generate:()=>crypto.randomUUID()}});
  const authenticate=createJwtAuthenticator({issuer:required(env.JWT_ISSUER,'JWT_ISSUER'),audience:required(env.JWT_AUDIENCE,'JWT_AUDIENCE'),jwksUrl:env.JWT_JWKS_URL,hmacSecret:env.JWT_HMAC_SECRET,tenantClaim:env.JWT_TENANT_CLAIM,roleClaim:env.JWT_ROLE_CLAIM,adminRole:env.JWT_ADMIN_ROLE});
  const eventBus=new RedisEventBus(required(env.REDIS_URL,'REDIS_URL'));
  const ensureActor=async(a:ServiceActor)=>{await pool.query('insert into service_tenants(id) values($1) on conflict do nothing',[a.tenantId]);await pool.query('insert into service_users(tenant_id,id) values($1,$2) on conflict do nothing',[a.tenantId,a.userId]);};
  const app=await buildHttpServer({sdk,authenticate,catalog:registry,artifacts:artifactRuntime.manager,eventBus,ensureActor,ready:async()=>{try{await pool.query('select 1');return true;}catch{return false;}},logger:{level:env.HTTP_LOG_LEVEL??'info'},rateLimit:positiveInt(env.HTTP_RATE_LIMIT,100)});
  const shutdown=async()=>{await app.close();await eventBus.close();artifactRuntime.storage.destroy();await pool.end();};
  process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
  await app.listen({host:env.HTTP_HOST??'0.0.0.0',port:positiveInt(env.PORT,3000)});
}
function required(value:string|undefined,name:string):string { if(!value)throw new Error(`${name} is required`);return value; }
if (import.meta.main) await main();
