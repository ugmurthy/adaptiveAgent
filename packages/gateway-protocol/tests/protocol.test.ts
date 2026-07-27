import { describe, expect, it } from 'vitest';
import {
  type GatewayRequestMethod,
  INFERENCE_TIERS, PROTOCOL_LIMITS, PROTOCOL_VERSION, PUBLIC_GATEWAY_ERROR_CODES,
  StreamSequenceValidator, validateDeclarativeProfileBundle, validateModelStreamEnvelope,
  validateModelStreamNotification, validatePublicGatewayError, validateRpcRequest,
  validateRpcResponse,
} from '../src/index.js';

const request = (method: string, params: unknown) => ({ jsonrpc: '2.0', id: 1, method, params });
const invocation = { runId:'r',rootRunId:'rr',stepId:'s',purpose:'agent_turn',callId:'c',attempt:1 };
const profileRef = { source:'server',id:'p',version:'1',contentHash:'abc' };
const usage = { provider:'provider',model:'model',inputTokens:1,outputTokens:2,totalTokens:3 };

const validRequests: Array<[GatewayRequestMethod, Record<string, unknown>]> = [
  ['initialize',{protocolVersion:PROTOCOL_VERSION,clientName:'cli',clientVersion:'1'}],
  ['profile/list',{}],
  ['profile/get',{ref:profileRef}],
  ['run/authorize',{runId:'r',inferenceMode:'gateway',requestedTier:'high',profileRefs:[]}],
  ['model/generate',{permitId:'permit',tier:'high',invocation,messages:[{role:'user',content:'hi'}]}],
  ['tool/execute',{permitId:'permit',idempotencyKey:'key',toolName:'web_search',input:{query:'q'}}],
  ['request/cancel',{callId:'c'}],
  ['account/usage',{from:'2026-01-01',to:'2026-02-01'}],
];

describe('request validation', () => {
  it('accepts success fixtures for every method', () => {
    validRequests.forEach(([method, params]) => {
      const fixture = request(method, params);
      expect(validateRpcRequest(fixture)).toBe(fixture);
    });
  });
  it.each(validRequests)('rejects unknown fields for %s', (method, params) => {
    expect(() => validateRpcRequest(request(method, { ...params, unexpected: true }))).toThrow(/unknown field/);
  });
  it.each([[[request('profile/list',{})]], [new Uint8Array([1])], [new ArrayBuffer(2)]])('rejects batch and binary-equivalent input', value => expect(()=>validateRpcRequest(value)).toThrow());
  it.each([null, 1.2, '', Number.MAX_SAFE_INTEGER + 1])('rejects invalid ID %s', id => expect(()=>validateRpcRequest({...request('profile/list',{}),id})).toThrow());
  it('rejects unsupported methods, tiers, provider selection, unknown fields, and oversized strings', () => {
    expect(()=>validateRpcRequest(request('agent/run',{}))).toThrow(/unsupported/);
    expect(()=>validateRpcRequest(request('model/generate',{permitId:'p',tier:'ultra',invocation,messages:[{role:'user',content:'x'}]}))).toThrow(/tier/);
    expect(()=>validateRpcRequest(request('model/generate',{permitId:'p',tier:'low',provider:'x',invocation,messages:[{role:'user',content:'x'}]}))).toThrow(/unknown field/);
    expect(()=>validateRpcRequest(request('initialize',{protocolVersion:'1.0',clientName:'x'.repeat(PROTOCOL_LIMITS.maxIdentifierBytes+1),clientVersion:'1'}))).toThrow(/bounded/);
  });
  it('rejects non-JSON nested values',()=>expect(()=>validateRpcRequest(request('tool/execute',{permitId:'p',idempotencyKey:'i',toolName:'t',input:{bad:undefined}}))).toThrow(/non-JSON/));
  it('enforces array, nesting-depth, cycle, and frame-size limits', () => {
    expect(() => validateRpcRequest(request('run/authorize', {
      runId:'r',inferenceMode:'gateway',profileRefs:Array(PROTOCOL_LIMITS.maxProfiles + 1).fill(profileRef),
    }))).toThrow(/bounded array/);

    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth <= PROTOCOL_LIMITS.maxJsonDepth; depth += 1) nested = { nested };
    expect(() => validateRpcRequest(request('tool/execute', {
      permitId:'p',idempotencyKey:'i',toolName:'t',input:nested,
    }))).toThrow(/depth/);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => validateRpcRequest(request('tool/execute', {
      permitId:'p',idempotencyKey:'i',toolName:'t',input:cyclic,
    }))).toThrow(/cycle/);

    const oversizedInput = Object.fromEntries(
      Array.from({length:5}, (_, index) => [`part${index}`, 'x'.repeat(220_000)]),
    );
    expect(() => validateRpcRequest(request('tool/execute', {
      permitId:'p',idempotencyKey:'i',toolName:'t',input:oversizedInput,
    }))).toThrow(/frame limit/);
  });
});

describe('response validation', () => {
  const profile = {ref:profileRef,schemaVersion:'1',name:'P',instructions:'Help'};
  const validResults: Array<[GatewayRequestMethod, Record<string, unknown>]> = [
    ['initialize',{
      protocolVersion:PROTOCOL_VERSION,serverVersion:'1',inferenceTiers:['low','medium','high','xtra-high'],
      streamEventVersions:['1'],profileSchemaVersions:['1'],remoteTools:[{name:'web_search',schemaVersion:'1'}],
      structuredOutput:true,cancellation:true,limits:{maxAttachmentBytes:1024,maxMessages:128},
      account:{permittedModes:['gateway','local'],tierCeiling:'high'},
    }],
    ['profile/list',{profiles:[{ref:profileRef,name:'P',allowedTiers:['high'],remoteCapabilities:['web_search']}]}],
    ['profile/get',{bundle:profile}],
    ['run/authorize',{permitId:'permit',inferenceMode:'gateway',inferenceTier:'high',routePolicyVersion:'1',remoteCapabilities:['web_search'],expiresAt:'2026-07-27T00:00:00Z'}],
    ['model/generate',{callId:'c',text:'ok',finishReason:'stop',usage,routePolicyVersion:'1'}],
    ['tool/execute',{idempotencyKey:'key',output:{answer:42},usage:{units:1},cacheHit:false}],
    ['request/cancel',{cancelled:true}],
    ['account/usage',{items:[{capability:'model',units:3,cost:0.01,occurredAt:'2026-07-26T00:00:00Z'}]}],
  ];

  it('accepts success fixtures for every method', () => {
    validResults.forEach(([method, result]) => {
      const fixture = {jsonrpc:'2.0',id:1,result};
      expect(validateRpcResponse(method, fixture)).toBe(fixture);
    });
  });
  it.each(validResults)('rejects unknown result fields for %s', (method, result) => {
    expect(() => validateRpcResponse(method, {jsonrpc:'2.0',id:1,result:{...result,unexpected:true}})).toThrow(/unknown field/);
  });
  it('accepts bounded public errors and rejects private provider details', () => {
    const fixture = {jsonrpc:'2.0',id:1,error:{code:-32000,message:'request failed',data:{gatewayCode:'provider_unavailable',retryable:true,traceId:'trace'}}};
    expect(validateRpcResponse('model/generate', fixture)).toBe(fixture);
    expect(() => validateRpcResponse('model/generate', {
      ...fixture,
      error:{...fixture.error,data:{...fixture.error.data,providerBody:'secret'}},
    })).toThrow(/unknown field/);
  });
});

describe('stream validation', () => {
  it('accepts zero-based contiguous terminal stream', () => { const s=new StreamSequenceValidator('c'); s.accept({callId:'c',seq:0,event:{type:'start'}}); s.accept({callId:'c',seq:1,event:{type:'text_delta',delta:'ok'}}); s.accept({callId:'c',seq:2,event:{type:'done'}}); expect(()=>s.assertTerminal()).not.toThrow(); });
  it('validates the transport-neutral JSON-RPC notification envelope', () => {
    const fixture = {jsonrpc:'2.0',method:'model/stream',params:{callId:'c',seq:0,event:{type:'start'}}};
    expect(validateModelStreamNotification(fixture)).toBe(fixture);
    expect(() => validateModelStreamNotification({...fixture,id:1})).toThrow(/unknown field/);
  });
  it('rejects gaps, wrong starts, post-terminal events and malformed envelopes', () => {
    expect(()=>new StreamSequenceValidator('c').accept({callId:'c',seq:0,event:{type:'done'}})).toThrow(/start/);
    const s=new StreamSequenceValidator('c'); s.accept({callId:'c',seq:0,event:{type:'start'}}); expect(()=>s.accept({callId:'c',seq:2,event:{type:'done'}})).toThrow(/contiguous/);
    expect(()=>validateModelStreamEnvelope({callId:'c',seq:-1,event:{type:'start'}})).toThrow();
    expect(()=>validateModelStreamEnvelope({callId:'c',seq:0,event:{type:'wat'}})).toThrow();
  });
});

describe('public errors and profiles', () => {
  it.each(PUBLIC_GATEWAY_ERROR_CODES)('validates public error fixture %s', gatewayCode => expect(validatePublicGatewayError({gatewayCode,retryable:false,traceId:`trace-${gatewayCode}`})).toBeTruthy());
  it('rejects unknown and malformed terminal errors',()=>{ expect(()=>validatePublicGatewayError({gatewayCode:'provider_body',retryable:false,traceId:'t'})).toThrow(); expect(()=>validateModelStreamEnvelope({callId:'c',seq:0,event:{type:'error',error:{gatewayCode:'internal_error',traceId:'t'}}})).toThrow(); });
  it('accepts declarative bundles and recursively prohibits executable fields',()=>{
    const profile={ref:{source:'server',id:'p',version:'1',contentHash:'h'},schemaVersion:'1',name:'P',instructions:'Help',delegates:[{id:'d',instructions:'Research'}]};
    expect(validateDeclarativeProfileBundle(profile)).toBe(profile);
    expect(()=>validateDeclarativeProfileBundle({...profile,delegates:[{id:'d',metadata:{handler:'evil'}}]})).toThrow(/prohibited/);
    expect(INFERENCE_TIERS).toEqual(['low','medium','high','xtra-high']);
  });
});
