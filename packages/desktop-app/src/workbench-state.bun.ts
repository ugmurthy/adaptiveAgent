import { describe, expect, it } from 'bun:test';
import type { Chat, RunSummary } from './desktop';
import { buildRailItems } from './workbench-state';

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return { itemId:'task',runId:'run',title:'Task',invocationKind:'run',status:'succeeded',cancelRequested:false,occupiesSlot:false,...overrides };
}

describe('workbench rail grouping', () => {
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
    const chats=[{itemId:'chat',title:'Conversation',sessionId:'session',pinnedAgentId:'agent',pinnedAgentName:'Agent',pinnedAgentFingerprint:'fp',messages:[],occupied:false}] satisfies Chat[];
    expect(buildRailItems([],chats)).toMatchObject([{id:'chat',kind:'chat',status:'ready',group:'History'}]);
    expect(buildRailItems([run({itemId:'chat',invocationKind:'chat',status:'running',occupiesSlot:true})],chats)[0]).toMatchObject({id:'chat',group:'Active',status:'running'});
  });
});
