import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { ServiceNotFoundError, type ArtifactMetadata, type ArtifactStatus, type ServiceActor, type ServiceJob } from '@adaptive-agent/service-sdk';
import { ArtifactManager, ArtifactWorkspacePolicy, type PrivateObjectStorage, safeContentDisposition } from './artifacts.js';

const actor:ServiceActor={tenantId:'tenant-1',userId:'alice'};

describe('private artifact management',()=>{
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

  it('downloads only available owner-scoped metadata and audits allowed and denied attempts',async()=>{
    const repository=new MemoryArtifactRepository(),storage=new MemoryStorage();
    const manager=new ArtifactManager(repository as never,storage);
    const metadata=artifact();
    repository.available={...metadata,storageKey:'artifacts/job-1/a1'};
    storage.objects.set('artifacts/job-1/a1',new TextEncoder().encode('data'));

    await expect(manager.download(actor,'job-1','a1')).resolves.toMatchObject({metadata:{id:'a1',filename:'result.txt'}});
    repository.available=undefined;
    await expect(manager.download({...actor,userId:'bob'},'job-1','a1')).rejects.toBeInstanceOf(ServiceNotFoundError);
    expect(repository.audits.map(row=>row.allowed)).toEqual([true,false]);
  });

  it('uploads before removing the isolated worker workspace',async()=>{
    const root=await mkdtemp(join(tmpdir(),'job-workspace-')),artifacts=join(root,'artifacts');
    await mkdir(artifacts);await writeFile(join(artifacts,'result.txt'),'done');
    const manager={ingest:vi.fn(async()=>[])};
    await new ArtifactWorkspacePolicy(manager as never).close(job(),{root,artifacts});
    expect(manager.ingest).toHaveBeenCalledWith(expect.objectContaining({id:'job-1'}),artifacts,root);
    await expect(readFile(join(artifacts,'result.txt'))).rejects.toThrow();
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
  audits:Array<{actor:ServiceActor;allowed:boolean}>=[];
  available:(ArtifactMetadata&{storageKey:string})|undefined;
  async createFromJob(jobId:string,input:Record<string,unknown>):Promise<void>{this.created.push({jobId,input});}
  async transition(id:string,_expected:readonly ArtifactStatus[],status:ArtifactStatus):Promise<boolean>{this.statuses.push({id,status});return true;}
  async getAvailableOwned(inputActor:ServiceActor):Promise<(ArtifactMetadata&{storageKey:string})|undefined>{return inputActor===actor||inputActor.userId===actor.userId?this.available:undefined;}
  async auditDownload(inputActor:ServiceActor,_jobId:string,_artifactId:string,allowed:boolean):Promise<void>{this.audits.push({actor:inputActor,allowed});}
  async reconciliationCandidates():Promise<[]> {return [];}
  async knownStorageKeys():Promise<Set<string>> {return new Set();}
}

function artifact():ArtifactMetadata{return {schemaVersion:1,id:'a1',tenantId:'tenant-1',ownerUserId:'alice',jobId:'job-1',filename:'result.txt',mediaType:'text/plain',byteSize:4,contentHash:'hash',status:'available',createdAt:'2026-01-01T00:00:00.000Z'};}
function job():ServiceJob{return {schemaVersion:1,id:'job-1',tenantId:'tenant-1',ownerUserId:'alice',kind:'run',state:'running',sessionId:'session-1',request:{schemaVersion:1,agentId:'agent',goal:'goal'},profiles:[],commandVersion:1,processedCommandVersion:0,pendingCommand:{kind:'execute',version:1,requestedAt:'2026-01-01T00:00:00.000Z'},createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'};}
