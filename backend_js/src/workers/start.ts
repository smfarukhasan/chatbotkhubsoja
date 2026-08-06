import './processor.js';
import { logger } from '../core/logging.js';
import { prisma } from '../core/db.js';

async function main() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    logger.info('Worker database connection verified.');
    logger.info('🤖 Webhook worker running — processing webhooks queue.');
  } catch (error) {
    logger.error('Worker bootstrap failed:', error);
    process.exit(1);
  }
}

main();

const shutdown = async () => {
  logger.info('Stopping worker...');
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
