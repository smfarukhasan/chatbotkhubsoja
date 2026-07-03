import { Request, Response, NextFunction } from 'express';
import { decodeToken } from '../core/security.js';
import { prisma } from '../core/db.js';
import { UnauthorizedError, ForbiddenError } from '../core/errors.js';

export interface AuthenticatedRequest extends Request {
  user?: any;
}

export const requireUser = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(new UnauthorizedError('Not authenticated.'));
  }

  const token = authHeader.substring(7);
  try {
    const payload = decodeToken(token);
    
    if (payload.type !== 'access') {
      return next(new UnauthorizedError('Invalid token type.'));
    }

    const userId = parseInt(payload.sub, 10);
    
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
      return next(new UnauthorizedError('User not found.'));
    }

    // OWNER bypasses active check, admins/users must be active
    if (user.userRole !== 'OWNER' && (!user.isActive || user.status !== 'ACTIVE')) {
      return next(new ForbiddenError('User account is inactive.'));
    }

    req.user = user;
    next();
  } catch (err) {
    return next(new UnauthorizedError('Invalid or expired token.'));
  }
};
export default requireUser;
