import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../../core/db.js';
import { requireUser, AuthenticatedRequest } from '../../../middlewares/auth.js';
import { BadRequestError, ForbiddenError, NotFoundError, ConflictError } from '../../../core/errors.js';
import { hashPassword } from '../../../core/security.js';
import { UserRole, UserStatus, memberships_role, MembershipStatus } from '@prisma/client';

import { resolveUserPermissions } from './auth.js';

export const usersRouter = Router();

// Helper: build managed user response
const buildManagedUserResponse = async (user: any) => {
  const membership = user.memberships.find(
    (m: any) => m.status !== 'REVOKED' && m.account.isActive
  ) || user.memberships[0] || null;

  const resolvedPerms = await resolveUserPermissions(user);

  return {
    id: user.id,
    email: user.email,
    full_name: user.fullName,
    status: user.status.toLowerCase(),
    user_role: user.userRole === 'SUPER_ADMIN' ? 'superAdmin' : user.userRole.toLowerCase().replace('_superuser', 'owner'),
    permissions: resolvedPerms,
    managed_by_user_id: user.managedByUserId,
    account_id: membership ? membership.accountId : null,
    account_name: membership ? membership.account.name : null,
    account_slug: membership ? membership.account.slug : null,
    created_at: user.createdAt.toISOString(),
  };
};

// 1. GET /users
usersRouter.get('/', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const actor = req.user;
    let whereClause: any = {};

    if (actor.userRole === UserRole.OWNER) {
      whereClause = {
        userRole: { in: [UserRole.SUPER_ADMIN, UserRole.ADMIN] },
      };
    } else if (actor.userRole === UserRole.SUPER_ADMIN) {
      whereClause = {
        managedByUserId: actor.id,
        userRole: UserRole.ADMIN,
      };

      // Optional: filter by X-Account-ID
      const xAccountId = req.headers['x-account-id'];
      if (xAccountId) {
        const accountId = parseInt(xAccountId as string, 10);
        if (!isNaN(accountId)) {
          whereClause.memberships = {
            some: { accountId },
          };
        }
      }
    } else {
      throw new ForbiddenError('You do not have access to user management.');
    }

    const users = await prisma.user.findMany({
      where: whereClause,
      include: {
        memberships: {
          include: {
            account: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const items = await Promise.all(users.map(buildManagedUserResponse));
    return res.json(items);
  } catch (err) {
    next(err);
  }
});

// 2. POST /users/super-admins
const createSuperAdminSchema = z.object({
  email: z.string().email(),
  full_name: z.string().min(1),
  password: z.string().min(6),
  status: z.enum(['active', 'invited', 'disabled']),
  permissions: z.array(z.string()).default([]),
  account_name: z.string().min(1),
  account_slug: z.string().min(1),
});

usersRouter.post('/super-admins', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const actor = req.user;
    if (actor.userRole !== UserRole.OWNER) {
      throw new ForbiddenError('Only the owner can manage super admins.');
    }

    const payload = createSuperAdminSchema.parse(req.body);
    const email = payload.email.toLowerCase().trim();

    // Ensure email is unique
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictError('Email is already registered.');
    }

    const hashed = await hashPassword(payload.password);
    const statusVal = payload.status.toUpperCase() as UserStatus;

    // Use transaction to create user, account, membership, and wallet
    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          email,
          fullName: payload.full_name,
          hashedPassword: hashed,
          isActive: payload.status === 'active',
          isSuperuser: false,
          status: statusVal,
          userRole: UserRole.SUPER_ADMIN,
          managedByUserId: actor.id,
          permissionsJson: payload.permissions,
        },
      });

      const acc = await tx.account.create({
        data: {
          name: payload.account_name,
          slug: payload.account_slug,
          isActive: true,
          tokenBalance: 10000,
          monthlyTokenCredit: 5000,
        },
      });

      await tx.membership.create({
        data: {
          accountId: acc.id,
          userId: u.id,
          role: memberships_role.OWNER,
          status: MembershipStatus.ACTIVE,
        },
      });

      await tx.token_wallets.create({
        data: {
          account_id: acc.id,
          status: 'ACTIVE',
          balance_tokens: 10000,
          reserved_tokens: 0,
          lifetime_credited_tokens: 10000,
          lifetime_debited_tokens: 0,
          metadata_json: {},
        },
      });

      return tx.user.findUnique({
        where: { id: u.id },
        include: {
          memberships: {
            include: {
              account: true,
            },
          },
        },
      });
    });

    const response = await buildManagedUserResponse(user);
    return res.status(201).json(response);
  } catch (err) {
    next(err);
  }
});

// 3. PATCH /users/super-admins/:userId
const updateSuperAdminSchema = z.object({
  full_name: z.string().min(1).optional(),
  password: z.string().min(6).optional(),
  status: z.enum(['active', 'invited', 'disabled']).optional(),
  permissions: z.array(z.string()).optional(),
});

usersRouter.patch('/super-admins/:userId', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const actor = req.user;
    if (actor.userRole !== UserRole.OWNER) {
      throw new ForbiddenError('Only the owner can manage super admins.');
    }

    const userId = parseInt(req.params.userId, 10);
    if (isNaN(userId)) {
      throw new BadRequestError('Invalid user ID.');
    }

    const payload = updateSuperAdminSchema.parse(req.body);

    const user = await prisma.user.findFirst({
      where: { id: userId, userRole: UserRole.SUPER_ADMIN },
    });

    if (!user) {
      throw new NotFoundError('Super admin user not found.');
    }

    const updateData: any = {};
    if (payload.full_name !== undefined) updateData.fullName = payload.full_name;
    if (payload.permissions !== undefined) updateData.permissionsJson = payload.permissions;
    
    if (payload.password) {
      updateData.hashedPassword = await hashPassword(payload.password);
    }

    if (payload.status !== undefined) {
      updateData.status = payload.status.toUpperCase() as UserStatus;
      updateData.isActive = payload.status === 'active';

      // Cascade status changes to managed admins and delete their sessions
      if (payload.status === 'disabled' || payload.status === 'invited') {
        const managedAdmins = await prisma.user.findMany({
          where: { managedByUserId: user.id, userRole: UserRole.ADMIN },
        });
        const managedAdminIds = managedAdmins.map((a) => a.id);

        if (managedAdminIds.length > 0) {
          await prisma.user.updateMany({
            where: { id: { in: managedAdminIds } },
            data: {
              status: updateData.status,
              isActive: false,
            },
          });
          await prisma.refreshToken.deleteMany({
            where: { userId: { in: managedAdminIds } },
          });
        }

        // Revoke the super admin's refresh tokens too
        await prisma.refreshToken.deleteMany({
          where: { userId: user.id },
        });
      }
    }

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: updateData,
      include: {
        memberships: {
          include: {
            account: true,
          },
        },
      },
    });

    const response = await buildManagedUserResponse(updatedUser);
    return res.json(response);
  } catch (err) {
    next(err);
  }
});

// 4. POST /users/admins
const createAdminSchema = z.object({
  email: z.string().email(),
  full_name: z.string().min(1),
  password: z.string().min(6),
  status: z.enum(['active', 'invited', 'disabled']),
  permissions: z.array(z.string()).default([]),
});

usersRouter.post('/admins', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const actor = req.user;
    if (actor.userRole !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenError('Only super admins can create admin users.');
    }

    const payload = createAdminSchema.parse(req.body);
    const email = payload.email.toLowerCase().trim();

    // Get the account owned by this super admin
    const actorMembership = await prisma.membership.findFirst({
      where: { userId: actor.id, role: memberships_role.OWNER },
    });

    if (!actorMembership) {
      throw new BadRequestError('Super admin does not own any account workspace.');
    }

    // Ensure email is unique
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictError('Email is already registered.');
    }

    const hashed = await hashPassword(payload.password);
    const statusVal = payload.status.toUpperCase() as UserStatus;

    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          email,
          fullName: payload.full_name,
          hashedPassword: hashed,
          isActive: payload.status === 'active',
          isSuperuser: false,
          status: statusVal,
          userRole: UserRole.ADMIN,
          managedByUserId: actor.id,
          permissionsJson: payload.permissions,
        },
      });

      await tx.membership.create({
        data: {
          accountId: actorMembership.accountId,
          userId: u.id,
          role: memberships_role.ADMIN,
          status: MembershipStatus.ACTIVE,
        },
      });

      return tx.user.findUnique({
        where: { id: u.id },
        include: {
          memberships: {
            include: {
              account: true,
            },
          },
        },
      });
    });

    const response = await buildManagedUserResponse(user);
    return res.status(201).json(response);
  } catch (err) {
    next(err);
  }
});

// 5. PATCH /users/admins/:userId
const updateAdminSchema = z.object({
  full_name: z.string().min(1).optional(),
  password: z.string().min(6).optional(),
  status: z.enum(['active', 'invited', 'disabled']).optional(),
  permissions: z.array(z.string()).optional(),
});

usersRouter.patch('/admins/:userId', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const actor = req.user;
    if (actor.userRole !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenError('Only super admins can manage admin users.');
    }

    const userId = parseInt(req.params.userId, 10);
    if (isNaN(userId)) {
      throw new BadRequestError('Invalid user ID.');
    }

    const payload = updateAdminSchema.parse(req.body);

    const user = await prisma.user.findFirst({
      where: { id: userId, userRole: UserRole.ADMIN, managedByUserId: actor.id },
    });

    if (!user) {
      throw new NotFoundError('Admin user not found under your management.');
    }

    const updateData: any = {};
    if (payload.full_name !== undefined) updateData.fullName = payload.full_name;
    if (payload.permissions !== undefined) updateData.permissionsJson = payload.permissions;
    
    if (payload.password) {
      updateData.hashedPassword = await hashPassword(payload.password);
    }

    if (payload.status !== undefined) {
      updateData.status = payload.status.toUpperCase() as UserStatus;
      updateData.isActive = payload.status === 'active';

      if (payload.status === 'disabled' || payload.status === 'invited') {
        // Revoke admin's refresh tokens
        await prisma.refreshToken.deleteMany({
          where: { userId: user.id },
        });
      }
    }

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: updateData,
      include: {
        memberships: {
          include: {
            account: true,
          },
        },
      },
    });

    const response = await buildManagedUserResponse(updatedUser);
    return res.json(response);
  } catch (err) {
    next(err);
  }
});

// 6. DELETE /users/admins/:userId
usersRouter.delete('/admins/:userId', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const actor = req.user;
    if (actor.userRole !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenError('Only super admins can disable admin users.');
    }

    const userId = parseInt(req.params.userId, 10);
    if (isNaN(userId)) {
      throw new BadRequestError('Invalid user ID.');
    }

    const user = await prisma.user.findFirst({
      where: { id: userId, userRole: UserRole.ADMIN, managedByUserId: actor.id },
    });

    if (!user) {
      throw new NotFoundError('Admin user not found.');
    }

    // Deactivate and disable user
    await prisma.user.update({
      where: { id: user.id },
      data: {
        status: UserStatus.DISABLED,
        isActive: false,
      },
    });

    // Revoke sessions
    await prisma.refreshToken.deleteMany({
      where: { userId: user.id },
    });

    return res.json({ message: 'Admin user disabled successfully.' });
  } catch (err) {
    next(err);
  }
});

// 7. POST /users/:userId/reset-password
usersRouter.post('/:userId/reset-password', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const actor = req.user;
    const userId = parseInt(req.params.userId, 10);
    if (isNaN(userId)) {
      throw new BadRequestError('Invalid user ID.');
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundError('User not found.');
    }

    if (actor.userRole === UserRole.SUPER_ADMIN) {
      if (user.userRole !== UserRole.ADMIN || user.managedByUserId !== actor.id) {
        throw new ForbiddenError('You can only reset passwords for admins under your management.');
      }
    } else if (actor.userRole !== UserRole.OWNER) {
      throw new ForbiddenError('Only the owner or managing super admin can reset passwords.');
    }

    const hashed = await hashPassword('87654321');
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { hashedPassword: hashed },
      }),
      prisma.refreshToken.deleteMany({
        where: { userId: user.id },
      }),
    ]);

    return res.json({ message: 'Password reset successfully.' });
  } catch (err) {
    next(err);
  }
});

export default usersRouter;
