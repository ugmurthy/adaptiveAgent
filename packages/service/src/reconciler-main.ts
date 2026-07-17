import { BullMqPublisher } from './queue.js';
import { createPoolFromEnv, positiveInt, queueRoutesFromEnv, redisConnection, runBackendMigrations } from './composition.js';
import { ServiceBackendStore } from './postgres.js';
import { StaleJobReconciler } from './reconciler.js';

export async function reconcilerMain(): Promise<void> {
  const pool = createPoolFromEnv();
  await runBackendMigrations(pool);
  const publisher = new BullMqPublisher(redisConnection(), queueRoutesFromEnv());
  const store = new ServiceBackendStore(pool, positiveInt(process.env.STALE_JOB_MS, 60_000));
  const reconciler = new StaleJobReconciler(store, publisher, positiveInt(process.env.RECONCILE_INTERVAL_MS, 10_000));
  const close = async () => { await reconciler.close(); await pool.end(); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  await reconciler.start();
}
if (import.meta.main) await reconcilerMain();
