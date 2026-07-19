import {describe,expect,it} from 'vitest';
import {InMemoryEventBus} from './event-bus.js';
import {DurableEventProjector,publicCoreData} from './projector.js';

describe('public event projection',()=>{
  it('retains only safe progress scalars',()=>{
    const data=publicCoreData({run_id:'run-1',seq:7,step_id:'step-1',payload:{state:'running',toolId:'search',attempt:2,input:'secret',output:'private',error:'credential',storageKey:'bucket/key',signedUrl:'https://secret',nested:{token:'x'}}});
    expect(data).toEqual({runId:'run-1',coreSequence:7,stepId:'step-1',state:'running',toolId:'search',attempt:2});
    expect(JSON.stringify(data)).not.toContain('secret');
  });

  it('assigns monotonic sequences and does not duplicate source events',async()=>{
    const inserted:Array<{sequence:number;source:string;data:Record<string,unknown>}>=[];
    const core={job_id:'job-1',id:'42',run_id:'run-1',seq:7,step_id:'step-1',event_type:'tool.completed',payload:{toolName:'search',output:'private'},created_at:'2026-01-01T00:00:00.000Z'};
    const job={id:'job-1',state:'succeeded',command_version:1,processed_command_version:1,result:{schemaVersion:1,value:'done',completedAt:'2026-01-01T00:00:01.000Z'},error:null,updated_at:'2026-01-01T00:00:01.000Z',source_event_id:'job:state-1'};
    const query=async(sql:string)=>sql.includes('from service_job_run_links')?{rows:inserted.some(row=>row.source==='core:42')?[]:[core],rowCount:1}:sql.includes('from service_jobs j left join')?{rows:inserted.some(row=>row.source==='job:state-1')?[]:[job],rowCount:1}:{rows:[],rowCount:0};
    const client={query:async(sql:string,params?:unknown[])=>{if(sql.startsWith('select 1 from service_public_events')){const found=inserted.some(row=>row.source===params?.[1]);return{rows:found?[{}]:[],rowCount:found?1:0};}if(sql.startsWith('select coalesce'))return{rows:[{sequence:String(inserted.length+1)}],rowCount:1};if(sql.startsWith('insert into service_public_events'))inserted.push({sequence:Number(params?.[2]),data:JSON.parse(String(params?.[4])),source:String(params?.[6])});return{rows:[],rowCount:1};},release(){}};
    const bus=new InMemoryEventBus(),wakeups:any[]=[];await bus.subscribe(w=>wakeups.push(w));
    const projector=new DurableEventProjector({query,connect:async()=>client} as never,bus);
    await expect(projector.projectBatch()).resolves.toBe(2);await expect(projector.projectBatch()).resolves.toBe(0);
    expect(inserted.map(row=>[row.sequence,row.source])).toEqual([[1,'core:42'],[2,'job:state-1']]);
    expect(inserted[0].data).toEqual({runId:'run-1',coreSequence:7,stepId:'step-1',toolName:'search'});expect(wakeups).toHaveLength(2);
  });
});
