import { Router, Response, NextFunction } from 'express';
import { prisma } from '../../../core/db.js';
import { requireUser, AuthenticatedRequest } from '../../../middlewares/auth.js';
import { BadRequestError, ForbiddenError } from '../../../core/errors.js';

export const observabilityRouter = Router();

// Helper: resolve account context
const getAccountId = (req: AuthenticatedRequest): number => {
  const header = req.headers['x-account-id'];
  if (!header) {
    throw new BadRequestError('Missing X-Account-ID header.');
  }
  const accountId = parseInt(header as string, 10);
  if (isNaN(accountId)) {
    throw new BadRequestError('Invalid X-Account-ID header.');
  }
  const hasAccess = req.user.userRole === 'OWNER' || req.user.userRole === 'SUPER_ADMIN' ||
    (req.user.memberships || []).some((m: any) => m.accountId === accountId && m.status === 'ACTIVE');

  if (!hasAccess) {
    throw new ForbiddenError('You do not have access to this account.');
  }
  return accountId;
};

// Helper: parse pagination query params
const parsePagination = (req: AuthenticatedRequest) => {
  const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
  const pageSize = req.query.page_size ? parseInt(req.query.page_size as string, 10) : 20;
  return { page, pageSize };
};

// 1. GET /observability/action-usage-logs
observabilityRouter.get('/action-usage-logs', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const { page, pageSize } = parsePagination(req);

    const where = { account_id: accountId };
    const items = await prisma.action_usage_logs.findMany({
      where,
      orderBy: { occurred_at: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    const total = await prisma.action_usage_logs.count({ where });

    return res.json({
      items: items.map((row) => ({
        ...row,
        action_type: row.action_type.toLowerCase(),
        platform_type: row.platform_type ? row.platform_type.toLowerCase() : null,
      })),
      total,
      page,
      page_size: pageSize,
    });
  } catch (err) {
    next(err);
  }
});

// 2. GET /observability/llm-token-usage
observabilityRouter.get('/llm-token-usage', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const { page, pageSize } = parsePagination(req);

    const where = { account_id: accountId };
    const items = await prisma.llm_token_usage.findMany({
      where,
      orderBy: { used_at: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    const total = await prisma.llm_token_usage.count({ where });

    return res.json({
      items,
      total,
      page,
      page_size: pageSize,
    });
  } catch (err) {
    next(err);
  }
});

// 3. GET /observability/audit-logs
observabilityRouter.get('/audit-logs', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const { page, pageSize } = parsePagination(req);

    const where = { account_id: accountId };
    const items = await prisma.audit_logs.findMany({
      where,
      orderBy: { occurred_at: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    const total = await prisma.audit_logs.count({ where });

    return res.json({
      items: items.map((row) => ({
        ...row,
        action_type: row.action_type.toLowerCase(),
        resource_type: row.resource_type.toLowerCase(),
      })),
      total,
      page,
      page_size: pageSize,
    });
  } catch (err) {
    next(err);
  }
});

export default observabilityRouter;
