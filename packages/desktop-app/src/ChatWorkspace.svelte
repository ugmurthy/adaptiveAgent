<script lang="ts">
  import type { ActivityEvent } from './activity';
  import type { Chat, RunSummary } from './desktop';
  import ActivityNarrative from './ActivityNarrative.svelte';
  import ApprovalCard from './ApprovalCard.svelte';
  import ResultRenderer from './ResultRenderer.svelte';

  export let chat: Chat;
  export let runs: RunSummary[] = [];
  export let activity: ActivityEvent[] = [];
  export let now = Date.now();
  export let message = '';
  export let error = '';
  export let pending = false;
  export let capacityAvailable = true;
  export let onsend: () => void;
  export let onstop: (runId: string) => void;
  export let ondelete: (target: {kind:'item';itemId:string}|{kind:'chat-turn';itemId:string;ordinal:number}) => void;
  export let ondecision: (run: RunSummary, approved: boolean) => void;
  export let oninspect: () => void;
  export let onshowtitle: (kind: 'task' | 'chat', title: string) => void;
  $: activeRun = runs.find((run)=>run.occupiesSlot);
</script>

<section class="center-card chat-view">
  <div class="view-heading">
    <div><span>Chat · {chat.pinnedAgentName}</span><h2><button class="title-trigger" aria-label="View full chat description" on:click={() => onshowtitle('chat', chat.title)}>{chat.title}</button></h2><p>Session {chat.sessionId.slice(0,8)} · {chat.occupied?'Turn in progress':'Ready'}</p></div>
    <div class="heading-actions"><button on:click={oninspect}>Inspector</button><button class="danger ghost" disabled={pending || chat.occupied} on:click={()=>ondelete({kind:'item',itemId:chat.itemId})}>Delete chat</button></div>
  </div>
  {#if chat.readOnlyReason}<div class="alert">{chat.readOnlyReason}</div>{/if}
  {#if activeRun}<div class="context-actions"><button disabled={pending} on:click={()=>onstop(activeRun.runId)}>{activeRun.cancelRequested?'Retry stop':'Stop turn'}</button></div>{/if}
  {#each runs.filter((run)=>run.pendingApproval) as run}<ApprovalCard {run} {pending} {ondecision}/>{/each}
  <div class="conversation" aria-live="polite">
    {#if !chat.messages.length}<div class="empty-state"><strong>Start the conversation</strong><p>Each turn includes the complete prior transcript.</p></div>{/if}
    {#each chat.messages as item (item.id)}
      <article class:assistant={item.role==='assistant'}>
        <header><strong>{item.role==='assistant'?chat.pinnedAgentName:'You'}</strong>{#if item.role==='user'}<button disabled={pending || chat.occupied} on:click={()=>ondelete({kind:'chat-turn',itemId:chat.itemId,ordinal:item.ordinal})}>Delete from here</button>{/if}</header>
        {#if item.role==='assistant'}<ResultRenderer value={item.content}/>{:else}<p>{item.content}</p>{/if}
      </article>
    {/each}
  </div>
  <ActivityNarrative events={activity} {now}/>
  {#if error}<div class="result error"><pre>{error}</pre></div>{/if}
  <div class="message-composer"><label for="chat-message">Message</label><textarea id="chat-message" bind:value={message} disabled={!!chat.readOnlyReason || chat.occupied}></textarea><div class="actions"><button class="primary" disabled={!message.trim() || !!chat.readOnlyReason || chat.occupied || pending || !capacityAvailable} on:click={onsend}>Send</button><span class="run-status">{capacityAvailable?'Ready to send':'All execution slots are occupied'}</span></div></div>
</section>
