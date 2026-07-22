import { BullMqPublisher } from './queue.js';
import { createArtifactManagerFromEnv, createPoolFromEnv, createServiceLogger, positiveInt, queueRoutesFromEnv, redisConnection, reportStartupError, runBackendMigrations } from './composition.js';
import { ServiceBackendStore } from './postgres.js';
import { StaleJobReconciler } from './reconciler.js';

export async function reconcilerMain(): Promise<void> {
  const logger = createServiceLogger('reconciler');
  const pool = createPoolFromEnv();
  await runBackendMigrations(pool);
  const publisher = new BullMqPublisher(redisConnection(), queueRoutesFromEnv());
  const store = new ServiceBackendStore(pool, positiveInt(process.env.STALE_JOB_MS, 60_000));
  const artifactRuntime=createArtifactManagerFromEnv(pool);
  const artifactStaleMs=positiveInt(process.env.ARTIFACT_ABANDONED_UPLOAD_MS,60*60*1000);
  const reconciler = new StaleJobReconciler(store, publisher, positiveInt(process.env.RECONCILE_INTERVAL_MS, 10_000),100,async()=>{
    const now=new Date();
    await artifactRuntime.manager.reconcile({now,abandonedBefore:new Date(now.getTime()-artifactStaleMs),orphanBefore:new Date(now.getTime()-artifactStaleMs)});
  },logger);
  const close = async () => { logger.info('process_stopping'); await reconciler.close(); artifactRuntime.storage.destroy(); await pool.end(); logger.info('process_stopped'); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  logger.info('process_ready');
  await reconciler.start();
}
if (import.meta.main) reconcilerMain().catch(error=>{reportStartupError('reconciler',error);process.exitCode=1;});
