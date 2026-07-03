import { Router, Request, Response } from 'express';
import { prisma } from '../../../core/db.js';
import { getSettings } from '../../../config/settings.js';

export const healthRouter = Router();
const settings = getSettings();

healthRouter.get('/', async (req: Request, res: Response) => {
  let databaseStatus = 'up';
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    databaseStatus = 'down';
  }

  const isOk = databaseStatus === 'up';

  return res.status(isOk ? 200 : 500).json({
    status: isOk ? 'ok' : 'degraded',
    database: databaseStatus,
    version: settings.app_version,
  });
});

export default healthRouter;
