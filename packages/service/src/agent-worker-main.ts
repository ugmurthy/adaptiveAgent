import { AgentSdk } from '@adaptive-agent/agent-sdk';
import { AgentSdkWorkloadExecutor } from './agent-executor.js';
import { createArtifactManagerFromEnv, createPoolFromEnv, positiveInt, printEnvironmentIfRequested, queueRoutesFromEnv, redisConnection, runBackendMigrations } from './composition.js';
import { ServiceBackendStore } from './postgres.js';
import { createBullMqWorkers } from './queue.js';
import { agentProfileResolutionPolicy, AllowlistedAgentRegistry } from './registry.js';
import { AgentWorker } from './worker.js';
import { LocalWorkspaceManager } from './workspace.js';
import { ArtifactWorkspacePolicy } from './artifacts.js';

export async function agentWorkerMain(): Promise<void> {
  const env = process.env;
  printEnvironmentIfRequested('agent-worker', env);
  const pool = createPoolFromEnv(env);
  await runBackendMigrations(pool);
  if (!env.AGENT_REGISTRY_PATH) throw new Error('AGENT_REGISTRY_PATH is required');
  const registry = await AllowlistedAgentRegistry.load(env.AGENT_REGISTRY_PATH, agentProfileResolutionPolicy(env.AGENT_PROFILE_RESOLUTION_POLICY));
  const bootstrapId = env.BOOTSTRAP_AGENT_ID ?? registry.firstAgentId();
  const bootstrapConfig = await registry.resolveBootstrap(bootstrapId);
  const bootstrap = await AgentSdk.create({ agentConfig: bootstrapConfig.config.agent, env, runtimeMode: 'postgres' });
  const artifactRuntime=createArtifactManagerFromEnv(pool,env);
  const executor = new AgentSdkWorkloadExecutor(bootstrap, registry, new LocalWorkspaceManager(env.JOB_WORKSPACE_ROOT ?? './var/jobs',new ArtifactWorkspacePolicy(artifactRuntime.manager)), positiveInt(env.MAX_SUBTASKS, 4));
  const worker = new AgentWorker(new ServiceBackendStore(pool, positiveInt(env.STALE_JOB_MS, 60_000)), executor);
  const bullWorkers = createBullMqWorkers(redisConnection(env), queueRoutesFromEnv(env), (payload) => worker.process(payload));
  const close = async () => {
    await Promise.all(bullWorkers.map((queueWorker) => queueWorker.close()));
    await worker.close();
    artifactRuntime.storage.destroy();
    await pool.end();
  };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  await Promise.all(bullWorkers.map((queueWorker) => queueWorker.waitUntilReady()));
}
if (import.meta.main) await agentWorkerMain();
