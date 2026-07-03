import { PrismaClient } from '@prisma/client';
import { getSettings } from '../config/settings.js';

const settings = getSettings();

export const prisma = new PrismaClient({
  datasources: {
    db: {
      url: settings.database_url,
    },
  },
  log: settings.debug ? ['query', 'info', 'warn', 'error'] : ['error', 'warn'],
});
