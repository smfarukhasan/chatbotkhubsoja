import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { getSettings } from '../config/settings.js';
import { logger } from '../core/logging.js';

const settings = getSettings();

// Connect to Redis for BullMQ
let redisConnection: Redis;

try {
  redisConnection = new Redis(settings.redis_url, {
    maxRetriesPerRequest: null, // Required by BullMQ
  });
  
  redisConnection.on('error', (err: any) => {
    logger.error('Redis Connection Error:', err);
  });
} catch (err) {
  logger.error('Failed to initialize Redis connection for queues:', err);
}

export const createQueue = (name: string) => {
  return new Queue(name, {
    connection: redisConnection as any,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
      removeOnComplete: true,
      removeOnFail: false,
    },
  });
};

// Define standard queues matching python celery queues
export const defaultQueue = createQueue('default');
export const webhooksQueue = createQueue('webhooks');
export const syncQueue = createQueue('sync');
export const maintenanceQueue = createQueue('maintenance');
export const messagesQueue = createQueue('messages');
export const commentsQueue = createQueue('comments');
export const postsQueue = createQueue('posts');

logger.info('Initialized BullMQ queues successfully');
export { redisConnection };
