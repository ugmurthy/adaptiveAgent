import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
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
  type RunRequest,
  type ServiceJobRequest,
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
  get(key: string, maxBytes?: number): Promise<Uint8Array | undefined>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<StoredObject[]>;
}

interface InternalArtifact extends ArtifactMetadata { storageKey: string }
interface ArtifactRepository {
  createFromJob(jobId:string,input:{id:string;storageKey:string;filename:string;mediaType:string;byteSize:number;contentHash:string;createdAt:string;runId?:string;toolExecutionId?:string}):Promise<void>;
  transition(id:string,expected:readonly ArtifactStatus[],status:ArtifactStatus,now:string,expiresAt?:string):Promise<boolean>;
  getOwned(actor:ServiceActor,jobId:string,artifactId:string,status:'available'|'quarantined'):Promise<InternalArtifact|undefined>;
  auditDownload(actor:ServiceActor,jobId:string,artifactId:string,status:'available'|'quarantined',allowed:boolean):Promise<void>;
  resolveJobFile(job:ServiceJob,requestedName:string):Promise<InternalArtifact>;
  resolveJobArtifact(job:ServiceJob,artifactId:string):Promise<InternalArtifact>;
  auditMaterialization(job:ServiceJob,artifactId:string|undefined,allowed:boolean):Promise<void>;
  reconciliationCandidates(now:string,abandonedBefore:string):Promise<InternalArtifact[]>;
  deleteReconciliationCandidate(id:string,status:ArtifactStatus,now:string,abandonedBefore:string):Promise<boolean>;
  knownStorageKeys():Promise<Set<string>>;
}
interface ArtifactRow {
  id:string; tenant_id:string; owner_user_id:string; job_id:string; run_id:string|null;
  tool_execution_id:string|null; storage_key:string; original_filename:string; media_type:string;
  byte_size:string|number; content_hash:string; status:ArtifactStatus; created_at:string|Date;
  available_at:string|Date|null; expires_at:string|Date|null; deleted_at:string|Date|null;
}

export class PostgresArtifactRepository implements ArtifactRepository {
  constructor(private readonly db:ServicePostgresClient, private readonly fileReferenceRetentionMs=7*24*60*60*1000) {}

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

  async resolveJobFile(job:ServiceJob,requestedName:string):Promise<InternalArtifact> {
    for(let attempt=0;attempt<2;attempt++) {
      const existing=await this.db.query<ArtifactRow&{current_artifact_id:string}>(`select a.*,r.current_artifact_id from service_job_file_refs r join service_jobs j on j.id=r.job_id join service_artifacts a on a.id=r.current_artifact_id
        where r.job_id=$1 and r.requested_name=$2 and j.tenant_id=$3 and j.owner_user_id=$4`,
        [job.id,requestedName,job.tenantId,job.ownerUserId]);
      const existingRow=existing.rows[0];
      if(existingRow) {
        if(existingRow.status!=='available'||existingRow.tenant_id!==job.tenantId||existingRow.owner_user_id!==job.ownerUserId)throw new InputFileError('INPUT_FILE_UNAVAILABLE',requestedName);
        return {...mapArtifactRow(existingRow),storageKey:existingRow.storage_key};
      }

      const nowDate=new Date(),now=nowDate.toISOString(),retainUntil=new Date(nowDate.getTime()+this.fileReferenceRetentionMs).toISOString();
      const resolved=await this.db.query<ArtifactRow&{current_artifact_id:string|null;candidate_count:string|number}>(`with candidates as materialized (
          select a.* from service_artifacts a join service_jobs source_job on source_job.id=a.job_id
          where a.tenant_id=$1 and a.owner_user_id=$2 and a.original_filename=$3 and a.status='available' and (a.expires_at is null or a.expires_at>now())
          order by a.created_at desc,a.id limit 2
        ), candidate_count as (select count(*)::integer as value from candidates), selected as (select * from candidates where (select value from candidate_count)=1),
        retained as (
          update service_artifacts a set expires_at=case when a.expires_at is null then null else greatest(a.expires_at,$6::timestamptz) end,updated_at=$5
          from selected s where a.id=s.id and a.status='available' and (a.expires_at is null or a.expires_at>now()) returning a.*
        ),
        inserted as (
          insert into service_job_file_refs(job_id,requested_name,source_artifact_id,current_artifact_id,access_mode,source_content_hash,created_at,updated_at)
          select $4,$3,s.id,s.id,'read',s.content_hash,$5,$5 from retained s
          on conflict do nothing returning current_artifact_id
        ), binding as (
          select current_artifact_id from inserted union all
          select r.current_artifact_id from service_job_file_refs r where r.job_id=$4 and r.requested_name=$3 and not exists(select 1 from inserted)
        )
        select c.value as candidate_count,b.current_artifact_id,a.* from candidate_count c left join binding b on true left join service_artifacts a on a.id=b.current_artifact_id`,
        [job.tenantId,job.ownerUserId,requestedName,job.id,now,retainUntil]);
      const row=resolved.rows[0];
      const count=Number(row?.candidate_count??0);
      if(row?.id) {
        if(row.status!=='available'||row.tenant_id!==job.tenantId||row.owner_user_id!==job.ownerUserId)throw new InputFileError('INPUT_FILE_UNAVAILABLE',requestedName);
        return {...mapArtifactRow(row),storageKey:row.storage_key};
      }
      if(attempt===0)continue;
      if(count===0)throw new InputFileError('INPUT_FILE_NOT_FOUND',requestedName);
      if(count!==1)throw new InputFileError('INPUT_FILE_AMBIGUOUS',requestedName);
    }
    throw new InputFileError('INPUT_FILE_UNAVAILABLE',requestedName);
  }

  async resolveJobArtifact(job:ServiceJob,artifactId:string):Promise<InternalArtifact> {
    for(let attempt=0;attempt<2;attempt++) {
      const existing=await this.db.query<ArtifactRow>(`select a.* from service_job_file_refs r join service_jobs j on j.id=r.job_id join service_artifacts a on a.id=r.current_artifact_id
        where r.job_id=$1 and r.source_artifact_id=$2 and j.tenant_id=$3 and j.owner_user_id=$4`,[job.id,artifactId,job.tenantId,job.ownerUserId]);
      const existingRow=existing.rows[0];
      if(existingRow) {
        if(existingRow.status!=='available'||existingRow.tenant_id!==job.tenantId||existingRow.owner_user_id!==job.ownerUserId)throw new InputFileError('INPUT_FILE_UNAVAILABLE',artifactId);
        return {...mapArtifactRow(existingRow),storageKey:existingRow.storage_key};
      }

      const nowDate=new Date(),now=nowDate.toISOString(),retainUntil=new Date(nowDate.getTime()+this.fileReferenceRetentionMs).toISOString();
      const resolved=await this.db.query<ArtifactRow>(`with selected as materialized (
          select a.* from service_artifacts a where a.id=$2 and a.tenant_id=$3 and a.owner_user_id=$4 and a.status='available' and (a.expires_at is null or a.expires_at>now())
        ), retained as (
          update service_artifacts a set expires_at=case when a.expires_at is null then null else greatest(a.expires_at,$6::timestamptz) end,updated_at=$5
          from selected s where a.id=s.id and a.status='available' and (a.expires_at is null or a.expires_at>now()) returning a.*
        ), inserted as (
          insert into service_job_file_refs(job_id,requested_name,source_artifact_id,current_artifact_id,access_mode,source_content_hash,created_at,updated_at)
          select $1,$2,s.id,s.id,'read',s.content_hash,$5,$5 from retained s
          on conflict do nothing returning current_artifact_id
        ), binding as (
          select current_artifact_id from inserted union all
          select r.current_artifact_id from service_job_file_refs r where r.job_id=$1 and r.source_artifact_id=$2 and not exists(select 1 from inserted)
        )
        select a.* from binding b join service_artifacts a on a.id=b.current_artifact_id`,[job.id,artifactId,job.tenantId,job.ownerUserId,now,retainUntil]);
      const row=resolved.rows[0];
      if(row) {
        if(row.status!=='available'||row.tenant_id!==job.tenantId||row.owner_user_id!==job.ownerUserId)throw new InputFileError('INPUT_FILE_UNAVAILABLE',artifactId);
        return {...mapArtifactRow(row),storageKey:row.storage_key};
      }
      if(attempt===0)continue;
    }
    throw new InputFileError('INPUT_FILE_NOT_FOUND',artifactId);
  }

  async auditMaterialization(job:ServiceJob,artifactId:string|undefined,allowed:boolean):Promise<void> {
    await this.db.query(`insert into service_access_audit_records(id,tenant_id,user_id,action,target_job_id,target_artifact_id,allowed,occurred_at) values($1,$2,$3,'artifact:materialize',$4,$5,$6,now())`,
      [randomUUID(),job.tenantId,job.ownerUserId,job.id,artifactId??null,allowed]);
  }

  async reconciliationCandidates(now:string,abandonedBefore:string):Promise<InternalArtifact[]> {
    const retainAfter=new Date(new Date(now).getTime()-this.fileReferenceRetentionMs).toISOString();
    const result=await this.db.query<ArtifactRow>(`select a.* from service_artifacts a where ((a.status in ('uploading','scanning') and a.updated_at<$2) or (a.status in ('available','quarantined') and a.expires_at is not null and a.expires_at<$1))
      and not exists(select 1 from service_job_file_refs r where (r.source_artifact_id=a.id or r.current_artifact_id=a.id) and r.updated_at>$3)`,[now,abandonedBefore,retainAfter]);
    return result.rows.map(row=>({...mapArtifactRow(row),storageKey:row.storage_key}));
  }

  async deleteReconciliationCandidate(id:string,status:ArtifactStatus,now:string,abandonedBefore:string):Promise<boolean> {
    const retainAfter=new Date(new Date(now).getTime()-this.fileReferenceRetentionMs).toISOString();
    const result=await this.db.query(`update service_artifacts a set status='deleted',updated_at=$3,deleted_at=$3 where a.id=$1 and a.status=$2
      and ((a.status in ('uploading','scanning') and a.updated_at<$4) or (a.status in ('available','quarantined') and a.expires_at is not null and a.expires_at<$3))
      and not exists(select 1 from service_job_file_refs r where (r.source_artifact_id=a.id or r.current_artifact_id=a.id) and r.updated_at>$5)`,
      [id,status,now,abandonedBefore,retainAfter]);
    return result.rowCount===1;
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
  async get(key:string,maxBytes?:number):Promise<Uint8Array|undefined> {
    try {
      const response=await this.client.send(new GetObjectCommand({Bucket:this.bucket,Key:key}));
      if(!response.Body)return undefined;
      if(maxBytes===undefined)return response.Body.transformToByteArray();
      if(response.ContentLength!==undefined&&response.ContentLength>maxBytes)throw new ArtifactObjectSizeError();
      const chunks:Uint8Array[]=[];let size=0;
      for await(const chunk of response.Body as AsyncIterable<Uint8Array>) {
        size+=chunk.byteLength;if(size>maxBytes)throw new ArtifactObjectSizeError();chunks.push(chunk);
      }
      const data=new Uint8Array(size);let offset=0;
      for(const chunk of chunks) { data.set(chunk,offset);offset+=chunk.byteLength; }
      return data;
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

  async prepareInputs(job:ServiceJob,workspace:JobWorkspace):Promise<PreparedJobFiles> {
    const request=job.request as ServiceJobRequest;
    const references=request.fileRefs?.length
      ? [...new Set(request.fileRefs.map(reference=>reference.artifactId.toLowerCase()))].map(artifactId=>({artifactId}))
      : job.kind==='run'?extractTaskFilenameReferences((request as RunRequest).goal).map(requestedName=>({requestedName})):[];
    if(references.length===0)return {files:[]};
    if(references.length>this.quotas.maxFiles) {
      await this.repository.auditMaterialization(job,undefined,false);
      throw new InputFileError('INPUT_FILE_COUNT_EXCEEDED');
    }

    const pending:Array<{requestedName:string;artifact:InternalArtifact;data:Uint8Array}>=[];
    let totalBytes=0;
    for(const reference of references) {
      let artifact:InternalArtifact|undefined;
      try {
        artifact='artifactId' in reference
          ? await this.repository.resolveJobArtifact(job,reference.artifactId)
          : await this.repository.resolveJobFile(job,reference.requestedName);
        const requestedName='requestedName' in reference?reference.requestedName:artifact.filename;
        if(artifact.tenantId!==job.tenantId||artifact.ownerUserId!==job.ownerUserId)throw new InputFileError('INPUT_FILE_UNAVAILABLE',requestedName);
        if(artifact.byteSize>this.quotas.maxFileBytes)throw new InputFileError('INPUT_FILE_TOO_LARGE',requestedName);
        totalBytes+=artifact.byteSize;
        if(totalBytes>this.quotas.maxTotalBytes)throw new InputFileError('INPUT_FILE_TOTAL_BYTES_EXCEEDED');
        let data:Uint8Array|undefined;
        try { data=await this.storage.get(artifact.storageKey,artifact.byteSize); }
        catch(error) { if(error instanceof ArtifactObjectSizeError)throw new InputFileError('INPUT_FILE_INTEGRITY_ERROR',requestedName);throw error; }
        if(!data)throw new InputFileError('INPUT_FILE_UNAVAILABLE',requestedName);
        if(data.byteLength!==artifact.byteSize||createHash('sha256').update(data).digest('hex')!==artifact.contentHash)throw new InputFileError('INPUT_FILE_INTEGRITY_ERROR',requestedName);
        pending.push({requestedName,artifact,data});
      } catch(error) {
        await this.repository.auditMaterialization(job,artifact?.id,false);
        throw error;
      }
    }

    const inputs=resolve(workspace.root,'inputs');
    try { await mkdir(inputs,{recursive:false,mode:0o700}); }
    catch(error) { await this.repository.auditMaterialization(job,undefined,false);throw error; }
    const files:PreparedJobFile[]=[];
    for(const item of pending) {
      try {
        const directory=resolve(inputs,item.artifact.id);
        if(!directory.startsWith(`${inputs}${sep}`))throw new InputFileError('INPUT_FILE_UNAVAILABLE',item.requestedName);
        await mkdir(directory,{recursive:false,mode:0o700});
        const filename=sanitizeLocalFilename(item.artifact.filename);
        const destination=resolve(join(directory,filename));
        if(!destination.startsWith(`${directory}${sep}`))throw new InputFileError('INPUT_FILE_UNAVAILABLE',item.requestedName);
        const handle=await open(destination,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o400);
        try { await handle.writeFile(item.data); } finally { await handle.close(); }
        await chmod(destination,0o400);await chmod(directory,0o500);
        const relativePath=`inputs/${item.artifact.id}/${filename}`;
        files.push({artifactId:item.artifact.id,filename:item.requestedName,relativePath,mediaType:item.artifact.mediaType,byteSize:item.artifact.byteSize,contentHash:item.artifact.contentHash});
        await this.repository.auditMaterialization(job,item.artifact.id,true);
      } catch(error) {
        await this.repository.auditMaterialization(job,item.artifact.id,false);
        throw error;
      }
    }
    try { await chmod(inputs,0o500); }
    catch(error) { await this.repository.auditMaterialization(job,undefined,false);throw error; }
    files.sort((left,right)=>left.filename.localeCompare(right.filename)||left.artifactId.localeCompare(right.artifactId));
    return {files,modelContext:buildFileManifest(files)};
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
      if(!await this.repository.deleteReconciliationCandidate(row.id,row.status,now.toISOString(),options.abandonedBefore.toISOString()))continue;
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
  async prepare(job:ServiceJob,workspace:JobWorkspace):Promise<void> {
    const prepared=await this.artifacts.prepareInputs(job,workspace);
    workspace.modelContext=prepared.modelContext??(job.kind==='run'?OUTPUT_WORKSPACE_INSTRUCTION:undefined);
  }
  async close(job:ServiceJob,workspace:JobWorkspace):Promise<void> {
    try { await this.artifacts.ingest(job,workspace.artifacts,workspace.root); }
    finally {
      await makeInputsRemovable(workspace.root);
      await rm(workspace.root,{recursive:true,force:true});
    }
  }
}

export class SafeMediaArtifactScanner implements ArtifactScanner {
  async scan(input:{mediaType:string}):Promise<'clean'|'quarantined'> {
    return SAFE_MEDIA_TYPES.has(input.mediaType)||input.mediaType.startsWith('image/')?'clean':'quarantined';
  }
}

const SAFE_MEDIA_TYPES=new Set(['text/plain','text/csv','text/markdown','application/json']);
const MEDIA_TYPES:Record<string,string>={'.txt':'text/plain','.md':'text/markdown','.csv':'text/csv','.json':'application/json','.pdf':'application/pdf','.zip':'application/zip','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp'};
const INPUT_VERB=/\b(?:read|open|review|evaluate|summarize|summarise|search|inspect|analyze|analyse)\s+(?:`([^`]+)`|"([^"]+)"|'([^']+)'|([^\s,;:!?]+))/gi;
const OUTPUT_WORKSPACE_INSTRUCTION='The job workspace root is available to file tools. Write any new output artifacts under the artifacts directory.';

export interface PreparedJobFile { artifactId:string;filename:string;relativePath:string;mediaType:string;byteSize:number;contentHash:string }
export interface PreparedJobFiles { files:PreparedJobFile[];modelContext?:string }

export class InputFileError extends Error {
  readonly schemaVersion=1 as const;
  readonly retryable=false;
  constructor(readonly code:'INPUT_FILE_NOT_FOUND'|'INPUT_FILE_AMBIGUOUS'|'INPUT_FILE_UNAVAILABLE'|'INPUT_FILE_INTEGRITY_ERROR'|'INPUT_FILE_TOO_LARGE'|'INPUT_FILE_COUNT_EXCEEDED'|'INPUT_FILE_TOTAL_BYTES_EXCEEDED',requestedName?:string) {
    super(requestedName?`${code}: ${requestedName}`:code);this.name='InputFileError';
  }
}

class ArtifactObjectSizeError extends Error {}

export function extractTaskFilenameReferences(goal:string,maxFilenameLength=255):string[] {
  const names=new Set<string>();
  for(const match of goal.matchAll(INPUT_VERB)) {
    const name=(match[1]??match[2]??match[3]??match[4]??'').trim();
    if(!name||name.length>maxFilenameLength||name==='.'||name==='..'||name.includes('/')||name.includes('\\')||/[\u0000-\u001f\u007f]/.test(name))continue;
    if(!MEDIA_TYPES[extname(name).toLowerCase()])continue;
    names.add(name);
  }
  return [...names];
}

function sanitizeLocalFilename(filename:string):string {
  return filename.replace(/[^a-zA-Z0-9._ -]/g,'_').slice(0,180)||'input';
}

function buildFileManifest(files:PreparedJobFile[]):string {
  return `${OUTPUT_WORKSPACE_INSTRUCTION}\n\nFiles referenced by the task have been materialized in the job workspace.\nUse read_file when file contents are needed. Use search_files with path "inputs" when searching across the referenced files. Do not infer contents from filenames.\n\n${files.map(file=>`- ${file.filename} (${file.artifactId}): ${file.relativePath}`).join('\n')}`;
}
async function makeInputsRemovable(workspaceRoot:string):Promise<void> {
  const inputs=join(workspaceRoot,'inputs');
  try {
    for(const entry of await readdir(inputs,{withFileTypes:true}))if(entry.isDirectory())await chmod(join(inputs,entry.name),0o700);
    await chmod(inputs,0o700);
  } catch(error) {
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  }
}
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
