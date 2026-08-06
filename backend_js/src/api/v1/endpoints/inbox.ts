import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { FacebookIntegrationService } from '../../../integrations/facebook/service.js';
import { requireUser, AuthenticatedRequest } from '../../../middlewares/auth.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../../core/errors.js';
import { prisma } from '../../../core/db.js';
import { getAIChatState } from '../../../integrations/facebook/service.js';

export const inboxRouter = Router();
const fbService = new FacebookIntegrationService();

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

// 1. GET /facebook/live/conversations
inboxRouter.get('/facebook/live/conversations', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const connectionId = req.query.connection_id ? parseInt(req.query.connection_id as string, 10) : undefined;
    const pageSize = req.query.page_size ? parseInt(req.query.page_size as string, 10) : 25;
    const after = req.query.after as string | undefined;

    const result = await fbService.listLiveConversations(accountId, connectionId, pageSize, after);
    return res.json(result);
  } catch (err) {
    next(err);
  }
});

// 2. GET /facebook/live/conversations/:conversationId/messages
inboxRouter.get('/facebook/live/conversations/:conversationId/messages', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const conversationId = req.params.conversationId;
    const connectionId = parseInt(req.query.connection_id as string, 10);
    const pageSize = req.query.page_size ? parseInt(req.query.page_size as string, 10) : 100;
    const after = req.query.after as string | undefined;

    if (isNaN(connectionId)) {
      throw new BadRequestError('Missing or invalid connection_id parameter.');
    }

    const result = await fbService.listLiveMessages(accountId, connectionId, conversationId, pageSize, after);
    return res.json(result);
  } catch (err) {
    next(err);
  }
});

// 3. POST /facebook/live/reply
const sendLiveReplySchema = z.object({
  connection_id: z.number(),
  recipient_id: z.string(),
  content: z.string().min(1),
});

inboxRouter.post('/facebook/live/reply', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const payload = sendLiveReplySchema.parse(req.body);
    const result = await fbService.sendLiveReply(accountId, payload.connection_id, payload.recipient_id, payload.content);
    return res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// 4. PATCH /facebook/live/conversations/:conversationId/ai-chat
const updateLiveAiChatSchema = z.object({
  connection_id: z.number(),
  customer_external_id: z.string(),
  customer_name: z.string().optional().nullable(),
  mode: z.enum(['auto', 'manual', 'off']),
  manual_minutes: z.number().optional().nullable(),
});

inboxRouter.patch('/facebook/live/conversations/:conversationId/ai-chat', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const conversationId = req.params.conversationId;
    const payload = updateLiveAiChatSchema.parse(req.body);

    const result = await fbService.updateLiveConversationAiChat(
      accountId,
      payload.connection_id,
      conversationId,
      payload.customer_external_id,
      payload.customer_name || null,
      payload.mode,
      payload.manual_minutes || undefined
    );
    return res.json(result);
  } catch (err) {
    next(err);
  }
});

// 5. PATCH /conversations/:conversationId/ai-chat
const updateNormalAiChatSchema = z.object({
  mode: z.enum(['auto', 'manual', 'off']),
  manual_minutes: z.number().optional().nullable(),
});

inboxRouter.patch('/conversations/:conversationId/ai-chat', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const conversationId = parseInt(req.params.conversationId, 10);
    const payload = updateNormalAiChatSchema.parse(req.body);

    if (isNaN(conversationId)) {
      throw new BadRequestError('Invalid conversation ID.');
    }

    if (payload.mode === 'manual' && payload.manual_minutes === undefined) {
      throw new BadRequestError('Manual mode requires manual_minutes.');
    }

    const conversation = await prisma.conversations.findFirst({
      where: { id: conversationId, account_id: accountId },
    });

    if (!conversation) {
      throw new NotFoundError('Conversation not found.');
    }

    let manualUntil: Date | null = null;
    if (payload.mode === 'manual' && payload.manual_minutes) {
      manualUntil = new Date(Date.now() + payload.manual_minutes * 60 * 1000);
    }

    const updated = await prisma.conversations.update({
      where: { id: conversation.id },
      data: {
        metadata_json: {
          ...(conversation.metadata_json as any || {}),
          ai_chat: {
            mode: payload.mode,
            manual_until: manualUntil ? manualUntil.toISOString() : null,
          },
        },
      },
    });

    const state = getAIChatState(updated.metadata_json);
    return res.json({
      ai_chat_mode: state.mode,
      ai_chat_manual_until: state.manual_until,
    });
  } catch (err) {
    next(err);
  }
});

// 6. GET /conversations
inboxRouter.get('/conversations', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const status = req.query.status as string | undefined;
    const search = req.query.search as string | undefined;
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const pageSize = req.query.page_size ? parseInt(req.query.page_size as string, 10) : 20;

    const where: any = { account_id: accountId };
    if (status) {
      where.status = status;
    }
    if (search) {
      where.OR = [
        { customer_name: { contains: search } },
        { customer_phone: { contains: search } },
        { latest_message_preview: { contains: search } },
      ];
    }

    const items = await prisma.conversations.findMany({
      where,
      orderBy: { latest_message_at: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    const total = await prisma.conversations.count({ where });

    const formattedItems = items.map((c) => {
      const state = getAIChatState(c.metadata_json);
      return {
        id: c.id,
        account_id: c.account_id,
        platform_connection_id: c.platform_connection_id,
        platform_type: c.platform_type,
        status: c.status,
        customer_external_id: c.customer_external_id,
        customer_name: c.customer_name,
        customer_avatar_url: c.customer_avatar_url,
        latest_message_preview: c.latest_message_preview,
        latest_message_at: c.latest_message_at,
        ai_chat_mode: state.mode,
        ai_chat_manual_until: state.manual_until,
        unread_count: 0,
      };
    });

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

// 7. GET /conversations/:id
inboxRouter.get('/conversations/:id', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const conversationId = parseInt(req.params.id, 10);
    if (isNaN(conversationId)) {
      throw new BadRequestError('Invalid ID');
    }

    const c = await prisma.conversations.findFirst({
      where: { id: conversationId, account_id: accountId },
    });

    if (!c) {
      throw new NotFoundError('Conversation not found.');
    }

    const state = getAIChatState(c.metadata_json);
    return res.json({
      id: c.id,
      account_id: c.account_id,
      platform_connection_id: c.platform_connection_id,
      platform_type: c.platform_type,
      status: c.status,
      customer_external_id: c.customer_external_id,
      customer_name: c.customer_name,
      customer_avatar_url: c.customer_avatar_url,
      latest_message_preview: c.latest_message_preview,
      latest_message_at: c.latest_message_at,
      ai_chat_mode: state.mode,
      ai_chat_manual_until: state.manual_until,
      metadata_json: c.metadata_json || {},
      created_at: c.created_at,
      updated_at: c.updated_at,
    });
  } catch (err) {
    next(err);
  }
});

// 8. GET /conversations/:id/messages
inboxRouter.get('/conversations/:id/messages', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const conversationId = parseInt(req.params.id, 10);
    if (isNaN(conversationId)) {
      throw new BadRequestError('Invalid ID');
    }

    const conversation = await prisma.conversations.findFirst({
      where: { id: conversationId, account_id: accountId },
    });
    if (!conversation) {
      throw new NotFoundError('Conversation not found.');
    }

    const msgs = await prisma.messages.findMany({
      where: { conversation_id: conversationId, account_id: accountId },
      orderBy: { created_at: 'asc' },
    });

    const formattedMsgs = msgs.map((m) => ({
      id: m.id,
      conversation_id: m.conversation_id,
      sender_name: m.sender_name,
      sender_external_id: m.sender_external_id,
      direction: m.direction,
      content: m.content,
      created_at: m.created_at,
    }));

    return res.json({
      items: formattedMsgs,
      total: msgs.length,
    });
  } catch (err) {
    next(err);
  }
});

// 9. POST /conversations/:id/reply
const sendReplySchema = z.object({
  content: z.string().min(1),
  sender_type: z.enum(['human_admin', 'llm_bot']),
});

inboxRouter.post('/conversations/:id/reply', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const conversationId = parseInt(req.params.id, 10);
    const payload = sendReplySchema.parse(req.body);

    if (isNaN(conversationId)) {
      throw new BadRequestError('Invalid ID');
    }

    const conversation = await prisma.conversations.findFirst({
      where: { id: conversationId, account_id: accountId },
    });
    if (!conversation) {
      throw new NotFoundError('Conversation not found.');
    }

    const msg = await prisma.messages.create({
      data: {
        account_id: accountId,
        conversation_id: conversationId,
        sender_name: req.user.fullName || 'Admin',
        sender_external_id: String(req.user.id),
        direction: 'OUTBOUND',
        sender_type: payload.sender_type === 'llm_bot' ? 'SYSTEM' : 'HUMAN_ADMIN',
        content: payload.content,
        delivery_status: 'SENT',
        metadata_json: {},
      },
    });

    return res.status(201).json({
      id: msg.id,
      conversation_id: msg.conversation_id,
      sender_name: msg.sender_name,
      sender_external_id: msg.sender_external_id,
      direction: msg.direction,
      content: msg.content,
      created_at: msg.created_at,
    });
  } catch (err) {
    next(err);
  }
});

export default inboxRouter;
