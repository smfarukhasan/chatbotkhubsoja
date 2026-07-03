import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../../core/db.js';
import { UserRole, UserStatus, MembershipStatus } from '@prisma/client';
import { getSettings } from '../../../config/settings.js';
import { logger } from '../../../core/logging.js';
import {
  hashPassword,
  verifyPassword,
  createAccessToken,
  createRefreshToken,
  decodeToken,
} from '../../../core/security.js';
import {
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  HttpError,
} from '../../../core/errors.js';
import { requireUser, AuthenticatedRequest } from '../../../middlewares/auth.js';

export const authRouter = Router();
const settings = getSettings();

// Zod schemas for input validation
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  full_name: z.string().max(255).optional().nullable(),
  fullName: z.string().max(255).optional().nullable(),
  onboarding_key: z.string().min(12).max(64).optional().nullable(),
  onboardingKey: z.string().min(12).max(64).optional().nullable(),
});

const refreshSchema = z.object({
  refresh_token: z.string(),
  refreshToken: z.string().optional(),
});

const logoutSchema = z.object({
  refresh_token: z.string(),
  refreshToken: z.string().optional(),
  logout_all: z.boolean().default(false),
  logoutAll: z.boolean().optional(),
});

const changePasswordSchema = z.object({
  current_password: z.string().min(8).max(128),
  currentPassword: z.string().min(8).max(128).optional(),
  new_password: z.string().min(8).max(128),
  newPassword: z.string().min(8).max(128).optional(),
});

// Helper: resolve user permissions based on role and manager permissions
export const resolveUserPermissions = async (user: any): Promise<string[]> => {
  const rawPerms = Array.isArray(user.permissionsJson) ? user.permissionsJson : [];
  const userPerms = rawPerms.map((p: any) => String(p));
  
  if (user.userRole === 'OWNER') {
    return userPerms;
  }
  
  if (user.userRole === 'SUPER_ADMIN') {
    return userPerms;
  }
  
  if (user.userRole === 'ADMIN' && user.managedByUserId) {
    const parent = await prisma.user.findUnique({
      where: { id: user.managedByUserId },
    });
    
    if (parent) {
      const rawParentPerms = Array.isArray(parent.permissionsJson) ? parent.permissionsJson : [];
      const parentPerms = rawParentPerms.map((p: any) => String(p));
      
      const parentFeatures = parentPerms.filter((p: string) => p.startsWith('feature:'));
      const childFeatures = userPerms.filter((p: string) => p.startsWith('feature:'));
      const nonFeatures = userPerms.filter((p: string) => !p.startsWith('feature:'));
      
      let resolvedFeatures: string[] = [];
      if (parentFeatures.length > 0) {
        if (childFeatures.length === 0) {
          resolvedFeatures = parentFeatures;
        } else {
          resolvedFeatures = childFeatures.filter((f: string) => parentFeatures.includes(f));
        }
      } else {
        resolvedFeatures = childFeatures;
      }
      
      return [...nonFeatures, ...resolvedFeatures];
    }
  }
  
  return userPerms;
};

// Helper: build standardized user response (normalizes enums to lowercase for frontend)
const buildUserResponse = async (user: any) => {
  const resolvedPerms = await resolveUserPermissions(user);
  return {
    id: user.id,
    email: user.email,
    full_name: user.fullName,
    status: user.status?.toLowerCase(),
    user_role: user.userRole === 'SUPER_ADMIN' ? 'superAdmin' : user.userRole?.toLowerCase(),
    is_superuser: user.isSuperuser,
    permissions: resolvedPerms,
    memberships: (user.memberships || []).map((m: any) => ({
      id: m.id,
      account_id: m.accountId,
      account_name: m.account?.name || '',
      account_slug: m.account?.slug || '',
      role: m.role?.toLowerCase(),
      status: m.status?.toLowerCase(),
    })),
  };
};

// Helper: bootstrap/ensure owner user exists
const ensureOwnerUser = async () => {
  const ownerEmail = settings.owner_email.toLowerCase().trim();
  const owner = await prisma.user.findUnique({
    where: { email: ownerEmail },
  });

  if (owner) {
    let changed = false;
    const updates: any = {};
    if (owner.userRole !== UserRole.OWNER) {
      updates.userRole = UserRole.OWNER;
      changed = true;
    }
    if (!owner.isSuperuser) {
      updates.isSuperuser = true;
      changed = true;
    }
    if (!owner.isActive) {
      updates.isActive = true;
      changed = true;
    }
    if (owner.status !== UserStatus.ACTIVE) {
      updates.status = UserStatus.ACTIVE;
      changed = true;
    }

    if (changed) {
      await prisma.user.update({
        where: { id: owner.id },
        data: updates,
      });
    }
    return;
  }

  // Create owner
  const hashed = await hashPassword(settings.owner_password);
  await prisma.user.create({
    data: {
      email: ownerEmail,
      fullName: settings.owner_full_name,
      hashedPassword: hashed,
      isActive: true,
      isSuperuser: true,
      status: UserStatus.ACTIVE,
      userRole: UserRole.OWNER,
      permissionsJson: [],
    },
  });
};

const issueTokens = async (userId: number) => {
  const userIdStr = String(userId);
  const { token: accessToken, expiresAt: accessExpiresAt } = createAccessToken(userIdStr);
  const { token: refreshToken, jti, expiresAt: refreshExpiresAt } = createRefreshToken(userIdStr);

  // Save refresh token to db
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenJti: jti,
      expiresAt: refreshExpiresAt,
    },
  });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      memberships: {
        include: {
          account: true,
        },
      },
    },
  });

  if (!user) {
    throw new Error(`User with id ${userId} not found after token creation.`);
  }

  const now = new Date();
  const expiresInSeconds = Math.max(Math.floor((accessExpiresAt.getTime() - now.getTime()) / 1000), 0);

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'bearer',
    expires_in: expiresInSeconds,
    user: await buildUserResponse(user),
  };
};

// POST /login
authRouter.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const payload = loginSchema.parse(req.body);
    await ensureOwnerUser();

    const user = await prisma.user.findUnique({
      where: { email: payload.email.toLowerCase().trim() },
    });

    if (!user) {
      return next(new UnauthorizedError('Invalid email or password.'));
    }

    const passwordValid = await verifyPassword(payload.password, user.hashedPassword);
    if (!passwordValid) {
      return next(new UnauthorizedError('Invalid email or password.'));
    }

    if (user.userRole !== UserRole.OWNER && (!user.isActive || user.status !== UserStatus.ACTIVE)) {
      return next(new ForbiddenError('User account is inactive.'));
    }

    const response = await issueTokens(user.id);
    return res.json(response);
  } catch (err) {
    next(err);
  }
});

// POST /register
authRouter.post('/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const payload = registerSchema.parse(req.body);
    const email = payload.email.toLowerCase().trim();

    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return next(new HttpError(409, 'conflict', 'Email is already registered.'));
    }

    const onboardingKeyValue = payload.onboarding_key || payload.onboardingKey;
    let validKey: any = null;

    if (onboardingKeyValue) {
      validKey = await prisma.onboardingKey.findUnique({
        where: { key: onboardingKeyValue },
      });

      if (!validKey) {
        return next(new HttpError(404, 'not_found', 'Onboarding key not found.'));
      }
      if (validKey.revokedAt) {
        return next(new BadRequestError('Onboarding key has been revoked.'));
      }
      if (validKey.expiresAt && new Date(validKey.expiresAt) <= new Date()) {
        return next(new BadRequestError('Onboarding key has expired.'));
      }
      if (validKey.usedCount >= validKey.maxUses) {
        return next(new BadRequestError('Onboarding key has been exhausted.'));
      }
      if (validKey.invitedEmail && validKey.invitedEmail.toLowerCase().trim() !== email) {
        return next(new ForbiddenError('Onboarding key is not valid for this email.'));
      }
    }

    // Create User
    const hashed = await hashPassword(payload.password);
    const name = payload.full_name || payload.fullName || null;

    const user = await prisma.user.create({
      data: {
        email,
        fullName: name,
        hashedPassword: hashed,
        isActive: true,
        isSuperuser: false,
        status: UserStatus.ACTIVE,
        userRole: UserRole.ADMIN,
        permissionsJson: [],
      },
    });

    // Join account if key is valid
    if (validKey) {
      await prisma.$transaction(async (tx) => {
        // Double check membership existence
        const existingMembership = await tx.membership.findUnique({
          where: {
            uq_memberships_account_id_user_id: {
              accountId: validKey.accountId,
              userId: user.id,
            },
          },
        });

        if (existingMembership) {
          throw new HttpError(409, 'conflict', 'User already belongs to this account.');
        }

        // Create membership
        await tx.membership.create({
          data: {
            accountId: validKey.accountId,
            userId: user.id,
            role: validKey.role,
            status: MembershipStatus.ACTIVE,
            invitedEmail: validKey.invitedEmail,
          },
        });

        // Increment key use count
        await tx.onboardingKey.update({
          where: { id: validKey.id },
          data: {
            usedCount: { increment: 1 },
          },
        });
      });
    }

    const response = await issueTokens(user.id);
    return res.json(response);
  } catch (err) {
    next(err);
  }
});

// POST /refresh
authRouter.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const payload = refreshSchema.parse(req.body);
    const refreshTokenVal = payload.refresh_token || payload.refreshToken || '';

    const tokenData = decodeToken(refreshTokenVal);
    if (tokenData.type !== 'refresh') {
      return next(new UnauthorizedError('Refresh token is invalid.'));
    }

    const userId = parseInt(tokenData.sub, 10);
    const dbToken = await prisma.refreshToken.findUnique({
      where: { tokenJti: tokenData.jti },
    });

    if (!dbToken || dbToken.revokedAt) {
      return next(new UnauthorizedError('Refresh token is invalid.'));
    }

    if (new Date(dbToken.expiresAt) <= new Date()) {
      return next(new UnauthorizedError('Refresh token has expired.'));
    }

    // Revoke old refresh token
    await prisma.refreshToken.update({
      where: { id: dbToken.id },
      data: { revokedAt: new Date() },
    });

    const response = await issueTokens(userId);
    return res.json(response);
  } catch (err) {
    next(err);
  }
});

// POST /logout
authRouter.post('/logout', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const payload = logoutSchema.parse(req.body);
    const refreshTokenVal = payload.refresh_token || payload.refreshToken || '';
    const logoutAll = payload.logout_all || payload.logoutAll || false;

    const tokenData = decodeToken(refreshTokenVal);
    
    if (logoutAll) {
      // Revoke all tokens for this user
      await prisma.refreshToken.updateMany({
        where: { userId: req.user.id },
        data: { revokedAt: new Date() },
      });
    } else {
      // Revoke this specific token
      await prisma.refreshToken.update({
        where: { tokenJti: tokenData.jti },
        data: { revokedAt: new Date() },
      });
    }

    return res.json({
      message: 'Refresh token revoked. Existing access tokens will expire naturally.',
    });
  } catch (err) {
    next(err);
  }
});

// POST /change-password
authRouter.post('/change-password', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const payload = changePasswordSchema.parse(req.body);
    const currentPass = payload.current_password || payload.currentPassword || '';
    const newPass = payload.new_password || payload.newPassword || '';

    const user = req.user;
    const passwordValid = await verifyPassword(currentPass, user.hashedPassword);
    if (!passwordValid) {
      return next(new BadRequestError('Current password is incorrect.'));
    }

    if (currentPass === newPass) {
      return next(new BadRequestError('New password must be different from the current password.'));
    }

    // Update password & revoke all old refresh tokens
    const hashed = await hashPassword(newPass);
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { hashedPassword: hashed },
      }),
      prisma.refreshToken.updateMany({
        where: { userId: user.id },
        data: { revokedAt: new Date() },
      }),
    ]);

    const response = await issueTokens(user.id);
    return res.json(response);
  } catch (err) {
    next(err);
  }
});

// GET /me
authRouter.get('/me', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    return res.json(await buildUserResponse(req.user));
  } catch (err) {
    next(err);
  }
});

export default authRouter;
