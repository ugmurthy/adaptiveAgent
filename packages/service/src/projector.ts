import type { Pool } from 'pg';
import type { EventBus,EventWakeup } from './event-bus.js';

const SAFE_SCALARS=new Set(['state','status','phase','stepId','step_id','toolId','tool_id','toolName','tool_name','toolExecutionId','tool_execution_id','planId','plan_id','planStepId','plan_step_id','attempt','progress','percent','role']);
export function publicCoreData(row:{run_id:string;seq:number;step_id?:string|null;payload?:unknown}):Record<string,string|number|boolean|null> {
  const data:Record<string,string|number|boolean|null>={runId:row.run_id,coreSequence:Number(row.seq)};
  if(row.step_id)data.stepId=row.step_id;
  if(row.payload&&typeof row.payload==='object'&&!Array.isArray(row.payload)) for(const [key,value] of Object.entries(row.payload)) if(SAFE_SCALARS.has(key)&&(value===null||['string','number','boolean'].includes(typeof value))) data[key]=value as string|number|boolean|null;
  return data;
}

export class DurableEventProjector {
  constructor(private readonly pool:Pool,private readonly bus?:EventBus) {}
  async projectBatch(limit=100):Promise<number> {
    const candidates=await this.pool.query<any>(`select l.job_id,e.id,e.run_id,e.seq,e.step_id,e.event_type,e.payload,e.created_at from service_job_run_links l join agent_events e on e.run_id=l.run_id left join service_public_events p on p.job_id=l.job_id and p.source_event_id='core:'||e.id::text where p.id is null order by e.id limit $1`,[limit]);
    const jobs=await this.pool.query<any>(`select j.id,j.state,j.command_version,j.processed_command_version,j.result,j.error,j.updated_at,('job:'||j.updated_at::text||':'||j.state||':'||j.command_version::text||':'||j.processed_command_version::text) as source_event_id from service_jobs j left join service_public_events p on p.job_id=j.id and p.source_event_id=('job:'||j.updated_at::text||':'||j.state||':'||j.command_version::text||':'||j.processed_command_version::text) where p.id is null order by j.updated_at limit $1`,[limit]);
    const artifacts=await this.pool.query<any>(`select 'artifact' as projection_kind,a.id,a.job_id,a.run_id,a.tool_execution_id,a.original_filename,a.media_type,a.byte_size,a.content_hash,a.status,a.created_at,a.available_at,a.expires_at,a.updated_at,('artifact:'||a.id::text||':'||a.status) as source_event_id from service_artifacts a left join service_public_events p on p.job_id=a.job_id and p.source_event_id=('artifact:'||a.id::text||':'||a.status) where a.status in ('available','quarantined') and p.id is null order by a.updated_at limit $1`,[limit]);
    let count=0;
    for(const row of [...candidates.rows,...jobs.rows,...artifacts.rows]) { const wake=await this.insert(row);if(wake){count++;await this.bus?.publish(wake);} }
    return count;
  }
  private async insert(row:any):Promise<EventWakeup|undefined> {
    const client=await this.pool.connect();
    try { await client.query('begin');await client.query('select id from service_jobs where id=$1 for update',[row.job_id??row.id]);
      const artifact=row.projection_kind==='artifact',core=!artifact&&row.run_id!==undefined;const jobId=core||artifact?row.job_id:row.id;
      const source=core?`core:${row.id}`:row.source_event_id;
      const existing=await client.query('select 1 from service_public_events where job_id=$1 and source_event_id=$2',[jobId,source]);if(existing.rowCount){await client.query('commit');return;}
      const next=await client.query<{sequence:string}>('select coalesce(max(sequence),0)+1 as sequence from service_public_events where job_id=$1',[jobId]);const sequence=Number(next.rows[0].sequence);
      const data=artifact?artifactData(row):core?publicCoreData(row):jobData(row);
      await client.query('insert into service_public_events(id,job_id,sequence,event_type,data,occurred_at,source_event_id) values($1,$2,$3,$4,$5,$6,$7)',[crypto.randomUUID(),jobId,sequence,artifact?`artifact.${row.status}`:core?row.event_type:'job.state_changed',JSON.stringify(data),artifact?row.updated_at:core?row.created_at:row.updated_at,source]);
      await client.query('commit');return {jobId,sequence};
    } catch(error){await client.query('rollback');throw error;} finally{client.release();}
  }
}
function jobData(row:any){const data:any={state:row.state,commandVersion:Number(row.command_version),processedCommandVersion:Number(row.processed_command_version)};if(row.state==='succeeded'&&row.result)data.result=row.result;if(row.state==='failed'&&row.error)data.error=row.error;return data;}
function artifactData(row:any){return {artifactId:row.id,runId:row.run_id??undefined,toolExecutionId:row.tool_execution_id??undefined,filename:row.original_filename,mediaType:row.media_type,byteSize:Number(row.byte_size),contentHash:row.content_hash,status:row.status,createdAt:row.created_at,availableAt:row.available_at??undefined,expiresAt:row.expires_at??undefined};}
