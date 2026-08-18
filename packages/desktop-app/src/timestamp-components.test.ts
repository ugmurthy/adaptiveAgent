// @vitest-environment jsdom

import { afterEach, describe, expect, test } from 'vitest';
import { mount, unmount } from 'svelte';
import RunInspector from './RunInspector.svelte';
import WorkbenchRail from './WorkbenchRail.svelte';
import type { DesktopState, TracePrivacy } from './desktop';
import { formatTimestamp } from './timestamp';

const mounted: Array<ReturnType<typeof mount>> = [];

afterEach(async () => {
  while (mounted.length) await unmount(mounted.pop()!);
  document.body.replaceChildren();
});

describe('timestamp rendering boundaries', () => {
  test('renders ISO, epoch strings, blanks, and invalid rail values without throwing', () => {
    const target = document.createElement('div');
    document.body.append(target);
    const component = mount(WorkbenchRail, { target, props: {
      items: [
        { id:'iso', kind:'task', title:'ISO', searchableText:'', createdAt:'2026-08-17T12:34:56.789Z', status:'succeeded', group:'History', runId:'iso' },
        { id:'epoch', kind:'task', title:'Epoch', searchableText:'', createdAt:'1786970096789', status:'succeeded', group:'History', runId:'epoch' },
        { id:'blank', kind:'task', title:'Blank', searchableText:'', createdAt:'', status:'succeeded', group:'History', runId:'blank' },
        { id:'invalid', kind:'task', title:'Invalid', searchableText:'', createdAt:'not-a-date', status:'succeeded', group:'History', runId:'invalid' },
      ],
      selection: { kind: 'new-task' },
      onselect: () => undefined,
      onnewtask: () => undefined,
      onartifacts: () => undefined,
      onsettings: () => undefined,
      onclose: () => undefined,
    }});
    mounted.push(component);

    expect(target.textContent).toContain(formatTimestamp('1786970096789', { dateStyle: 'medium' }));
    expect(target.textContent).toContain('Earlier');
  });

  test('renders invalid inspector timestamps with the stable fallback', () => {
    const target = document.createElement('div');
    document.body.append(target);
    const desktop: DesktopState = {
      agentId:'agent', status:'ready', configurationValid:true, runs:[], occupiedSlotCount:0,
      capacity:3, executionHealth:'ready', traceHealth:'ready', quitState:'idle',
    };
    const privacy: TracePrivacy = { messages:false, reasoning:false, rawToolPayloads:false };
    const component = mount(RunInspector, { target, props: {
      desktop,
      root:'run-id',
      report:{ rootRuns:[{ rootRunId:'run-id', runId:'run-id', startedAt:'not-a-date', completedAt:'' }] },
      privacy,
      onprivacy: () => undefined,
      onclose: () => undefined,
    }});
    mounted.push(component);

    expect(target.textContent?.match(/Not recorded/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
