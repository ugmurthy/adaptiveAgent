#!/usr/bin/env bun

import {
  createAdaptiveAgent,
  InMemoryContinuationStore,
  InMemoryEventStore,
  InMemoryRunStore,
  InMemorySnapshotStore,
  SwarmCoordinator,
} from '../packages/core/src/index.js';

const prompt = process.argv.slice(2).join(' ') || `
Create an India market entry strategy for a premium electric two-wheeler startup launching in 2027.

Produce a board-ready recommendation covering:
1. Target customer segments and priority cities.
2. Competitive landscape.
3. Pricing and positioning.
4. Distribution model.
5. Battery, charging, warranty, and after-sales service.
6. Regulatory and incentive risks.
7. 18-month go-to-market plan.
8. Assumptions, risks, and leading indicators.
9. Final go / no-go / staged-entry recommendation.


`;

const apiKey = process.env.MESH_API_KEY;

if (!apiKey) {
  throw new Error('Set MESH_API_KEY before running this script.');
}

const runStore = new InMemoryRunStore();
const eventStore = new InMemoryEventStore();
const snapshotStore = new InMemorySnapshotStore();
const continuationStore = new InMemoryContinuationStore();

const runtime = {
  runStore,
  eventStore,
  snapshotStore,
  continuationStore,
};

function makeAgent(systemInstructions: string) {
  return createAdaptiveAgent({
    model: {
      provider: 'mesh',
      model: 'qwen/qwen3.5-27b',
      apiKey,
    },
    tools: [],
    runtime,
    systemInstructions,
    defaults:{
      modelTimeoutMs: 240000
    }
  }).agent;
}

const coordinatorAgent = makeAgent(`
You are the swarm coordinator.

Decompose the user's objective into independent text-only subtasks.

Use only these targetAgentId values:
- market-research
- competitive-analysis
- pricing-strategy
- distribution-ops
- regulatory-risk
- gtm-planning

Return structured subtasks with:
- id
- subObjective
- targetAgentId
`);

const swarm = new SwarmCoordinator({
  runStore,
  coordinatorAgent,
  workerAgents: {
    'market-research': makeAgent('You are a market research specialist. Produce concise, evidence-oriented findings.'),
    'competitive-analysis': makeAgent('You are a competitive strategy specialist. Compare competitors and tradeoffs.'),
    'pricing-strategy': makeAgent('You are a pricing and positioning specialist. Recommend clear pricing logic.'),
    'distribution-ops': makeAgent('You are a distribution and operations specialist. Focus on channels, service, and execution.'),
    'regulatory-risk': makeAgent('You are a regulatory and risk specialist. Identify policy, subsidy, and compliance risks.'),
    'gtm-planning': makeAgent('You are a go-to-market planning specialist. Build practical sequencing and milestones.'),
  },
  qualityAgent: makeAgent(`
You are the quality assessor.
Assess each worker output against the top-level objective and subtask objective.
Return structured assessments with subtaskId, usable, score, issues, and recommendation.
`),
  synthesizerAgent: makeAgent(`
You are the synthesizer.
Create a board-ready final answer from worker results and quality assessments.
Do not merely concatenate. Resolve conflicts, make tradeoffs explicit, and produce a final recommendation.
`),
  defaultMaxWorkers: 3,
});
console.log("Initiating swarm run")
const result = await swarm.run({
  sessionId: `swarm-${Date.now()}`,
  topLevelObjective: prompt,
  maxWorkers: 3,
});

console.log(JSON.stringify(result, null, 2));

console.log('\n--- Session runs ---');
const sessionRuns = await runStore.listBySession(result.sessionId);
console.log(
  JSON.stringify(
    sessionRuns.map((run) => ({
      id: run.id,
      sessionId: run.sessionId,
      rootRunId: run.rootRunId,
      parentRunId: run.parentRunId,
      status: run.status,
      role:
        typeof run.metadata?.orchestration === 'object' && run.metadata.orchestration !== null
          ? run.metadata.orchestration.role
          : undefined,
      subtaskId:
        typeof run.metadata?.orchestration === 'object' && run.metadata.orchestration !== null
          ? run.metadata.orchestration.subtaskId
          : undefined,
    })),
    null,
    2,
  ),
);
