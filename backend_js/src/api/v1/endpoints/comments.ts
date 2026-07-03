import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../../core/db.js';
import { requireUser, AuthenticatedRequest } from '../../../middlewares/auth.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../../core/errors.js';
import { FacebookGraphAPIClient } from '../../../integrations/facebook/client.js';
import { tokenCipher } from '../../../utils/crypto.js';

export const commentsRouter = Router();
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

// 1. GET /comments
commentsRouter.get('/', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const status = req.query.status as string | undefined;
    const connectionId = req.query.platform_connection_id ? parseInt(req.query.platform_connection_id as string, 10) : undefined;
    const postExternalId = req.query.post_external_id as string | undefined;
    const search = req.query.search as string | undefined;
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const pageSize = req.query.page_size ? parseInt(req.query.page_size as string, 10) : 10;

    const where: any = { account_id: accountId };
    if (status) {
      where.status = status;
    }
    if (connectionId) {
      where.platform_connection_id = connectionId;
    }
    if (postExternalId) {
      where.post_external_id = postExternalId;
    }
    if (search) {
      where.OR = [
        { commenter_name: { contains: search } },
        { comment_text: { contains: search } },
      ];
    }

    const items = await prisma.facebook_comments.findMany({
      where,
      orderBy: { commented_at: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    const total = await prisma.facebook_comments.count({ where });

    const formattedItems = items.map((c) => ({
      ...c,
      status: c.status.toLowerCase(),
    }));

    return res.json({
      items: formattedItems,
      total,
      page,
      page_size: pageSize,
    });
  } catch (err) {
    next(err);
  }
});

// 2. GET /comments/posts
commentsRouter.get('/posts', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const connectionId = req.query.platform_connection_id ? parseInt(req.query.platform_connection_id as string, 10) : undefined;
    const search = req.query.search as string | undefined;
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const pageSize = req.query.page_size ? parseInt(req.query.page_size as string, 10) : 20;

    const where: any = { account_id: accountId };
    if (connectionId) {
      where.platform_connection_id = connectionId;
    }
    if (search) {
      where.OR = [
        { post_title: { contains: search } },
        { post_external_id: { contains: search } },
      ];
    }

    // Prisma groupBy post_external_id
    const groups = await prisma.facebook_comments.groupBy({
      by: ['post_external_id', 'post_title', 'post_url', 'platform_connection_id'],
      where,
      _count: {
        id: true,
      },
      orderBy: {
        post_external_id: 'asc',
      },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    const formattedItems = groups.map((g) => ({
      post_external_id: g.post_external_id,
      post_title: g.post_title,
      post_url: g.post_url,
      platform_connection_id: g.platform_connection_id,
      comment_count: g._count.id,
    }));

    return res.json({
      items: formattedItems,
      total: groups.length,
      page,
      page_size: pageSize,
    });
  } catch (err) {
    next(err);
  }
});

// 3. GET /comments/posts/:postExternalId
commentsRouter.get('/posts/:postExternalId', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const postExternalId = req.params.postExternalId;
    const connectionId = req.query.platform_connection_id ? parseInt(req.query.platform_connection_id as string, 10) : undefined;

    const where: any = {
      account_id: accountId,
      post_external_id: postExternalId,
    };
    if (connectionId) {
      where.platform_connection_id = connectionId;
    }

    const firstComment = await prisma.facebook_comments.findFirst({
      where,
    });

    if (!firstComment) {
      throw new NotFoundError('Post not found in comments database.');
    }

    const comments = await prisma.facebook_comments.findMany({
      where,
      orderBy: { commented_at: 'asc' },
    });

    const formattedComments = comments.map((c) => ({
      ...c,
      status: c.status.toLowerCase(),
    }));

    return res.json({
      post_external_id: postExternalId,
      post_title: firstComment.post_title,
      post_url: firstComment.post_url,
      platform_connection_id: firstComment.platform_connection_id,
      comments: formattedComments,
    });
  } catch (err) {
    next(err);
  }
});

// 4. GET /comments/:id
commentsRouter.get('/:id', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const commentId = parseInt(req.params.id, 10);
    if (isNaN(commentId)) {
      throw new BadRequestError('Invalid ID');
    }

    const comment = await prisma.facebook_comments.findFirst({
      where: { id: commentId, account_id: accountId },
    });

    if (!comment) {
      throw new NotFoundError('Comment not found.');
    }

    const replies = await prisma.facebook_comment_replies.findMany({
      where: { comment_id: commentId },
      orderBy: { created_at: 'asc' },
    });

    return res.json({
      ...comment,
      status: comment.status.toLowerCase(),
      replies: replies.map((r) => ({
        ...r,
        sender_type: r.sender_type.toLowerCase(),
        reply_status: r.reply_status.toLowerCase(),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// 5. PATCH /comments/:id/status
const updateCommentStatusSchema = z.object({
  status: z.enum(['pending', 'replied', 'ignored', 'flagged', 'need_review']),
  moderation_notes: z.string().optional().nullable(),
  assigned_to_user_id: z.number().optional().nullable(),
});

commentsRouter.patch('/:id/status', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const commentId = parseInt(req.params.id, 10);
    const payload = updateCommentStatusSchema.parse(req.body);

    if (isNaN(commentId)) {
      throw new BadRequestError('Invalid ID');
    }

    const comment = await prisma.facebook_comments.findFirst({
      where: { id: commentId, account_id: accountId },
    });

    if (!comment) {
      throw new NotFoundError('Comment not found.');
    }

    const updated = await prisma.facebook_comments.update({
      where: { id: commentId },
      data: {
        status: payload.status.toUpperCase() as any,
        moderation_notes: payload.moderation_notes !== undefined ? payload.moderation_notes : comment.moderation_notes,
        assigned_to_user_id: payload.assigned_to_user_id !== undefined ? payload.assigned_to_user_id : comment.assigned_to_user_id,
      },
    });

    return res.json({
      ...updated,
      status: updated.status.toLowerCase(),
    });
  } catch (err) {
    next(err);
  }
});

// 6. POST /comments/:id/replies
const createReplySchema = z.object({
  content: z.string().min(1),
  send_now: z.boolean().default(true),
});

commentsRouter.post('/:id/replies', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const commentId = parseInt(req.params.id, 10);
    const payload = createReplySchema.parse(req.body);

    if (isNaN(commentId)) {
      throw new BadRequestError('Invalid ID');
    }

    const comment = await prisma.facebook_comments.findFirst({
      where: { id: commentId, account_id: accountId },
    });

    if (!comment) {
      throw new NotFoundError('Comment not found.');
    }

    let externalReplyId: string | null = null;
    let errorMessage: string | null = null;
    let replyStatus: any = 'DRAFT';
    let sentAt: Date | null = null;

    if (payload.send_now) {
      if (!comment.platform_connection_id) {
        throw new BadRequestError('No platform connection linked to this comment.');
      }
      const connection = await prisma.platformConnection.findFirst({
        where: { id: comment.platform_connection_id, accountId },
      });
      if (!connection || !connection.encryptedAccessToken) {
        throw new BadRequestError('Platform connection token not found.');
      }

      const pageToken = tokenCipher.decrypt(connection.encryptedAccessToken);
      if (!pageToken) {
        throw new BadRequestError('Failed to decrypt page token.');
      }

      try {
        const result = await fbClient.replyToComment(pageToken, comment.external_comment_id, payload.content);
        externalReplyId = String(result.id || '');
        replyStatus = 'SENT';
        sentAt = new Date();
      } catch (err: any) {
        console.error('Error sending reply to Facebook:', err);
        replyStatus = 'FAILED';
        errorMessage = err.message || 'Facebook API error';
      }
    }

    const reply = await prisma.facebook_comment_replies.create({
      data: {
        account_id: accountId,
        comment_id: commentId,
        created_by_user_id: req.user.id,
        sender_type: 'HUMAN_ADMIN',
        reply_status: replyStatus,
        content: payload.content,
        external_reply_id: externalReplyId,
        error_message: errorMessage,
        sent_at: sentAt,
        metadata_json: {},
      },
    });

    if (replyStatus === 'SENT') {
      await prisma.facebook_comments.update({
        where: { id: commentId },
        data: {
          status: 'REPLIED',
          last_replied_at: new Date(),
        },
      });
    }

    return res.status(201).json({
      ...reply,
      sender_type: reply.sender_type.toLowerCase(),
      reply_status: reply.reply_status.toLowerCase(),
    });
  } catch (err) {
    next(err);
  }
});

export default commentsRouter;
