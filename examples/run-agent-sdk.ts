#!/usr/bin/env bun
import { createAgentSdk } from '../packages/agent-sdk/src/index.js';

const agent = await createAgentSdk({
  runtimeMode: 'memory',
  agentConfig: {
    id: 'ollama-run-example',
    name: 'Ollama Run Example',
    invocationModes: ['run'],
    defaultInvocationMode: 'run',
    model: {
      provider: 'ollama',
      model: 'qwen3.5:latest',
    },
    tools: ['read_file', 'write_file','list_directory'],
  },
});

console.log('Agent SDK created');
console.log(`Agent config:  ${JSON.stringify(agent.config,null,2)}`);

try {
  const result = await agent.run(process.argv.slice(2).join(' ') || 'List the files in this project and summarize what you see.');
  console.log(JSON.stringify(result, null, 2));
  console.log("\n-----------\n")
  console.log(result.output)
} finally {
  await agent.close();
}
