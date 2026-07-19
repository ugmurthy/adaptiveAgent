import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { IdempotencyConflictError, InvalidJobStateError, ServiceNotFoundError, type ServiceActor, type ServiceSdk } from '@adaptive-agent/service-sdk';
import type { HttpAuthenticator } from './http-auth.js';
import type { EventBus } from './event-bus.js';
import { safeContentDisposition } from './artifacts.js';

export interface ArtifactDownloader { download(actor:ServiceActor,jobId:string,artifactId:string):Promise<{metadata:{filename:string;mediaType:string;byteSize:number};data:Uint8Array}> }
export interface HttpServerOptions { sdk: ServiceSdk; authenticate: HttpAuthenticator; artifacts?:ArtifactDownloader; eventBus?:EventBus; ready?: () => Promise<boolean>; ensureActor?: (actor: ServiceActor) => Promise<void>; logger?: boolean | object; bodyLimit?: number; rateLimit?: number; ws?:{maxConnections?:number;maxConnectionsPerUser?:number;maxMessageBytes?:number;maxBufferedBytes?:number;heartbeatMs?:number} }
const text = { type:'string', minLength:1, maxLength:10_000 } as const;
const id = { type:'string', minLength:1, maxLength:200 } as const;
const version = { type:'integer', const:1 } as const;
const empty = { type:'object', additionalProperties:false, properties:{} } as const;
const params = { type:'object', additionalProperties:false, required:['jobId'], properties:{ jobId:id } } as const;
const artifactParams = { type:'object', additionalProperties:false, required:['jobId','artifactId'], properties:{ jobId:id,artifactId:id } } as const;
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
  await app.register(websocket,{options:{maxPayload:options.ws?.maxMessageBytes??64*1024}});
  app.get('/', async () => ({service:'adaptive-agent',schemaVersion:1,docs:'/docs'}));
  app.get('/health/live', async () => ({status:'ok'}));
  app.get('/health/ready', async (_req, reply) => (await (options.ready?.() ?? true)) ? {status:'ready'} : reply.code(503).send(httpError('not_ready','Service is not ready.',true)));
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/v1/')) return;
    let verified:ServiceActor;
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
  app.get('/v1/jobs/:jobId/artifacts/:artifactId/download',{schema:{params:artifactParams,headers,response:{401:errorResponse,404:errorResponse,429:errorResponse,500:errorResponse},security:[{bearerAuth:[]}]}},async(r,reply)=>{
    if(!options.artifacts)throw new ServiceNotFoundError();
    const p=r.params as {jobId:string;artifactId:string};
    const downloaded=await options.artifacts.download(actor(r),p.jobId,p.artifactId);
    return reply.header('content-type',downloaded.metadata.mediaType)
      .header('content-disposition',safeContentDisposition(downloaded.metadata.filename))
      .header('content-length',String(downloaded.metadata.byteSize))
      .header('cache-control','private, no-store')
      .header('x-content-type-options','nosniff')
      .send(Buffer.from(downloaded.data));
  });
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
  installWebSocket(app,options,actor);
  return app;
}

function httpError(code:string,message:string,retryable:boolean) { return {error:{schemaVersion:1 as const,code,message,retryable}}; }

function installWebSocket(app:FastifyInstance,options:HttpServerOptions,getActor:(r:FastifyRequest)=>ServiceActor) {
  let total=0;const perUser=new Map<string,number>();const config={maxConnections:1000,maxConnectionsPerUser:10,maxMessageBytes:64*1024,maxBufferedBytes:1024*1024,heartbeatMs:30_000,...options.ws};
  app.get('/v1/ws',{websocket:true},(socket,request)=>{
    const actor=getActor(request);const key=`${actor.tenantId}:${actor.userId}`,old=perUser.get(key)??0;
    if(total>=config.maxConnections||old>=config.maxConnectionsPerUser){socket.close(1013,'Connection limit');return;}total++;perUser.set(key,old+1);
    const cursors=new Map<string,number>(),draining=new Set<string>(),pending=new Set<string>();let alive=true,closed=false,unsubscribe:undefined|(()=>Promise<void>);
    const send=(value:unknown)=>{if(socket.bufferedAmount>config.maxBufferedBytes){socket.close(1013,'Slow client');return false;}socket.send(JSON.stringify(value));return true;};
    const drain=async(jobId:string)=>{if(draining.has(jobId)){pending.add(jobId);return;}draining.add(jobId);try{do{pending.delete(jobId);let after=cursors.get(jobId);if(after===undefined)return;for(;;){const events=await options.sdk.listEvents(actor,jobId,after,200);for(const event of events){if(!send({type:'event',event}))return;after=event.sequence;cursors.set(jobId,after);}if(events.length<200)break;}const job=await options.sdk.getJob(actor,jobId);if(['succeeded','failed','cancelled'].includes(job.state))send({type:'job',job});}while(pending.has(jobId));}catch{send({type:'error',error:publicWsError('not_found')});cursors.delete(jobId);}finally{draining.delete(jobId);}};
    const busReady=options.eventBus?.subscribe(w=>{if(cursors.has(w.jobId))void drain(w.jobId);}).then(value=>{unsubscribe=value;}).catch(()=>{})??Promise.resolve();
    socket.on('pong',()=>{alive=true;});const heartbeat=setInterval(()=>{if(!alive){socket.terminate();return;}alive=false;socket.ping();},config.heartbeatMs);
    socket.on('message',async raw=>{let message:any;let requestId:unknown;try{if(Buffer.byteLength(raw as any)>config.maxMessageBytes)throw new Error();message=JSON.parse(raw.toString());requestId=message.requestId;if(!message||typeof message.operation!=='string'||(requestId!==undefined&&typeof requestId!=='string'))throw new Error();const done=(data:unknown)=>send({type:'response',requestId,data});const idem=typeof message.idempotencyKey==='string'?{idempotencyKey:message.idempotencyKey}:undefined;
        switch(message.operation){case'submit':{const r=validateWsSubmission(message.kind,message.request);const job=message.kind==='run'?await options.sdk.submitRun(actor,r as any,idem):message.kind==='chat'?await options.sdk.submitChat(actor,r as any,idem):message.kind==='swarm'?await options.sdk.submitSwarmRun(actor,r as any,idem):await options.sdk.submitOrchestratedRun(actor,r as any,idem);done({schemaVersion:1,jobId:job.id});break;}case'subscribe':if(typeof message.jobId!=='string'||!Number.isSafeInteger(message.afterSequence??0)||(message.afterSequence??0)<0)throw new Error();await busReady;await options.sdk.getJob(actor,message.jobId);cursors.set(message.jobId,message.afterSequence??0);done({jobId:message.jobId,subscribed:true});await drain(message.jobId);break;case'unsubscribe':if(typeof message.jobId!=='string')throw new Error();cursors.delete(message.jobId);done({jobId:message.jobId,subscribed:false});break;case'cancel':done(await options.sdk.cancelJob(actor,requiredString(message.jobId),idem));break;case'steer':done(await options.sdk.steerJob(actor,requiredString(message.jobId),requiredString(message.guidance),idem));break;case'approve':if(typeof message.approved!=='boolean')throw new Error();done(await options.sdk.resolveApproval(actor,requiredString(message.jobId),message.approved,idem));break;case'clarify':done(await options.sdk.resolveClarification(actor,requiredString(message.jobId),requiredString(message.answer),idem));break;default:throw new Error();}}
      catch(error){const code=error instanceof ServiceNotFoundError?'not_found':error instanceof InvalidJobStateError||error instanceof IdempotencyConflictError?'conflict':'invalid_request';send({type:'error',requestId,error:publicWsError(code)});}});
    socket.on('close',()=>{if(closed)return;closed=true;clearInterval(heartbeat);void unsubscribe?.();total--;const count=(perUser.get(key)??1)-1;if(count)perUser.set(key,count);else perUser.delete(key);cursors.clear();pending.clear();});
  });
}
function requiredString(value:unknown):string {if(typeof value!=='string'||!value||value.length>10_000)throw new Error();return value;}
function publicWsError(code:string){return {schemaVersion:1,code,message:code==='not_found'?'Resource not found.':code==='conflict'?'Request conflicts with current state.':'Invalid request.',retryable:false};}
function validateWsSubmission(kind:unknown,value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||!['run','chat','swarm','orchestration'].includes(String(kind)))throw new Error();
  const body=value as Record<string,unknown>;
  const allowed=kind==='run'?['schemaVersion','agentId','goal','input']:kind==='chat'?['schemaVersion','agentId','message','conversationId']:kind==='swarm'?['schemaVersion','coordinatorAgentId','workerAgentIds','objective']:['schemaVersion','orchestratorAgentId','agentIds','objective'];
  if(Object.keys(body).some(key=>!allowed.includes(key))||body.schemaVersion!==1)throw new Error();
  const strings=kind==='run'?['agentId','goal']:kind==='chat'?['agentId','message']:kind==='swarm'?['coordinatorAgentId','objective']:['orchestratorAgentId','objective'];
  for(const key of strings)requiredString(body[key]);
  if(kind==='chat'&&body.conversationId!==undefined)requiredString(body.conversationId);
  if(kind==='swarm')requiredStringArray(body.workerAgentIds);if(kind==='orchestration')requiredStringArray(body.agentIds);
  return body;
}
function requiredStringArray(value:unknown):void {if(!Array.isArray(value)||value.length<1||value.length>100||new Set(value).size!==value.length)throw new Error();for(const item of value)requiredString(item);}
