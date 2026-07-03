import { app } from './app.js';
import { getSettings } from './config/settings.js';
import { logger } from './core/logging.js';
import { prisma } from './core/db.js';

const settings = getSettings();
const PORT = process.env.PORT || 8000;

async function bootstrap() {
  try {
    // Test Database connection on start
    logger.info('Verifying database connection...');
    await prisma.$queryRaw`SELECT 1`;
    logger.info('Database connection verified successfully.');

    const server = app.listen(PORT, () => {
      logger.info(`🚀 JS Backend running on port ${PORT}`);
      logger.info(`Environment: ${settings.environment}`);
      logger.info(`API Prefix: ${settings.api_v1_prefix}`);
    });

    // Graceful shutdown
    const shutdown = async () => {
      logger.info('Shutting down server...');
      server.close(async () => {
        logger.info('Server closed. Disconnecting database...');
        await prisma.$disconnect();
        logger.info('Database disconnected. Exit.');
        process.exit(0);
      });
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    
  } catch (error) {
    logger.error('Database connection failed or Server bootstrap crashed:', error);
    process.exit(1);
  }
}

bootstrap();
