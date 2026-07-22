import { AgentSdk } from '@adaptive-agent/agent-sdk';
import { AgentSdkWorkloadExecutor } from './agent-executor.js';
import { createArtifactManagerFromEnv, createPoolFromEnv, createServiceLogger, positiveInt, printEnvironmentIfRequested, queueRoutesFromEnv, redisConnection, reportAgentProfileWarning, reportStartupError, runBackendMigrations } from './composition.js';
import { ServiceBackendStore } from './postgres.js';
import { createBullMqWorkers } from './queue.js';
import { agentProfileResolutionPolicy, AllowlistedAgentRegistry } from './registry.js';
import { AgentWorker } from './worker.js';
import { LocalWorkspaceManager } from './workspace.js';
import { ArtifactWorkspacePolicy } from './artifacts.js';

export async function agentWorkerMain(): Promise<void> {
  const env = process.env;
  const logger = createServiceLogger('agent-worker', env);
  printEnvironmentIfRequested('agent-worker', env);
  if (!env.AGENT_REGISTRY_PATH) throw new Error('AGENT_REGISTRY_PATH is required');
  const registry = await AllowlistedAgentRegistry.load(env.AGENT_REGISTRY_PATH, agentProfileResolutionPolicy(env.AGENT_PROFILE_RESOLUTION_POLICY));
  for(const {entry,error} of await registry.validationFailures())reportAgentProfileWarning('agent-worker',entry,error);
  const pool = createPoolFromEnv(env);
  await runBackendMigrations(pool);
  const bootstrapId = env.BOOTSTRAP_AGENT_ID ?? registry.firstAgentId();
  const bootstrapConfig = await registry.resolveBootstrap(bootstrapId);
  const bootstrap = await AgentSdk.create({ agentConfig: bootstrapConfig.config.agent, env, runtimeMode: 'postgres' });
  const artifactRuntime=createArtifactManagerFromEnv(pool,env);
  const executor = new AgentSdkWorkloadExecutor(bootstrap, registry, new LocalWorkspaceManager(env.JOB_WORKSPACE_ROOT ?? './var/jobs',new ArtifactWorkspacePolicy(artifactRuntime.manager)), positiveInt(env.MAX_SUBTASKS, 4));
  const worker = new AgentWorker(new ServiceBackendStore(pool, positiveInt(env.STALE_JOB_MS, 60_000)), executor, logger);
  const bullWorkers = createBullMqWorkers(redisConnection(env), queueRoutesFromEnv(env), (payload) => worker.process(payload));
  const close = async () => {
    logger.info('process_stopping');
    await Promise.all(bullWorkers.map((queueWorker) => queueWorker.close()));
    await worker.close();
    artifactRuntime.storage.destroy();
    await pool.end();
    logger.info('process_stopped');
  };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  await Promise.all(bullWorkers.map((queueWorker) => queueWorker.waitUntilReady()));
  logger.info('process_ready', { queues: bullWorkers.length });
}
if (import.meta.main) agentWorkerMain().catch(error=>{reportStartupError('agent-worker',error);process.exitCode=1;});
