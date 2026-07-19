import { BullMqPublisher } from './queue.js';
import { createArtifactManagerFromEnv, createPoolFromEnv, positiveInt, queueRoutesFromEnv, redisConnection, runBackendMigrations } from './composition.js';
import { ServiceBackendStore } from './postgres.js';
import { StaleJobReconciler } from './reconciler.js';

export async function reconcilerMain(): Promise<void> {
  const pool = createPoolFromEnv();
  await runBackendMigrations(pool);
  const publisher = new BullMqPublisher(redisConnection(), queueRoutesFromEnv());
  const store = new ServiceBackendStore(pool, positiveInt(process.env.STALE_JOB_MS, 60_000));
  const artifactRuntime=createArtifactManagerFromEnv(pool);
  const artifactStaleMs=positiveInt(process.env.ARTIFACT_ABANDONED_UPLOAD_MS,60*60*1000);
  const reconciler = new StaleJobReconciler(store, publisher, positiveInt(process.env.RECONCILE_INTERVAL_MS, 10_000),100,async()=>{
    const now=new Date();
    await artifactRuntime.manager.reconcile({now,abandonedBefore:new Date(now.getTime()-artifactStaleMs),orphanBefore:new Date(now.getTime()-artifactStaleMs)});
  });
  const close = async () => { await reconciler.close(); artifactRuntime.storage.destroy(); await pool.end(); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  await reconciler.start();
}
if (import.meta.main) await reconcilerMain();
