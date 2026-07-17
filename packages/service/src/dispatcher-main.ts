import { BullMqPublisher } from './queue.js';
import { createPoolFromEnv, positiveInt, queueRoutesFromEnv, redisConnection, runBackendMigrations } from './composition.js';
import { ServiceBackendStore } from './postgres.js';
import { OutboxDispatcher } from './dispatcher.js';

export async function dispatcherMain(): Promise<void> {
  const pool = createPoolFromEnv();
  await runBackendMigrations(pool);
  const publisher = new BullMqPublisher(redisConnection(), queueRoutesFromEnv());
  const dispatcher = new OutboxDispatcher(new ServiceBackendStore(pool), publisher, positiveInt(process.env.DISPATCH_INTERVAL_MS, 500));
  const close = async () => { await dispatcher.close(); await pool.end(); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  await dispatcher.start();
}
if (import.meta.main) await dispatcherMain();
