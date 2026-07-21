import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readdir, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, extname, resolve, sep } from 'node:path';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  ServiceNotFoundError,
  mapArtifactRow,
  type ArtifactMetadata,
  type ArtifactStatus,
  type ServiceActor,
  type ServiceJob,
  type ServicePostgresClient,
} from '@adaptive-agent/service-sdk';
import type { JobWorkspace, SandboxPolicy } from './workspace.js';

export interface ArtifactQuotas {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface ArtifactScanner {
  scan(input: { filename: string; mediaType: string; data: Uint8Array }): Promise<'clean' | 'quarantined'>;
}

export interface StoredObject {
  key: string;
  lastModified?: Date;
}

export interface PrivateObjectStorage {
  put(key: string, data: Uint8Array, mediaType: string, contentHash: string): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<StoredObject[]>;
}

interface InternalArtifact extends ArtifactMetadata { storageKey: string }
interface ArtifactRepository {
  createFromJob(jobId:string,input:{id:string;storageKey:string;filename:string;mediaType:string;byteSize:number;contentHash:string;createdAt:string;runId?:string;toolExecutionId?:string}):Promise<void>;
  transition(id:string,expected:readonly ArtifactStatus[],status:ArtifactStatus,now:string,expiresAt?:string):Promise<boolean>;
  getOwned(actor:ServiceActor,jobId:string,artifactId:string,status:'available'|'quarantined'):Promise<InternalArtifact|undefined>;
  auditDownload(actor:ServiceActor,jobId:string,artifactId:string,status:'available'|'quarantined',allowed:boolean):Promise<void>;
  reconciliationCandidates(now:string,abandonedBefore:string):Promise<InternalArtifact[]>;
  knownStorageKeys():Promise<Set<string>>;
}
interface ArtifactRow {
  id:string; tenant_id:string; owner_user_id:string; job_id:string; run_id:string|null;
  tool_execution_id:string|null; storage_key:string; original_filename:string; media_type:string;
  byte_size:string|number; content_hash:string; status:ArtifactStatus; created_at:string|Date;
  available_at:string|Date|null; expires_at:string|Date|null; deleted_at:string|Date|null;
}

export class PostgresArtifactRepository implements ArtifactRepository {
  constructor(private readonly db:ServicePostgresClient) {}

  async createFromJob(jobId:string, input:{id:string;storageKey:string;filename:string;mediaType:string;byteSize:number;contentHash:string;createdAt:string;runId?:string;toolExecutionId?:string}):Promise<void> {
    const result=await this.db.query(`insert into service_artifacts(id,tenant_id,owner_user_id,job_id,run_id,tool_execution_id,storage_key,original_filename,media_type,byte_size,content_hash,status,created_at,updated_at)
      select $2,j.tenant_id,j.owner_user_id,j.id,$3,$4,$5,$6,$7,$8,$9,'uploading',$10,$10 from service_jobs j where j.id=$1`,
      [jobId,input.id,input.runId??null,input.toolExecutionId??null,input.storageKey,input.filename,input.mediaType,input.byteSize,input.contentHash,input.createdAt]);
    if(result.rowCount!==1)throw new ServiceNotFoundError();
  }

  async transition(id:string,expected:readonly ArtifactStatus[],status:ArtifactStatus,now:string,expiresAt?:string):Promise<boolean> {
    const result=await this.db.query(`update service_artifacts set status=$3, updated_at=$4, available_at=case when $3='available' then $4 else available_at end, expires_at=coalesce($5,expires_at), deleted_at=case when $3='deleted' then $4 else deleted_at end where id=$1 and status=any($2::text[])`,[id,expected,status,now,expiresAt??null]);
    return result.rowCount===1;
  }

  async getOwned(actor:ServiceActor,jobId:string,artifactId:string,status:'available'|'quarantined'):Promise<InternalArtifact|undefined> {
    const result=await this.db.query<ArtifactRow>(`select a.* from service_artifacts a join service_jobs j on j.id=a.job_id where a.id=$1 and a.job_id=$2 and j.tenant_id=$3 and j.owner_user_id=$4 and a.status=$5 and (a.expires_at is null or a.expires_at>now())`,[artifactId,jobId,actor.tenantId,actor.userId,status]);
    const row=result.rows[0];
    return row ? {...mapArtifactRow(row),storageKey:row.storage_key} : undefined;
  }

  async auditDownload(actor:ServiceActor,jobId:string,artifactId:string,status:'available'|'quarantined',allowed:boolean):Promise<void> {
    const action=status==='quarantined'?'artifact:download_quarantined':'artifact:download';
    await this.db.query(`insert into service_access_audit_records(id,tenant_id,user_id,action,target_job_id,target_artifact_id,allowed,occurred_at) values($1,$2,$3,$4,$5,$6,$7,now())`,
      [randomUUID(),actor.tenantId,actor.userId,action,jobId,artifactId,allowed]);
  }

  async reconciliationCandidates(now:string,abandonedBefore:string):Promise<InternalArtifact[]> {
    const result=await this.db.query<ArtifactRow>(`select * from service_artifacts where (status in ('uploading','scanning') and updated_at<$2) or (status in ('available','quarantined') and expires_at is not null and expires_at<$1)`,[now,abandonedBefore]);
    return result.rows.map(row=>({...mapArtifactRow(row),storageKey:row.storage_key}));
  }

  async knownStorageKeys():Promise<Set<string>> {
    const result=await this.db.query<{storage_key:string}>(`select storage_key from service_artifacts where status <> 'deleted'`);
    return new Set(result.rows.map(row=>row.storage_key));
  }
}

export class S3ArtifactStorage implements PrivateObjectStorage {
  private readonly client:S3Client;
  private readonly serverSideEncryption:'AES256'|undefined;
  constructor(private readonly bucket:string, options:{region:string;endpoint?:string;accessKeyId?:string;secretAccessKey?:string;forcePathStyle?:boolean;serverSideEncryption?:'AES256'}) {
    if(options.endpoint) {
      const endpoint=new URL(options.endpoint);
      if(endpoint.protocol!=='https:' && !['localhost','127.0.0.1','::1'].includes(endpoint.hostname)) throw new Error('Artifact storage endpoint must use TLS');
    }
    this.serverSideEncryption=options.serverSideEncryption;
    this.client=new S3Client({region:options.region,endpoint:options.endpoint,forcePathStyle:options.forcePathStyle,
      credentials:options.accessKeyId&&options.secretAccessKey?{accessKeyId:options.accessKeyId,secretAccessKey:options.secretAccessKey}:undefined});
  }
  async put(key:string,data:Uint8Array,mediaType:string,contentHash:string):Promise<void> {
    await this.client.send(new PutObjectCommand({Bucket:this.bucket,Key:key,Body:data,ContentType:mediaType,Metadata:{sha256:contentHash},ServerSideEncryption:this.serverSideEncryption}));
  }
  async get(key:string):Promise<Uint8Array|undefined> {
    try {
      const response=await this.client.send(new GetObjectCommand({Bucket:this.bucket,Key:key}));
      return response.Body ? await response.Body.transformToByteArray() : undefined;
    } catch(error) {
      const status=(error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode;
      if(status===404)return undefined;
      throw error;
    }
  }
  async delete(key:string):Promise<void> {
    let keyMarker:string|undefined,versionMarker:string|undefined;
    const objects:Array<{Key:string;VersionId:string}>=[];
    do {
      const page=await this.client.send(new ListObjectVersionsCommand({Bucket:this.bucket,Prefix:key,KeyMarker:keyMarker,VersionIdMarker:versionMarker}));
      objects.push(...[...(page.Versions??[]),...(page.DeleteMarkers??[])]
        .filter((object):object is typeof object&{VersionId:string}=>object.Key===key&&Boolean(object.VersionId)).map(object=>({Key:key,VersionId:object.VersionId})));
      keyMarker=page.IsTruncated?page.NextKeyMarker:undefined;versionMarker=page.IsTruncated?page.NextVersionIdMarker:undefined;
    } while(keyMarker);
    for(let index=0;index<objects.length;index+=1000)await this.client.send(new DeleteObjectsCommand({Bucket:this.bucket,Delete:{Objects:objects.slice(index,index+1000),Quiet:true}}));
    if(!objects.length)await this.client.send(new DeleteObjectCommand({Bucket:this.bucket,Key:key}));
  }
  async list(prefix:string):Promise<StoredObject[]> {
    const objects=new Map<string,Date|undefined>();let keyMarker:string|undefined,versionMarker:string|undefined;
    do {
      const page=await this.client.send(new ListObjectVersionsCommand({Bucket:this.bucket,Prefix:prefix,KeyMarker:keyMarker,VersionIdMarker:versionMarker}));
      for(const object of [...(page.Versions??[]),...(page.DeleteMarkers??[])])if(object.Key) {
        const old=objects.get(object.Key);if(!old||object.LastModified&&object.LastModified>old)objects.set(object.Key,object.LastModified);
      }
      keyMarker=page.IsTruncated?page.NextKeyMarker:undefined;versionMarker=page.IsTruncated?page.NextVersionIdMarker:undefined;
    } while(keyMarker);
    return [...objects].map(([key,lastModified])=>({key,lastModified}));
  }
  destroy():void { this.client.destroy(); }
}

export class ArtifactManager {
  constructor(
    private readonly repository:ArtifactRepository,
    private readonly storage:PrivateObjectStorage,
    private readonly scanner:ArtifactScanner=new SafeMediaArtifactScanner(),
    private readonly quotas:ArtifactQuotas={maxFiles:20,maxFileBytes:50*1024*1024,maxTotalBytes:100*1024*1024},
    private readonly availableRetentionMs=7*24*60*60*1000,
    private readonly quarantineRetentionMs=30*24*60*60*1000,
  ) {}

  async ingest(job:ServiceJob,directory:string,workspaceRoot=dirname(directory)):Promise<ArtifactMetadata[]> {
    const files=await collectArtifactFiles(directory,workspaceRoot,this.quotas);
    const uploaded:ArtifactMetadata[]=[];
    for(const file of files) {
      const data=file.data;
      const contentHash=createHash('sha256').update(data).digest('hex');
      const mediaType=validatedMediaType(file.filename,data);
      const id=randomUUID(),storageKey=`artifacts/${job.id}/${id}`,createdAt=new Date().toISOString();
      await this.repository.createFromJob(job.id,{id,storageKey,filename:file.filename,mediaType,byteSize:data.byteLength,contentHash,createdAt});
      await retry(()=>this.storage.put(storageKey,data,mediaType,contentHash));
      if(!await this.repository.transition(id,['uploading'],'scanning',new Date().toISOString())) { await this.storage.delete(storageKey);throw new Error('Artifact upload lost its lifecycle lease'); }
      let verdict:'clean'|'quarantined'='quarantined';
      try { verdict=await this.scanner.scan({filename:file.filename,mediaType,data}); } catch {}
      const status=verdict==='clean'?'available':'quarantined';
      const now=new Date(),retention=status==='available'?this.availableRetentionMs:this.quarantineRetentionMs,expiresAt=new Date(now.getTime()+retention).toISOString();
      if(!await this.repository.transition(id,['scanning'],status,now.toISOString(),expiresAt)) { await this.storage.delete(storageKey);throw new Error('Artifact scan lost its lifecycle lease'); }
      uploaded.push({schemaVersion:1,id,tenantId:job.tenantId,ownerUserId:job.ownerUserId,jobId:job.id,filename:file.filename,mediaType,byteSize:data.byteLength,contentHash,status,createdAt,availableAt:status==='available'?now.toISOString():undefined,expiresAt});
    }
    return uploaded;
  }

  async download(actor:ServiceActor,jobId:string,artifactId:string):Promise<{metadata:ArtifactMetadata;data:Uint8Array}> {
    return this.downloadOwned(actor,jobId,artifactId,'available');
  }

  async downloadQuarantined(actor:ServiceActor,jobId:string,artifactId:string):Promise<{metadata:ArtifactMetadata;data:Uint8Array}> {
    return this.downloadOwned(actor,jobId,artifactId,'quarantined');
  }

  private async downloadOwned(actor:ServiceActor,jobId:string,artifactId:string,status:'available'|'quarantined'):Promise<{metadata:ArtifactMetadata;data:Uint8Array}> {
    let allowed=false;
    try {
      const artifact=await this.repository.getOwned(actor,jobId,artifactId,status);
      if(!artifact)throw new ServiceNotFoundError();
      const data=await this.storage.get(artifact.storageKey);
      if(!data)throw new ServiceNotFoundError();
      allowed=true;
      const {storageKey:_,...metadata}=artifact;
      return {metadata,data};
    } finally {
      await this.repository.auditDownload(actor,jobId,artifactId,status,allowed);
    }
  }

  async reconcile(options:{abandonedBefore:Date;orphanBefore:Date;now?:Date}):Promise<{deleted:number;orphans:number}> {
    const now=options.now??new Date();
    const rows=await this.repository.reconciliationCandidates(now.toISOString(),options.abandonedBefore.toISOString());
    let deleted=0;
    for(const row of rows) {
      if(!await this.repository.transition(row.id,[row.status],'deleted',now.toISOString()))continue;
      await this.storage.delete(row.storageKey);deleted++;
    }
    const known=await this.repository.knownStorageKeys();let orphans=0;
    for(const object of await this.storage.list('artifacts/')) {
      if(!known.has(object.key)&&object.lastModified&&object.lastModified<options.orphanBefore) { await this.storage.delete(object.key);orphans++; }
    }
    return {deleted,orphans};
  }
}

export class ArtifactWorkspacePolicy implements SandboxPolicy {
  constructor(private readonly artifacts:ArtifactManager) {}
  async prepare():Promise<void> {}
  async close(job:ServiceJob,workspace:JobWorkspace):Promise<void> {
    try { await this.artifacts.ingest(job,workspace.artifacts,workspace.root); }
    finally { await rm(workspace.root,{recursive:true,force:true}); }
  }
}

export class SafeMediaArtifactScanner implements ArtifactScanner {
  async scan(input:{mediaType:string}):Promise<'clean'|'quarantined'> {
    return SAFE_MEDIA_TYPES.has(input.mediaType)||input.mediaType.startsWith('image/')?'clean':'quarantined';
  }
}

const SAFE_MEDIA_TYPES=new Set(['text/plain','text/csv','text/markdown','application/json']);
const MEDIA_TYPES:Record<string,string>={'.txt':'text/plain','.md':'text/markdown','.csv':'text/csv','.json':'application/json','.pdf':'application/pdf','.zip':'application/zip','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp'};
function validatedMediaType(filename:string,data:Uint8Array):string {
  const expected=MEDIA_TYPES[extname(filename).toLowerCase()]??'application/octet-stream';
  const starts=(...bytes:number[])=>bytes.every((byte,index)=>data[index]===byte);
  if(expected==='application/pdf')return starts(0x25,0x50,0x44,0x46,0x2d)?expected:'application/octet-stream';
  if(expected==='application/zip')return starts(0x50,0x4b,0x03,0x04)||starts(0x50,0x4b,0x05,0x06)?expected:'application/octet-stream';
  if(expected==='image/png')return starts(0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a)?expected:'application/octet-stream';
  if(expected==='image/jpeg')return starts(0xff,0xd8,0xff)?expected:'application/octet-stream';
  if(expected==='image/gif')return starts(0x47,0x49,0x46,0x38)?expected:'application/octet-stream';
  if(expected==='image/webp')return starts(0x52,0x49,0x46,0x46)&&data[8]===0x57&&data[9]===0x45&&data[10]===0x42&&data[11]===0x50?expected:'application/octet-stream';
  if(expected.startsWith('text/')||expected==='application/json') {
    try { new TextDecoder('utf-8',{fatal:true}).decode(data);return expected; } catch { return 'application/octet-stream'; }
  }
  return expected;
}

async function collectArtifactFiles(directory:string,workspaceRoot:string,quotas:ArtifactQuotas):Promise<Array<{path:string;filename:string;data:Uint8Array}>> {
  const workspaceInfo=await lstat(workspaceRoot),rootInfo=await lstat(directory);
  if(workspaceInfo.isSymbolicLink()||rootInfo.isSymbolicLink()||!workspaceInfo.isDirectory()||!rootInfo.isDirectory())throw new Error('Artifact workspace must be a private directory');
  const canonicalWorkspace=await realpath(workspaceRoot),root=await realpath(directory);
  if(!root.startsWith(`${canonicalWorkspace}${sep}`))throw new Error('Artifact directory resolves outside job workspace');
  const files:Array<{path:string;filename:string;data:Uint8Array}>=[];let total=0;
  const visit=async(current:string):Promise<void>=>{
    for(const entry of await readdir(current,{withFileTypes:true})) {
      const path=resolve(current,entry.name);
      if(path!==root&&!path.startsWith(`${root}${sep}`))throw new Error('Artifact path escapes job workspace');
      if(entry.isSymbolicLink()||(await lstat(path)).isSymbolicLink())throw new Error('Symbolic links are not allowed in artifact output');
      const canonical=await realpath(path);
      if(canonical!==root&&!canonical.startsWith(`${root}${sep}`))throw new Error('Artifact resolves outside job workspace');
      if(entry.isDirectory())throw new Error('Nested artifact directories are not allowed');
      if(!entry.isFile())throw new Error('Only regular artifact files are allowed');
      const handle=await open(canonical,constants.O_RDONLY|constants.O_NOFOLLOW);
      let data:Uint8Array;
      try {
        const info=await handle.stat();
        if(!info.isFile()||info.nlink!==1)throw new Error('Artifact must be a private regular file');
        if(info.size>quotas.maxFileBytes)throw new Error('Artifact file size quota exceeded');
        data=await handle.readFile();
      } finally { await handle.close(); }
      if(data.byteLength>quotas.maxFileBytes)throw new Error('Artifact file size quota exceeded');
      total+=data.byteLength;if(total>quotas.maxTotalBytes)throw new Error('Artifact total size quota exceeded');
      if(files.length>=quotas.maxFiles)throw new Error('Artifact file count quota exceeded');
      const filename=basename(entry.name);
      if(!filename||/[\u0000-\u001f\u007f]/.test(filename))throw new Error('Artifact filename is unsafe');
      files.push({path:canonical,filename,data});
    }
  };
  await visit(root);
  const finalWorkspace=await lstat(workspaceRoot),finalRoot=await lstat(directory);
  if(finalWorkspace.dev!==workspaceInfo.dev||finalWorkspace.ino!==workspaceInfo.ino||finalRoot.dev!==rootInfo.dev||finalRoot.ino!==rootInfo.ino)throw new Error('Artifact workspace changed during collection');
  return files.sort((left,right)=>left.path.localeCompare(right.path));
}

async function retry(operation:()=>Promise<void>):Promise<void> {
  let failure:unknown;
  for(let attempt=0;attempt<3;attempt++)try { await operation();return; } catch(error) { failure=error;if(attempt<2)await new Promise(resolve=>setTimeout(resolve,50*2**attempt)); }
  throw failure;
}

export function safeContentDisposition(filename:string):string {
  const fallback=filename.replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,150)||'artifact';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
