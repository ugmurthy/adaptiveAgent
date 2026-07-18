import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import rateLimit from '@fastify/rate-limit';
import { IdempotencyConflictError, InvalidJobStateError, ServiceNotFoundError, type ServiceActor, type ServiceSdk } from '@adaptive-agent/service-sdk';
import type { HttpAuthenticator } from './http-auth.js';

export interface HttpServerOptions { sdk: ServiceSdk; authenticate: HttpAuthenticator; ready?: () => Promise<boolean>; ensureActor?: (actor: ServiceActor) => Promise<void>; logger?: boolean | object; bodyLimit?: number; rateLimit?: number }
const text = { type:'string', minLength:1, maxLength:10_000 } as const;
const id = { type:'string', minLength:1, maxLength:200 } as const;
const version = { type:'integer', const:1 } as const;
const empty = { type:'object', additionalProperties:false, properties:{} } as const;
const params = { type:'object', additionalProperties:false, required:['jobId'], properties:{ jobId:id } } as const;
const headers = { type:'object', properties:{ authorization:{type:'string',minLength:8,maxLength:16_384}, 'idempotency-key':{type:'string',minLength:1,maxLength:200} } } as const;
const run = { type:'object', additionalProperties:false, required:['schemaVersion','agentId','goal'], properties:{schemaVersion:version,agentId:id,goal:text,input:{}} } as const;
const chat = { type:'object', additionalProperties:false, required:['schemaVersion','agentId','message'], properties:{schemaVersion:version,agentId:id,message:text,conversationId:id} } as const;
const swarm = { type:'object', additionalProperties:false, required:['schemaVersion','coordinatorAgentId','workerAgentIds','objective'], properties:{schemaVersion:version,coordinatorAgentId:id,workerAgentIds:{type:'array',minItems:1,maxItems:100,uniqueItems:true,items:id},objective:text} } as const;
const orchestration = { type:'object', additionalProperties:false, required:['schemaVersion','orchestratorAgentId','agentIds','objective'], properties:{schemaVersion:version,orchestratorAgentId:id,agentIds:{type:'array',minItems:1,maxItems:100,uniqueItems:true,items:id},objective:text} } as const;
const accepted = { type:'object', additionalProperties:false, required:['schemaVersion','jobId'], properties:{schemaVersion:version,jobId:id} } as const;
const profile = { type:'object', additionalProperties:false, required:['agentId','version','contentHash'], properties:{agentId:id,version:id,contentHash:id} } as const;
const command = { type:'object', additionalProperties:false, required:['kind','version','requestedAt'], properties:{kind:{type:'string',enum:['execute','cancel','retry','recover','resume','continue','steer','resolve_approval','resolve_clarification']},version:{type:'integer',minimum:1},payload:{},requestedAt:{type:'string',format:'date-time'}} } as const;
const serviceResult = { type:'object', additionalProperties:false, required:['schemaVersion','value','completedAt'], properties:{schemaVersion:version,value:{},completedAt:{type:'string',format:'date-time'}} } as const;
const serviceError = { type:'object', additionalProperties:false, required:['schemaVersion','code','message','retryable'], properties:{schemaVersion:version,code:id,message:text,retryable:{type:'boolean'}} } as const;
const job = { type:'object', additionalProperties:false, required:['schemaVersion','id','tenantId','ownerUserId','kind','state','sessionId','request','profiles','commandVersion','processedCommandVersion','pendingCommand','createdAt','updatedAt'], properties:{schemaVersion:version,id,tenantId:id,ownerUserId:id,kind:{type:'string',enum:['run','chat','swarm','orchestration']},state:{type:'string',enum:['accepted','queued','running','waiting_approval','waiting_clarification','cancelling','succeeded','failed','cancelled']},sessionId:id,coordinatorRunId:id,request:{oneOf:[run,chat,swarm,orchestration]},profiles:{type:'array',items:profile},commandVersion:{type:'integer',minimum:1},processedCommandVersion:{type:'integer',minimum:0},pendingCommand:command,result:serviceResult,error:serviceError,createdAt:{type:'string',format:'date-time'},updatedAt:{type:'string',format:'date-time'}} } as const;
const publicEvent = { type:'object', additionalProperties:false, required:['schemaVersion','id','jobId','sequence','type','data','occurredAt'], properties:{schemaVersion:version,id,jobId:id,sequence:{type:'integer',minimum:1},type:id,data:{},occurredAt:{type:'string',format:'date-time'}} } as const;
const artifact = { type:'object', additionalProperties:false, required:['schemaVersion','id','tenantId','ownerUserId','jobId','filename','mediaType','byteSize','contentHash','status','createdAt'], properties:{schemaVersion:version,id,tenantId:id,ownerUserId:id,jobId:id,runId:id,toolExecutionId:id,filename:id,mediaType:id,byteSize:{type:'integer',minimum:0},contentHash:id,status:{type:'string',enum:['uploading','scanning','available','quarantined','deleted']},createdAt:{type:'string',format:'date-time'},availableAt:{type:'string',format:'date-time'},expiresAt:{type:'string',format:'date-time'},deletedAt:{type:'string',format:'date-time'}} } as const;
const errorResponse = { type:'object', additionalProperties:false, required:['error'], properties:{error:serviceError} } as const;
const errors = { 400:errorResponse,401:errorResponse,404:errorResponse,409:errorResponse,413:errorResponse,415:errorResponse,429:errorResponse,500:errorResponse } as const;

export async function buildHttpServer(options: HttpServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: options.bodyLimit ?? 1024*1024, requestIdHeader:'x-request-id', ajv:{customOptions:{removeAdditional:false}} });
  const actors = new WeakMap<FastifyRequest,ServiceActor>();
  await app.register(swagger, { openapi:{ info:{title:'Adaptive Agent Service',version:'1.0.0'}, components:{securitySchemes:{bearerAuth:{type:'http',scheme:'bearer',bearerFormat:'JWT'}}} } });
  await app.register(swaggerUi, { routePrefix:'/docs' });
  await app.register(rateLimit, { global:true, max:options.rateLimit ?? 100, timeWindow:'1 minute', allowList:(request)=>request.url.startsWith('/health/') });
  app.get('/', async () => ({service:'adaptive-agent',schemaVersion:1,docs:'/docs'}));
  app.get('/health/live', async () => ({status:'ok'}));
  app.get('/health/ready', async (_req, reply) => (await (options.ready?.() ?? true)) ? {status:'ready'} : reply.code(503).send(httpError('not_ready','Service is not ready.',true)));
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/v1/')) return;
    let verified: ServiceActor;
    try { verified=await options.authenticate(request); }
    catch { return reply.code(401).send(httpError('unauthorized','Unauthorized.',false)); }
    await options.ensureActor?.(verified);
    actors.set(request,verified);
  });
  const actor=(r:FastifyRequest)=>actors.get(r)!;
  const idem=(r:FastifyRequest)=>({idempotencyKey:r.headers['idempotency-key'] as string|undefined});
  const submissionResponse=(job:{id:string})=>({schemaVersion:1,jobId:job.id});
  const submit = (path:string, body:object, invoke:(a:ServiceActor,b:any,o:any)=>Promise<any>) => app.post(path,{schema:{body,headers,response:{202:accepted,...errors},security:[{bearerAuth:[]}]}},async(r,reply)=>reply.code(202).send(submissionResponse(await invoke(actor(r),r.body,idem(r)))));
  submit('/v1/jobs/run',run,(a,b,o)=>options.sdk.submitRun(a,b,o));
  submit('/v1/jobs/chat',chat,(a,b,o)=>options.sdk.submitChat(a,b,o));
  submit('/v1/jobs/swarm',swarm,(a,b,o)=>options.sdk.submitSwarmRun(a,b,o));
  submit('/v1/jobs/orchestration',orchestration,(a,b,o)=>options.sdk.submitOrchestratedRun(a,b,o));
  app.get('/v1/jobs/:jobId',{schema:{params,headers,response:{200:job,...errors},security:[{bearerAuth:[]}]}},r=>options.sdk.getJob(actor(r),(r.params as any).jobId));
  const controls: Record<string,(a:ServiceActor,j:string,b:any,o:any)=>Promise<any>> = {
    cancel:(a,j,_b,o)=>options.sdk.cancelJob(a,j,o), retry:(a,j,_b,o)=>options.sdk.retryJob(a,j,o), recover:(a,j,_b,o)=>options.sdk.recoverJob(a,j,o), resume:(a,j,_b,o)=>options.sdk.resumeJob(a,j,o), continue:(a,j,_b,o)=>options.sdk.continueJob(a,j,o),
    steer:(a,j,b,o)=>options.sdk.steerJob(a,j,b.guidance,o), approval:(a,j,b,o)=>options.sdk.resolveApproval(a,j,b.approved,o), clarification:(a,j,b,o)=>options.sdk.resolveClarification(a,j,b.answer,o),
  };
  for (const [name,invoke] of Object.entries(controls)) {
    const body = name==='steer'?{type:'object',additionalProperties:false,required:['guidance'],properties:{guidance:text}}:name==='approval'?{type:'object',additionalProperties:false,required:['approved'],properties:{approved:{type:'boolean'}}}:name==='clarification'?{type:'object',additionalProperties:false,required:['answer'],properties:{answer:text}}:empty;
    app.post(`/v1/jobs/:jobId/${name}`,{schema:{params,headers,body,response:{200:job,...errors},security:[{bearerAuth:[]}]}},r=>invoke(actor(r),(r.params as any).jobId,r.body,idem(r)));
  }
  app.get('/v1/jobs/:jobId/events',{schema:{params,headers,querystring:{type:'object',additionalProperties:false,properties:{afterSequence:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER,default:0},limit:{type:'integer',minimum:1,maximum:500,default:100}}},response:{200:{type:'array',items:publicEvent},...errors},security:[{bearerAuth:[]}]}},r=>{const q=r.query as any;return options.sdk.listEvents(actor(r),(r.params as any).jobId,q.afterSequence,q.limit)});
  app.get('/v1/jobs/:jobId/artifacts',{schema:{params,headers,querystring:empty,response:{200:{type:'array',items:artifact},...errors},security:[{bearerAuth:[]}]}},r=>options.sdk.listArtifacts(actor(r),(r.params as any).jobId));
  app.setErrorHandler((error,request,reply)=>{
    if ((error as any).validation) return reply.code(400).send(httpError('invalid_request','Invalid request.',false));
    if(error instanceof ServiceNotFoundError)return reply.code(404).send(httpError('not_found','Resource not found.',false));
    if(error instanceof IdempotencyConflictError||error instanceof InvalidJobStateError)return reply.code(409).send(httpError('conflict','Request conflicts with current state.',false));
    const status=(error as {statusCode?:number}).statusCode;
    if(status===400||status===415)return reply.code(status).send(httpError('invalid_request','Invalid request.',false));
    if(status===413)return reply.code(413).send(httpError('payload_too_large','Request payload is too large.',false));
    if(status===429)return reply.code(429).send(httpError('rate_limited','Rate limit exceeded.',true));
    request.log.error({errorType:error instanceof Error?error.name:'UnknownError',requestId:request.id},'request failed');
    return reply.code(500).send(httpError('internal_error','Internal server error.',true));
  });
  return app;
}

function httpError(code:string,message:string,retryable:boolean) { return {error:{schemaVersion:1 as const,code,message,retryable}}; }
