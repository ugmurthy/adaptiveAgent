import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { ServiceNotFoundError, type ArtifactMetadata, type ArtifactStatus, type ServiceActor, type ServiceJob } from '@adaptive-agent/service-sdk';
import { ArtifactManager, ArtifactWorkspacePolicy, InputFileError, PostgresArtifactRepository, extractTaskFilenameReferences, type PrivateObjectStorage, safeContentDisposition } from './artifacts.js';

const actor:ServiceActor={tenantId:'tenant-1',userId:'alice'};

describe('private artifact management',()=>{
  it.each([
    ['Read report.md and summarise',['report.md']],
    ['Review `quarterly report.md` and inspect "notes file.txt"',['quarterly report.md','notes file.txt']],
    ['read report.md then review report.md',['report.md']],
    ['write report.md and save as notes.txt',[]],
    ['read ../secret.md then inspect folder\\secret.txt',[]],
  ])('extracts conservative input filenames from %s',(goal,expected)=>{
    expect(extractTaskFilenameReferences(goal)).toEqual(expected);
  });

  it('uploads safe files, hashes them, and quarantines unscanned binary content',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'artifacts-'));
    await writeFile(join(directory,'result.txt'),'private result');
    await writeFile(join(directory,'program.bin'),new Uint8Array([0,1,2]));
    const repository=new MemoryArtifactRepository(),storage=new MemoryStorage();
    const manager=new ArtifactManager(repository as never,storage);

    const artifacts=await manager.ingest(job(),directory);

    expect(artifacts.map(row=>[row.filename,row.status,row.mediaType])).toEqual([
      ['program.bin','quarantined','application/octet-stream'],
      ['result.txt','available','text/plain'],
    ]);
    expect(storage.objects.size).toBe(2);
    expect(repository.created.every(row=>row.jobId==='job-1')).toBe(true);
    expect(repository.created.every(row=>!('tenantId' in row.input)&&!('ownerUserId' in row.input))).toBe(true);
    expect(artifacts[1]!.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects symbolic links and enforces quotas before uploading anything',async()=>{
    const outside=await mkdtemp(join(tmpdir(),'artifact-outside-'));
    await writeFile(join(outside,'secret.txt'),'secret');
    const linked=await mkdtemp(join(tmpdir(),'artifact-linked-'));
    await symlink(join(outside,'secret.txt'),join(linked,'escape.txt'));
    const repository=new MemoryArtifactRepository(),storage=new MemoryStorage();
    const manager=new ArtifactManager(repository as never,storage,undefined,{maxFiles:1,maxFileBytes:4,maxTotalBytes:4});
    await expect(manager.ingest(job(),linked)).rejects.toThrow('Symbolic links');

    const oversized=await mkdtemp(join(tmpdir(),'artifact-large-'));
    await writeFile(join(oversized,'large.txt'),'12345');
    await expect(manager.ingest(job(),oversized)).rejects.toThrow('size quota');
    expect(storage.objects.size).toBe(0);
    expect(repository.created).toHaveLength(0);
  });

  it('rejects an artifact directory replaced after workspace preparation',async()=>{
    const workspace=await mkdtemp(join(tmpdir(),'artifact-workspace-'));
    const outside=await mkdtemp(join(tmpdir(),'artifact-replacement-'));
    await writeFile(join(outside,'secret.txt'),'secret');
    const artifacts=join(workspace,'artifacts');await symlink(outside,artifacts);
    const manager=new ArtifactManager(new MemoryArtifactRepository() as never,new MemoryStorage());
    await expect(manager.ingest(job(),artifacts,workspace)).rejects.toThrow('private directory');
  });

  it('downloads available and explicitly quarantined owner-scoped artifacts with distinct audits',async()=>{
    const repository=new MemoryArtifactRepository(),storage=new MemoryStorage();
    const manager=new ArtifactManager(repository as never,storage);
    const metadata=artifact();
    repository.owned={...metadata,storageKey:'artifacts/job-1/a1'};
    storage.objects.set('artifacts/job-1/a1',new TextEncoder().encode('data'));

    await expect(manager.download(actor,'job-1','a1')).resolves.toMatchObject({metadata:{id:'a1',filename:'result.txt'}});
    repository.owned={...metadata,status:'quarantined',storageKey:'artifacts/job-1/a1'};
    await expect(manager.downloadQuarantined(actor,'job-1','a1')).resolves.toMatchObject({metadata:{id:'a1',status:'quarantined'}});
    repository.owned=undefined;
    await expect(manager.download({...actor,userId:'bob'},'job-1','a1')).rejects.toBeInstanceOf(ServiceNotFoundError);
    expect(repository.audits.map(row=>[row.status,row.allowed])).toEqual([['available',true],['quarantined',true],['available',false]]);
  });

  it('reuses an existing owner-scoped binding without resolving the filename again',async()=>{
    const query=vi.fn(async()=>({rows:[artifactRow()],rowCount:1}));
    const repository=new PostgresArtifactRepository({query} as never);

    await expect(repository.resolveJobFile(job(),'report.md')).resolves.toMatchObject({id:'a1',filename:'report.md'});

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![1]).toEqual(['job-1','report.md','tenant-1','alice']);
  });

  it('fails rather than selecting one of multiple exact filename candidates',async()=>{
    const query=vi.fn(async(statement:string)=>statement.includes('with candidates')
      ? {rows:[{candidate_count:2,current_artifact_id:null}],rowCount:1}
      : {rows:[],rowCount:0});
    const repository=new PostgresArtifactRepository({query} as never);

    await expect(repository.resolveJobFile(job(),'report.md')).rejects.toMatchObject({code:'INPUT_FILE_AMBIGUOUS',retryable:false});
  });

  it('uploads before removing the isolated worker workspace',async()=>{
    const root=await mkdtemp(join(tmpdir(),'job-workspace-')),artifacts=join(root,'artifacts');
    await mkdir(artifacts);await writeFile(join(artifacts,'result.txt'),'done');
    const manager={ingest:vi.fn(async()=>[])};
    await new ArtifactWorkspacePolicy(manager as never).close(job(),{root,artifacts});
    expect(manager.ingest).toHaveBeenCalledWith(expect.objectContaining({id:'job-1'}),artifacts,root);
    await expect(readFile(join(artifacts,'result.txt'))).rejects.toThrow();
  });

  it('pins, verifies, and materializes referenced files with an exact model manifest',async()=>{
    const root=await mkdtemp(join(tmpdir(),'job-input-')),artifacts=join(root,'artifacts');
    await mkdir(artifacts);
    const data=new TextEncoder().encode('private report');
    const repository=new MemoryArtifactRepository(),storage=new MemoryStorage();
    repository.resolved=inputArtifact(data);
    storage.objects.set(repository.resolved.storageKey,data);
    const manager=new ArtifactManager(repository as never,storage);
    const inputJob=job();inputJob.request={schemaVersion:1,agentId:'agent',goal:'Read report.md and summarise'};

    const prepared=await manager.prepareInputs(inputJob,{root,artifacts});

    expect(await readFile(join(root,'inputs','a1','report.md'),'utf8')).toBe('private report');
    expect(prepared.files).toEqual([expect.objectContaining({artifactId:'a1',filename:'report.md',relativePath:'inputs/a1/report.md'})]);
    expect(prepared.modelContext).toContain('- report.md (a1): inputs/a1/report.md');
    expect(prepared.modelContext).not.toContain('private report');
    expect(repository.materializationAudits).toEqual([{artifactId:'a1',allowed:true}]);
  });

  it('rejects corrupt bound bytes as a deterministic input failure',async()=>{
    const root=await mkdtemp(join(tmpdir(),'job-input-corrupt-')),artifacts=join(root,'artifacts');
    await mkdir(artifacts);
    const expected=new TextEncoder().encode('expected'),corrupt=new TextEncoder().encode('corrupt!');
    const repository=new MemoryArtifactRepository(),storage=new MemoryStorage();
    repository.resolved=inputArtifact(expected);storage.objects.set(repository.resolved.storageKey,corrupt);
    const manager=new ArtifactManager(repository as never,storage);
    const inputJob=job();inputJob.request={schemaVersion:1,agentId:'agent',goal:'Read report.md'};

    await expect(manager.prepareInputs(inputJob,{root,artifacts})).rejects.toMatchObject({code:'INPUT_FILE_INTEGRITY_ERROR',retryable:false});
    expect(repository.materializationAudits).toEqual([{artifactId:'a1',allowed:false}]);
  });

  it('uses explicit artifact IDs instead of filename extraction and supports duplicate display names',async()=>{
    const root=await mkdtemp(join(tmpdir(),'job-explicit-input-')),artifacts=join(root,'artifacts');
    await mkdir(artifacts);
    const first=new TextEncoder().encode('first'),second=new TextEncoder().encode('second');
    const repository=new MemoryArtifactRepository(),storage=new MemoryStorage();
    repository.resolvedArtifacts.set('a1',inputArtifact(first,'a1'));
    repository.resolvedArtifacts.set('a2',inputArtifact(second,'a2'));
    storage.objects.set('artifacts/source/a1',first);storage.objects.set('artifacts/source/a2',second);
    const manager=new ArtifactManager(repository as never,storage);
    const inputJob=job();inputJob.request={schemaVersion:1,agentId:'agent',goal:'Read missing.md',fileRefs:[{artifactId:'a1'},{artifactId:'a2'}]};

    const prepared=await manager.prepareInputs(inputJob,{root,artifacts});

    expect(await readFile(join(root,'inputs','a1','report.md'),'utf8')).toBe('first');
    expect(await readFile(join(root,'inputs','a2','report.md'),'utf8')).toBe('second');
    expect(prepared.files.map(file=>file.artifactId)).toEqual(['a1','a2']);
    expect(prepared.modelContext).toContain('report.md (a1): inputs/a1/report.md');
    expect(prepared.modelContext).toContain('report.md (a2): inputs/a2/report.md');
  });

  it('creates a safe attachment header without exposing storage details',()=>{
    const header=safeContentDisposition('report ü.txt');
    expect(header).toContain('attachment; filename="report__.txt"');
    expect(header).toContain("filename*=UTF-8''report%20%C3%BC.txt");
    expect(header).not.toContain('artifacts/job-1');
  });
});

class MemoryStorage implements PrivateObjectStorage {
  objects=new Map<string,Uint8Array>();
  async put(key:string,data:Uint8Array):Promise<void>{this.objects.set(key,data);}
  async get(key:string):Promise<Uint8Array|undefined>{return this.objects.get(key);}
  async delete(key:string):Promise<void>{this.objects.delete(key);}
  async list():Promise<Array<{key:string}>>{return [...this.objects.keys()].map(key=>({key}));}
}

class MemoryArtifactRepository {
  created:Array<{jobId:string;input:Record<string,unknown>}>=[];
  statuses:Array<{id:string;status:ArtifactStatus}>=[];
  audits:Array<{actor:ServiceActor;status:'available'|'quarantined';allowed:boolean}>=[];
  owned:(ArtifactMetadata&{storageKey:string})|undefined;
  resolved:(ArtifactMetadata&{storageKey:string})|undefined;
  resolvedArtifacts=new Map<string,ArtifactMetadata&{storageKey:string}>();
  materializationAudits:Array<{artifactId:string|undefined;allowed:boolean}>=[];
  async createFromJob(jobId:string,input:Record<string,unknown>):Promise<void>{this.created.push({jobId,input});}
  async transition(id:string,_expected:readonly ArtifactStatus[],status:ArtifactStatus):Promise<boolean>{this.statuses.push({id,status});return true;}
  async getOwned(inputActor:ServiceActor,_jobId:string,_artifactId:string,status:'available'|'quarantined'):Promise<(ArtifactMetadata&{storageKey:string})|undefined>{return (inputActor===actor||inputActor.userId===actor.userId)&&this.owned?.status===status?this.owned:undefined;}
  async auditDownload(inputActor:ServiceActor,_jobId:string,_artifactId:string,status:'available'|'quarantined',allowed:boolean):Promise<void>{this.audits.push({actor:inputActor,status,allowed});}
  async resolveJobFile():Promise<ArtifactMetadata&{storageKey:string}>{if(!this.resolved)throw new InputFileError('INPUT_FILE_NOT_FOUND');return this.resolved;}
  async resolveJobArtifact(_job:ServiceJob,artifactId:string):Promise<ArtifactMetadata&{storageKey:string}>{const artifact=this.resolvedArtifacts.get(artifactId)??(this.resolved?.id===artifactId?this.resolved:undefined);if(!artifact)throw new InputFileError('INPUT_FILE_NOT_FOUND');return artifact;}
  async auditMaterialization(_job:ServiceJob,artifactId:string|undefined,allowed:boolean):Promise<void>{this.materializationAudits.push({artifactId,allowed});}
  async reconciliationCandidates():Promise<[]> {return [];}
  async deleteReconciliationCandidate():Promise<boolean> {return true;}
  async knownStorageKeys():Promise<Set<string>> {return new Set();}
}

function artifact():ArtifactMetadata{return {schemaVersion:1,id:'a1',tenantId:'tenant-1',ownerUserId:'alice',jobId:'job-1',filename:'result.txt',mediaType:'text/plain',byteSize:4,contentHash:'hash',status:'available',createdAt:'2026-01-01T00:00:00.000Z'};}
function inputArtifact(data:Uint8Array,id='a1'):ArtifactMetadata&{storageKey:string}{return {...artifact(),id,filename:'report.md',byteSize:data.byteLength,contentHash:createHash('sha256').update(data).digest('hex'),storageKey:`artifacts/source/${id}`};}
function artifactRow(){return {id:'a1',current_artifact_id:'a1',tenant_id:'tenant-1',owner_user_id:'alice',job_id:'source-job',run_id:null,tool_execution_id:null,storage_key:'artifacts/source/a1',original_filename:'report.md',media_type:'text/markdown',byte_size:4,content_hash:'hash',status:'available' as const,created_at:'2026-01-01T00:00:00.000Z',available_at:'2026-01-01T00:00:00.000Z',expires_at:'2026-08-01T00:00:00.000Z',deleted_at:null};}
function job():ServiceJob{return {schemaVersion:1,id:'job-1',tenantId:'tenant-1',ownerUserId:'alice',kind:'run',state:'running',sessionId:'session-1',request:{schemaVersion:1,agentId:'agent',goal:'goal'},profiles:[],commandVersion:1,processedCommandVersion:0,pendingCommand:{kind:'execute',version:1,requestedAt:'2026-01-01T00:00:00.000Z'},createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'};}
