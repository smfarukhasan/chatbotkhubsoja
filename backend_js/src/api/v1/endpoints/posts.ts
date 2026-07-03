import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../../core/db.js';
import { requireUser, AuthenticatedRequest } from '../../../middlewares/auth.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../../core/errors.js';
import { FacebookGraphAPIClient } from '../../../integrations/facebook/client.js';
import { tokenCipher } from '../../../utils/crypto.js';

export const postsRouter = Router();
const fbClient = new FacebookGraphAPIClient();

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

// Helper: format response
const toResponse = (post: any) => ({
  ...post,
  status: post.status.toLowerCase(),
  generated_by: post.generated_by.toLowerCase(),
  media_urls: post.media_urls || [],
});

// 1. GET /posts
postsRouter.get('/', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const status = req.query.status as string | undefined;
    const connectionId = req.query.platform_connection_id ? parseInt(req.query.platform_connection_id as string, 10) : undefined;
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const pageSize = req.query.page_size ? parseInt(req.query.page_size as string, 10) : 20;

    const where: any = { account_id: accountId };
    if (status) {
      where.status = status.toUpperCase();
    }
    if (connectionId) {
      where.platform_connection_id = connectionId;
    }

    const items = await prisma.social_posts.findMany({
      where,
      orderBy: { created_at: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    const total = await prisma.social_posts.count({ where });

    return res.json({
      items: items.map(toResponse),
      total,
      page,
      page_size: pageSize,
    });
  } catch (err) {
    next(err);
  }
});

// 2. GET /posts/:id
postsRouter.get('/:id', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const postId = parseInt(req.params.id, 10);
    if (isNaN(postId)) {
      throw new BadRequestError('Invalid ID');
    }

    const post = await prisma.social_posts.findFirst({
      where: { id: postId, account_id: accountId },
    });

    if (!post) {
      throw new NotFoundError('Post not found.');
    }

    return res.json(toResponse(post));
  } catch (err) {
    next(err);
  }
});

// 3. POST /posts
const createPostSchema = z.object({
  platform_connection_id: z.number(),
  title: z.string().optional().nullable(),
  content: z.string().min(1),
  media_urls: z.array(z.string()).default([]),
  scheduled_for: z.string().optional().nullable(),
  ai_agent_id: z.number().optional().nullable(),
  ai_prompt_id: z.number().optional().nullable(),
});

postsRouter.post('/', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const payload = createPostSchema.parse(req.body);

    const post = await prisma.social_posts.create({
      data: {
        account_id: accountId,
        platform_connection_id: payload.platform_connection_id,
        title: payload.title || null,
        content: payload.content,
        media_urls: payload.media_urls,
        scheduled_for: payload.scheduled_for ? new Date(payload.scheduled_for) : null,
        ai_agent_id: payload.ai_agent_id || null,
        ai_prompt_id: payload.ai_prompt_id || null,
        platform_type: 'FACEBOOK_PAGE',
        status: payload.scheduled_for ? 'SCHEDULED' : 'DRAFT',
        generated_by: 'HUMAN_ADMIN',
        metadata_json: {},
      },
    });

    return res.status(201).json(toResponse(post));
  } catch (err) {
    next(err);
  }
});

// 4. PUT /posts/:id
const updatePostSchema = z.object({
  title: z.string().optional().nullable(),
  content: z.string().optional(),
  media_urls: z.array(z.string()).optional(),
  scheduled_for: z.string().optional().nullable(),
  status: z.enum(['draft', 'approved', 'scheduled', 'published', 'failed', 'rejected']).optional(),
  ai_agent_id: z.number().optional().nullable(),
  ai_prompt_id: z.number().optional().nullable(),
});

postsRouter.put('/:id', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const postId = parseInt(req.params.id, 10);
    const payload = updatePostSchema.parse(req.body);

    if (isNaN(postId)) {
      throw new BadRequestError('Invalid ID');
    }

    const post = await prisma.social_posts.findFirst({
      where: { id: postId, account_id: accountId },
    });

    if (!post) {
      throw new NotFoundError('Post not found.');
    }

    const updated = await prisma.social_posts.update({
      where: { id: postId },
      data: {
        title: payload.title !== undefined ? payload.title : post.title,
        content: payload.content !== undefined ? payload.content : post.content,
        media_urls: payload.media_urls !== undefined ? payload.media_urls : (post.media_urls as any),
        scheduled_for: payload.scheduled_for !== undefined ? (payload.scheduled_for ? new Date(payload.scheduled_for) : null) : post.scheduled_for,
        status: payload.status !== undefined ? (payload.status.toUpperCase() as any) : post.status,
        ai_agent_id: payload.ai_agent_id !== undefined ? payload.ai_agent_id : post.ai_agent_id,
        ai_prompt_id: payload.ai_prompt_id !== undefined ? payload.ai_prompt_id : post.ai_prompt_id,
      },
    });

    return res.json(toResponse(updated));
  } catch (err) {
    next(err);
  }
});

// 5. DELETE /posts/:id
postsRouter.delete('/:id', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const postId = parseInt(req.params.id, 10);

    if (isNaN(postId)) {
      throw new BadRequestError('Invalid ID');
    }

    const post = await prisma.social_posts.findFirst({
      where: { id: postId, account_id: accountId },
    });

    if (!post) {
      throw new NotFoundError('Post not found.');
    }

    await prisma.social_posts.delete({
      where: { id: postId },
    });

    return res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// 6. POST /posts/:id/publish-now
postsRouter.post('/:id/publish-now', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const postId = parseInt(req.params.id, 10);

    if (isNaN(postId)) {
      throw new BadRequestError('Invalid ID');
    }

    const post = await prisma.social_posts.findFirst({
      where: { id: postId, account_id: accountId },
    });

    if (!post) {
      throw new NotFoundError('Post not found.');
    }

    if (!post.platform_connection_id) {
      throw new BadRequestError('No platform connection linked to this post.');
    }

    const connection = await prisma.platformConnection.findFirst({
      where: { id: post.platform_connection_id, accountId },
    });
    if (!connection || !connection.encryptedAccessToken) {
      throw new BadRequestError('Platform connection token not found.');
    }

    const pageToken = tokenCipher.decrypt(connection.encryptedAccessToken);
    const pageId = (connection.metadataJson as any)?.facebook?.page_id || connection.externalId;
    if (!pageToken || !pageId) {
      throw new BadRequestError('Failed to decrypt page token or missing Page ID.');
    }

    let externalPostId = '';
    try {
      const result = await fbClient.publishPost(pageToken, pageId, post.content);
      externalPostId = String(result.id || '');
    } catch (err: any) {
      console.error('Error publishing to Facebook:', err);
      await prisma.social_posts.update({
        where: { id: postId },
        data: {
          status: 'FAILED',
          last_error: err.message || 'Facebook API error during immediate publishing.',
        },
      });
      throw new BadRequestError(`Facebook API publish failed: ${err.message}`);
    }

    const updated = await prisma.social_posts.update({
      where: { id: postId },
      data: {
        status: 'PUBLISHED',
        published_at: new Date(),
        external_post_id: externalPostId,
        last_error: null,
      },
    });

    return res.json(toResponse(updated));
  } catch (err) {
    next(err);
  }
});

// 7. PATCH /posts/:id/ai-auto-reply
const toggleAiAutoReplySchema = z.object({
  ai_auto_reply_enabled: z.boolean(),
});

postsRouter.patch('/:id/ai-auto-reply', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const postId = parseInt(req.params.id, 10);
    const payload = toggleAiAutoReplySchema.parse(req.body);

    if (isNaN(postId)) {
      throw new BadRequestError('Invalid ID');
    }

    const post = await prisma.social_posts.findFirst({
      where: { id: postId, account_id: accountId },
    });

    if (!post) {
      throw new NotFoundError('Post not found.');
    }

    const updated = await prisma.social_posts.update({
      where: { id: postId },
      data: {
        ai_auto_reply_enabled: payload.ai_auto_reply_enabled,
      },
    });

    return res.json(toResponse(updated));
  } catch (err) {
    next(err);
  }
});

export default postsRouter;
