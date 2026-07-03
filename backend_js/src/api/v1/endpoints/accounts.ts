import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../../core/db.js';
import { requireUser, AuthenticatedRequest } from '../../../middlewares/auth.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../../core/errors.js';

export const accountsRouter = Router();

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

// 1. GET /accounts/current/members
accountsRouter.get('/current/members', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);

    const memberships = await prisma.membership.findMany({
      where: { accountId },
      include: {
        user: true,
      },
    });

    const teamMembers = memberships.map((m) => ({
      membership_id: m.id,
      user_id: m.userId,
      email: m.user.email,
      full_name: m.user.fullName,
      role: m.role.toLowerCase(),
      status: m.status.toLowerCase(),
      joined_at: m.createdAt.toISOString(),
    }));

    return res.json(teamMembers);
  } catch (err) {
    next(err);
  }
});

// 2. PATCH /accounts/current
const updateAccountSchema = z.object({
  profile_image_url: z.string().url().nullable().optional(),
});

accountsRouter.patch('/current', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const payload = updateAccountSchema.parse(req.body);

    const account = await prisma.account.findUnique({
      where: { id: accountId },
    });

    if (!account) {
      throw new NotFoundError('Account not found.');
    }

    const updated = await prisma.account.update({
      where: { id: accountId },
      data: {
        profile_image_url: payload.profile_image_url !== undefined ? payload.profile_image_url : account.profile_image_url,
      },
    });

    const userMembership = req.user.memberships?.find((m: any) => m.accountId === accountId);
    const role = userMembership ? userMembership.role.toLowerCase() : 'admin';

    return res.json({
      id: updated.id,
      name: updated.name,
      slug: updated.slug,
      role,
      token_balance: updated.tokenBalance,
      monthly_token_credit: updated.monthlyTokenCredit,
      profile_image_url: updated.profile_image_url,
    });
  } catch (err) {
    next(err);
  }
});

export default accountsRouter;
