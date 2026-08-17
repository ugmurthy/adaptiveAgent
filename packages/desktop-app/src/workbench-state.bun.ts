import { describe, expect, it } from 'bun:test';
import type { Chat, RunSummary } from './desktop';
import { buildRailItems, filterRailItems, normalizeWorkbenchSelection } from './workbench-state';

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return { itemId:'task',runId:'run',title:'Task',createdAt:'100',invocationKind:'run',status:'succeeded',cancelRequested:false,occupiesSlot:false,steerable:false,artifactsAvailable:true,...overrides };
}

describe('workbench rail grouping', () => {
  it('validates restored window selections and rejects stale shapes', () => {
    expect(normalizeWorkbenchSelection({ kind: 'task', itemId: 'item', runId: 'run' })).toEqual({ kind: 'task', itemId: 'item', runId: 'run' });
    expect(normalizeWorkbenchSelection({ kind: 'chat', itemId: 'chat' })).toEqual({ kind: 'chat', itemId: 'chat' });
    expect(normalizeWorkbenchSelection({ kind: 'task', itemId: 'item' })).toEqual({ kind: 'new-task' });
    expect(normalizeWorkbenchSelection({ kind: 'unknown' })).toEqual({ kind: 'new-task' });
  });
  it('deduplicates attempts and prioritizes input, active work, then history', () => {
    const runs = [
      run({runId:'old'}),
      run({runId:'approval',pendingApproval:{rootRunId:'approval',approvalRunId:'child',approvalId:'a',toolName:'shell',message:'Allow?',decisionInFlight:false}}),
      run({itemId:'active',runId:'active',title:'Active task',status:'running',occupiesSlot:true}),
      run({itemId:'history',runId:'history',title:'Past task'}),
    ];
    const items=buildRailItems(runs,[]);
    expect(items.map(({id,group})=>[id,group])).toEqual([['active','Active'],['task','Needs input'],['history','History']]);
    expect(items.filter((item)=>item.id==='task')).toHaveLength(1);
    expect(items.find((item)=>item.id==='task')?.runId).toBe('approval');
  });

  it('includes empty and active chats without inventing task entries', () => {
    const chats=[{itemId:'chat',title:'Conversation',createdAt:'100',sessionId:'session',pinnedAgentId:'agent',pinnedAgentName:'Agent',pinnedAgentFingerprint:'fp',messages:[],occupied:false}] satisfies Chat[];
    expect(buildRailItems([],chats)).toMatchObject([{id:'chat',kind:'chat',status:'ready',group:'History'}]);
    expect(buildRailItems([run({itemId:'chat',invocationKind:'chat',status:'running',occupiesSlot:true})],chats)[0]).toMatchObject({id:'chat',group:'Active',status:'running'});
  });

  it('sorts history newest first and filters partial terms in task and chat text', () => {
    const chats=[{itemId:'chat',title:'Release notes',createdAt:'200',sessionId:'session',pinnedAgentId:'agent',pinnedAgentName:'Agent',pinnedAgentFingerprint:'fp',messages:[{id:'m',ordinal:0,role:'user',content:'Investigate websocket reconnect behavior'}],occupied:false}] satisfies Chat[];
    const items=buildRailItems([run({itemId:'older',title:'Database migration',createdAt:'100'})],chats);
    expect(items.map((item)=>item.id)).toEqual(['chat','older']);
    expect(filterRailItems(items,'websock recon')).toHaveLength(1);
    expect(filterRailItems(items,'BASE migr')[0]?.id).toBe('older');
    expect(filterRailItems(items,'missing')).toEqual([]);
  });
});
