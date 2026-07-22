import { BullMqPublisher } from './queue.js';
import { createPoolFromEnv, createServiceLogger, positiveInt, queueRoutesFromEnv, redisConnection, reportStartupError, runBackendMigrations } from './composition.js';
import { ServiceBackendStore } from './postgres.js';
import { OutboxDispatcher } from './dispatcher.js';

export async function dispatcherMain(): Promise<void> {
  const logger = createServiceLogger('dispatcher');
  const pool = createPoolFromEnv();
  await runBackendMigrations(pool);
  const publisher = new BullMqPublisher(redisConnection(), queueRoutesFromEnv());
  const dispatcher = new OutboxDispatcher(new ServiceBackendStore(pool), publisher, positiveInt(process.env.DISPATCH_INTERVAL_MS, 500), 50, logger);
  const close = async () => { logger.info('process_stopping'); await dispatcher.close(); await pool.end(); logger.info('process_stopped'); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  logger.info('process_ready');
  await dispatcher.start();
}
if (import.meta.main) dispatcherMain().catch(error=>{reportStartupError('dispatcher',error);process.exitCode=1;});
