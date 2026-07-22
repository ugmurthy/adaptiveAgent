import { createPoolFromEnv,createServiceLogger,positiveInt,reportStartupError,runBackendMigrations } from './composition.js';
import { RedisEventBus } from './event-bus.js';
import { DurableEventProjector } from './projector.js';

async function main(){const env=process.env;const logger=createServiceLogger('projector',env);const pool=createPoolFromEnv(env);await runBackendMigrations(pool);const bus=env.REDIS_URL?new RedisEventBus(env.REDIS_URL):undefined;const projector=new DurableEventProjector(pool,bus,logger);let stopped=false;const stop=async()=>{logger.info('process_stopping');stopped=true;await bus?.close();await pool.end();logger.info('process_stopped');};process.once('SIGINT',stop);process.once('SIGTERM',stop);const interval=positiveInt(env.PROJECTOR_INTERVAL_MS,500);const batch=positiveInt(env.PROJECTOR_BATCH_SIZE,200);logger.info('process_ready',{eventBus:Boolean(bus)});while(!stopped){const count=await projector.projectBatch(batch);if(count<batch)await Bun.sleep(interval);}}
if(import.meta.main)main().catch(error=>{reportStartupError('projector',error);process.exitCode=1;});
