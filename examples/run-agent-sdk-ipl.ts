#!/usr/bin/env bun

import { createAgentSdk } from '../packages/agent-sdk/src/index.js';

const task = process.argv.slice(2).join(' ').trim();

if (!task) {
  console.error('Usage: bun run examples/run-agent-sdk-ipl.ts <task description>');
  console.error('Example: bun run examples/run-agent-sdk-ipl.ts summarize the latest IPL points table');
  process.exit(1);
}

const agent = await createAgentSdk({
  agentConfigPath: '~/.adaptiveAgent/agents/ipl-agent.json',
});

try {
  const result = await agent.run(task);

  console.log(`Run status: ${result.status}`);
  console.log(`Run ID: ${result.runId}`);

  if (result.output) {
    console.log('');
    console.log(result.output);
  } else {
    console.log('');
    console.log(JSON.stringify(result, null, 2));
  }
} finally {
  await agent.close();
}
