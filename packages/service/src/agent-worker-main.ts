import { AgentSdk } from '@adaptive-agent/agent-sdk';
import { AgentSdkWorkloadExecutor } from './agent-executor.js';
import { createPoolFromEnv, positiveInt, queueRoutesFromEnv, redisConnection, runBackendMigrations } from './composition.js';
import { ServiceBackendStore } from './postgres.js';
import { createBullMqWorkers } from './queue.js';
import { AllowlistedAgentRegistry } from './registry.js';
import { AgentWorker } from './worker.js';
import { LocalWorkspaceManager } from './workspace.js';

export async function agentWorkerMain(): Promise<void> {
  const pool = createPoolFromEnv();
  await runBackendMigrations(pool);
  if (!process.env.AGENT_REGISTRY_PATH) throw new Error('AGENT_REGISTRY_PATH is required');
  const registry = await AllowlistedAgentRegistry.load(process.env.AGENT_REGISTRY_PATH);
  const bootstrapId = process.env.BOOTSTRAP_AGENT_ID ?? registry.firstAgentId();
  const bootstrapConfig = await registry.resolveBootstrap(bootstrapId);
  const bootstrap = await AgentSdk.create({ agentConfig: bootstrapConfig.config.agent, env: process.env, runtimeMode: 'postgres' });
  const executor = new AgentSdkWorkloadExecutor(bootstrap, registry, new LocalWorkspaceManager(process.env.JOB_WORKSPACE_ROOT ?? './var/jobs'), positiveInt(process.env.MAX_SUBTASKS, 4));
  const worker = new AgentWorker(new ServiceBackendStore(pool, positiveInt(process.env.STALE_JOB_MS, 60_000)), executor);
  const bullWorkers = createBullMqWorkers(redisConnection(), queueRoutesFromEnv(), (payload) => worker.process(payload));
  const close = async () => {
    await Promise.all(bullWorkers.map((queueWorker) => queueWorker.close()));
    await worker.close();
    await pool.end();
  };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  await Promise.all(bullWorkers.map((queueWorker) => queueWorker.waitUntilReady()));
}
if (import.meta.main) await agentWorkerMain();
