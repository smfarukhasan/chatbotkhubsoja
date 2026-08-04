import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../../core/db.js';
import { requireUser, AuthenticatedRequest } from '../../../middlewares/auth.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../../core/errors.js';
import { FacebookGraphAPIClient } from '../../../integrations/facebook/client.js';
import { tokenCipher } from '../../../utils/crypto.js';
import { generateCompletion } from '../../../services/llm_service.js';

export const aiRouter = Router();
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

// Serialization helpers (lowercase enum-ish fields expected by the frontend)
const agentOverviewResponse = (agent: any) => ({
  id: agent.id,
  account_id: agent.account_id,
  platform_connection_id: agent.platform_connection_id,
  name: agent.name,
  business_type: agent.business_type,
  status: agent.status.toLowerCase(),
  settings_json: agent.settings_json || {},
  behavior_json: agent.behavior_json || {},
  prompt_count: agent._count?.ai_prompts ?? 0,
  knowledge_source_count: agent._count?.ai_knowledge_sources ?? 0,
  faq_count: agent._count?.faq_knowledge ?? 0,
  created_at: agent.created_at,
  updated_at: agent.updated_at,
});

const agentResponse = (agent: any) => ({
  id: agent.id,
  account_id: agent.account_id,
  platform_connection_id: agent.platform_connection_id,
  name: agent.name,
  business_type: agent.business_type,
  status: agent.status.toLowerCase(),
  settings_json: agent.settings_json || {},
  behavior_json: agent.behavior_json || {},
  created_at: agent.created_at,
  updated_at: agent.updated_at,
});

const promptResponse = (prompt: any) => ({
  ...prompt,
  prompt_type: prompt.prompt_type.toLowerCase(),
});

const knowledgeResponse = (source: any) => ({
  ...source,
  source_type: source.source_type.toLowerCase(),
  status: source.status.toLowerCase(),
  metadata_json: source.metadata_json || {},
});

const faqResponse = (faq: any) => ({
  ...faq,
  tags_json: Array.isArray(faq.tags_json) ? faq.tags_json : [],
});

const PROMPT_TYPES = ['SYSTEM_INSTRUCTION', 'INBOX_REPLY', 'COMMENT_REPLY', 'POST_GENERATION'];

// Resolution precedence per type:
// (ai_agent_id AND platform_connection_id) -> platform_connection_id only ->
// ai_agent_id only -> account-global.
async function resolvePrompt(
  accountId: number,
  promptType: string,
  aiAgentId?: number | null,
  platformConnectionId?: number | null
): Promise<{ prompt: any; source_scope: string }> {
  const baseWhere: any = {
    account_id: accountId,
    prompt_type: promptType,
    is_active: true,
  };

  const levels: Array<{ scope: string; where: any }> = [];
  if (aiAgentId && platformConnectionId) {
    levels.push({
      scope: 'agent+connection',
      where: { ai_agent_id: aiAgentId, platform_connection_id: platformConnectionId },
    });
  }
  if (platformConnectionId) {
    levels.push({
      scope: 'connection',
      where: { platform_connection_id: platformConnectionId, ai_agent_id: null },
    });
  }
  if (aiAgentId) {
    levels.push({
      scope: 'agent',
      where: { ai_agent_id: aiAgentId, platform_connection_id: null },
    });
  }
  levels.push({ scope: 'account', where: { ai_agent_id: null, platform_connection_id: null } });

  for (const level of levels) {
    const prompt = await prisma.ai_prompts.findFirst({
      where: { ...baseWhere, ...level.where },
      orderBy: { updated_at: 'desc' },
    });
    if (prompt) {
      return { prompt, source_scope: level.scope };
    }
  }
  return { prompt: null, source_scope: 'account' };
}

// 1. GET /agents
aiRouter.get('/agents', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);

    const agents = await prisma.ai_agents.findMany({
      where: { account_id: accountId },
      orderBy: { created_at: 'desc' },
      include: {
        _count: {
          select: {
            ai_prompts: true,
            ai_knowledge_sources: true,
            faq_knowledge: true,
          },
        },
      },
    });

    return res.json(agents.map(agentOverviewResponse));
  } catch (err) {
    next(err);
  }
});

// 2. GET /agents/:agentId
aiRouter.get('/agents/:agentId', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const agentId = parseInt(req.params.agentId, 10);
    if (isNaN(agentId)) {
      throw new BadRequestError('Invalid agent ID.');
    }

    const agent = await prisma.ai_agents.findFirst({
      where: { id: agentId, account_id: accountId },
      include: {
        _count: {
          select: {
            ai_prompts: true,
            ai_knowledge_sources: true,
            faq_knowledge: true,
          },
        },
      },
    });

    if (!agent) {
      throw new NotFoundError('AI agent not found.');
    }

    return res.json(agentOverviewResponse(agent));
  } catch (err) {
    next(err);
  }
});

// 3. POST /agents
const createAgentSchema = z.object({
  name: z.string().min(1),
  business_type: z.string().optional().nullable(),
  platform_connection_id: z.number().optional().nullable(),
  status: z.enum(['draft', 'active', 'paused', 'archived']).optional(),
  settings_json: z.record(z.any()).optional().nullable(),
  behavior_json: z.record(z.any()).optional().nullable(),
});

aiRouter.post('/agents', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const payload = createAgentSchema.parse(req.body);

    const agent = await prisma.ai_agents.create({
      data: {
        account_id: accountId,
        name: payload.name,
        business_type: payload.business_type ?? null,
        platform_connection_id: payload.platform_connection_id ?? null,
        status: (payload.status ?? 'draft').toUpperCase() as any,
        settings_json: payload.settings_json ?? {},
        behavior_json: payload.behavior_json ?? {},
      },
    });

    return res.status(201).json(agentResponse(agent));
  } catch (err) {
    next(err);
  }
});

// 4. PUT /agents/:agentId
const updateAgentSchema = z.object({
  name: z.string().min(1).optional(),
  business_type: z.string().optional().nullable(),
  platform_connection_id: z.number().optional().nullable(),
  status: z.enum(['draft', 'active', 'paused', 'archived']).optional(),
  settings_json: z.record(z.any()).optional().nullable(),
  behavior_json: z.record(z.any()).optional().nullable(),
});

aiRouter.put('/agents/:agentId', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const agentId = parseInt(req.params.agentId, 10);
    if (isNaN(agentId)) {
      throw new BadRequestError('Invalid agent ID.');
    }
    const payload = updateAgentSchema.parse(req.body);

    const agent = await prisma.ai_agents.findFirst({
      where: { id: agentId, account_id: accountId },
    });

    if (!agent) {
      throw new NotFoundError('AI agent not found.');
    }

    const updated = await prisma.ai_agents.update({
      where: { id: agent.id },
      data: {
        name: payload.name !== undefined ? payload.name : agent.name,
        business_type: payload.business_type !== undefined ? payload.business_type : agent.business_type,
        platform_connection_id: payload.platform_connection_id !== undefined ? payload.platform_connection_id : agent.platform_connection_id,
        status: payload.status !== undefined ? (payload.status.toUpperCase() as any) : agent.status,
        settings_json: payload.settings_json !== undefined ? (payload.settings_json ?? {}) : (agent.settings_json as any),
        behavior_json: payload.behavior_json !== undefined ? (payload.behavior_json ?? {}) : (agent.behavior_json as any),
      },
    });

    return res.json(agentResponse(updated));
  } catch (err) {
    next(err);
  }
});

// 5. GET /prompts
aiRouter.get('/prompts', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const aiAgentId = req.query.ai_agent_id ? parseInt(req.query.ai_agent_id as string, 10) : undefined;
    const connectionId = req.query.platform_connection_id ? parseInt(req.query.platform_connection_id as string, 10) : undefined;

    const where: any = { account_id: accountId };
    if (aiAgentId) {
      where.ai_agent_id = aiAgentId;
    }
    if (connectionId) {
      where.platform_connection_id = connectionId;
    }

    const items = await prisma.ai_prompts.findMany({
      where,
      orderBy: { created_at: 'desc' },
    });

    return res.json(items.map(promptResponse));
  } catch (err) {
    next(err);
  }
});

// 6. GET /prompts/resolve/current  (registered before /prompts/:promptId)
aiRouter.get('/prompts/resolve/current', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const aiAgentId = req.query.ai_agent_id ? parseInt(req.query.ai_agent_id as string, 10) : undefined;
    const connectionId = req.query.platform_connection_id ? parseInt(req.query.platform_connection_id as string, 10) : undefined;

    const results = [];
    for (const promptType of PROMPT_TYPES) {
      const { prompt, source_scope } = await resolvePrompt(accountId, promptType, aiAgentId, connectionId);
      results.push({
        prompt_type: promptType.toLowerCase(),
        source_scope,
        prompt: prompt ? promptResponse(prompt) : null,
      });
    }

    return res.json(results);
  } catch (err) {
    next(err);
  }
});

// 7. POST /prompts
const createPromptSchema = z.object({
  prompt_type: z.enum(['system_instruction', 'inbox_reply', 'comment_reply', 'post_generation']),
  title: z.string().min(1),
  content: z.string().min(1),
  ai_agent_id: z.number().optional().nullable(),
  platform_connection_id: z.number().optional().nullable(),
  is_active: z.boolean().optional(),
  notes: z.string().optional().nullable(),
});

aiRouter.post('/prompts', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const payload = createPromptSchema.parse(req.body);

    const prompt = await prisma.ai_prompts.create({
      data: {
        account_id: accountId,
        prompt_type: payload.prompt_type.toUpperCase() as any,
        title: payload.title,
        content: payload.content,
        version: 1,
        ai_agent_id: payload.ai_agent_id ?? null,
        platform_connection_id: payload.platform_connection_id ?? null,
        is_active: payload.is_active ?? true,
        notes: payload.notes ?? null,
      },
    });

    return res.status(201).json(promptResponse(prompt));
  } catch (err) {
    next(err);
  }
});

// 8. PUT /prompts/:promptId
const updatePromptSchema = z.object({
  prompt_type: z.enum(['system_instruction', 'inbox_reply', 'comment_reply', 'post_generation']).optional(),
  title: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  ai_agent_id: z.number().optional().nullable(),
  platform_connection_id: z.number().optional().nullable(),
  is_active: z.boolean().optional(),
  notes: z.string().optional().nullable(),
});

aiRouter.put('/prompts/:promptId', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const promptId = parseInt(req.params.promptId, 10);
    if (isNaN(promptId)) {
      throw new BadRequestError('Invalid prompt ID.');
    }
    const payload = updatePromptSchema.parse(req.body);

    const prompt = await prisma.ai_prompts.findFirst({
      where: { id: promptId, account_id: accountId },
    });

    if (!prompt) {
      throw new NotFoundError('Prompt not found.');
    }

    const contentChanged = payload.content !== undefined && payload.content !== prompt.content;

    const updated = await prisma.ai_prompts.update({
      where: { id: prompt.id },
      data: {
        prompt_type: payload.prompt_type !== undefined ? (payload.prompt_type.toUpperCase() as any) : prompt.prompt_type,
        title: payload.title !== undefined ? payload.title : prompt.title,
        content: payload.content !== undefined ? payload.content : prompt.content,
        ai_agent_id: payload.ai_agent_id !== undefined ? payload.ai_agent_id : prompt.ai_agent_id,
        platform_connection_id: payload.platform_connection_id !== undefined ? payload.platform_connection_id : prompt.platform_connection_id,
        is_active: payload.is_active !== undefined ? payload.is_active : prompt.is_active,
        notes: payload.notes !== undefined ? payload.notes : prompt.notes,
        version: contentChanged ? (prompt.version || 1) + 1 : prompt.version,
      },
    });

    return res.json(promptResponse(updated));
  } catch (err) {
    next(err);
  }
});

// 9. GET /knowledge-sources
aiRouter.get('/knowledge-sources', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const aiAgentId = req.query.ai_agent_id ? parseInt(req.query.ai_agent_id as string, 10) : undefined;

    const where: any = { account_id: accountId };
    if (aiAgentId) {
      where.ai_agent_id = aiAgentId;
    }
    if (req.query.kind === 'conversation_style') {
      where.metadata_json = { path: '$.kind', equals: 'conversation_style' };
    }

    const items = await prisma.ai_knowledge_sources.findMany({
      where,
      orderBy: { created_at: 'desc' },
    });

    return res.json(items.map(knowledgeResponse));
  } catch (err) {
    next(err);
  }
});

// 9b. POST /knowledge-sources/from-conversations  (registered before the generic /knowledge-sources routes)
const fromConversationsSchema = z.object({
  conversation_ids: z.array(z.number().int().positive()).min(1),
  ai_agent_id: z.number().int().positive().optional().nullable(),
});

const truncateText = (text: string, maxLength: number): string => {
  const trimmed = (text || '').trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}...` : trimmed;
};

aiRouter.post('/knowledge-sources/from-conversations', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const payload = fromConversationsSchema.parse(req.body);

    const items: any[] = [];
    let skipped = 0;

    for (const conversationId of payload.conversation_ids) {
      const conversation = await prisma.conversations.findFirst({
        where: { id: conversationId, account_id: accountId },
      });
      if (!conversation) {
        skipped += 1;
        continue;
      }

      const messages = await prisma.messages.findMany({
        where: { conversation_id: conversationId, account_id: accountId },
        orderBy: { created_at: 'asc' },
      });

      // CUSTOMER message followed by a HUMAN_ADMIN OUTBOUND reply = one style pair (owner's tone); LLM_BOT/SYSTEM replies never qualify.
      const pairs: string[] = [];
      for (let i = 0; i < messages.length - 1 && pairs.length < 5; i++) {
        const customerMsg = messages[i];
        if (customerMsg.sender_type !== 'CUSTOMER' || customerMsg.direction !== 'INBOUND') continue;
        const ownerReply = messages[i + 1];
        if (ownerReply.sender_type !== 'HUMAN_ADMIN' || ownerReply.direction !== 'OUTBOUND') continue;
        pairs.push(
          `Customer: ${truncateText(customerMsg.content, 300)}\nOwner: ${truncateText(ownerReply.content, 300)}`
        );
        i += 1;
      }

      if (pairs.length === 0) continue;

      const title = `Style examples — ${conversation.customer_name || conversation.customer_external_id}`;
      const contentText = pairs.join('\n\n');
      const metadata = {
        kind: 'conversation_style',
        conversation_id: conversationId,
        customer_name: conversation.customer_name,
        pair_count: pairs.length,
      };

      const existing = await prisma.ai_knowledge_sources.findFirst({
        where: {
          account_id: accountId,
          AND: [
            { metadata_json: { path: '$.kind', equals: 'conversation_style' } },
            { metadata_json: { path: '$.conversation_id', equals: conversationId } },
          ],
        },
      });

      const row = existing
        ? await prisma.ai_knowledge_sources.update({
            where: { id: existing.id },
            data: {
              title,
              source_type: 'TEXT' as any,
              status: 'READY' as any,
              ai_agent_id: payload.ai_agent_id ?? null,
              content_text: contentText,
              metadata_json: metadata,
            },
          })
        : await prisma.ai_knowledge_sources.create({
            data: {
              account_id: accountId,
              title,
              source_type: 'TEXT' as any,
              status: 'READY' as any,
              ai_agent_id: payload.ai_agent_id ?? null,
              content_text: contentText,
              metadata_json: metadata,
            },
          });

      items.push(row);
    }

    return res.status(201).json({ items: items.map(knowledgeResponse), skipped });
  } catch (err) {
    next(err);
  }
});

// 10. POST /knowledge-sources
const createKnowledgeSchema = z.object({
  title: z.string().min(1),
  source_type: z.enum(['file', 'url', 'text']),
  ai_agent_id: z.number().optional().nullable(),
  description: z.string().optional().nullable(),
  content_text: z.string().optional().nullable(),
  file_name: z.string().optional().nullable(),
  file_size: z.number().optional().nullable(),
  mime_type: z.string().optional().nullable(),
  storage_key: z.string().optional().nullable(),
  metadata_json: z.record(z.any()).optional().nullable(),
});

aiRouter.post('/knowledge-sources', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const payload = createKnowledgeSchema.parse(req.body);

    const status = payload.source_type === 'text' || payload.source_type === 'url' ? 'READY' : 'DRAFT';

    const source = await prisma.ai_knowledge_sources.create({
      data: {
        account_id: accountId,
        title: payload.title,
        source_type: payload.source_type.toUpperCase() as any,
        status: status as any,
        ai_agent_id: payload.ai_agent_id ?? null,
        description: payload.description ?? null,
        content_text: payload.content_text ?? null,
        file_name: payload.file_name ?? null,
        file_size: payload.file_size ?? null,
        mime_type: payload.mime_type ?? null,
        storage_key: payload.storage_key ?? null,
        metadata_json: payload.metadata_json ?? {},
      },
    });

    return res.status(201).json(knowledgeResponse(source));
  } catch (err) {
    next(err);
  }
});

// 11. PUT /knowledge-sources/:sourceId
const updateKnowledgeSchema = z.object({
  title: z.string().min(1).optional(),
  source_type: z.enum(['file', 'url', 'text']).optional(),
  ai_agent_id: z.number().optional().nullable(),
  description: z.string().optional().nullable(),
  content_text: z.string().optional().nullable(),
  file_name: z.string().optional().nullable(),
  file_size: z.number().optional().nullable(),
  mime_type: z.string().optional().nullable(),
  storage_key: z.string().optional().nullable(),
  metadata_json: z.record(z.any()).optional().nullable(),
});

aiRouter.put('/knowledge-sources/:sourceId', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const sourceId = parseInt(req.params.sourceId, 10);
    if (isNaN(sourceId)) {
      throw new BadRequestError('Invalid knowledge source ID.');
    }
    const payload = updateKnowledgeSchema.parse(req.body);

    const source = await prisma.ai_knowledge_sources.findFirst({
      where: { id: sourceId, account_id: accountId },
    });

    if (!source) {
      throw new NotFoundError('Knowledge source not found.');
    }

    const updated = await prisma.ai_knowledge_sources.update({
      where: { id: source.id },
      data: {
        title: payload.title !== undefined ? payload.title : source.title,
        source_type: payload.source_type !== undefined ? (payload.source_type.toUpperCase() as any) : source.source_type,
        ai_agent_id: payload.ai_agent_id !== undefined ? payload.ai_agent_id : source.ai_agent_id,
        description: payload.description !== undefined ? payload.description : source.description,
        content_text: payload.content_text !== undefined ? payload.content_text : source.content_text,
        file_name: payload.file_name !== undefined ? payload.file_name : source.file_name,
        file_size: payload.file_size !== undefined ? payload.file_size : source.file_size,
        mime_type: payload.mime_type !== undefined ? payload.mime_type : source.mime_type,
        storage_key: payload.storage_key !== undefined ? payload.storage_key : source.storage_key,
        metadata_json: payload.metadata_json !== undefined ? (payload.metadata_json ?? {}) : (source.metadata_json as any),
      },
    });

    return res.json(knowledgeResponse(updated));
  } catch (err) {
    next(err);
  }
});

// 11b. DELETE /knowledge-sources/:sourceId
aiRouter.delete('/knowledge-sources/:sourceId', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const sourceId = parseInt(req.params.sourceId, 10);
    if (isNaN(sourceId)) {
      throw new BadRequestError('Invalid knowledge source ID.');
    }

    const source = await prisma.ai_knowledge_sources.findFirst({
      where: { id: sourceId, account_id: accountId },
    });

    if (!source) {
      throw new NotFoundError('Knowledge source not found.');
    }

    await prisma.ai_knowledge_sources.delete({ where: { id: source.id } });

    return res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// 12. GET /faq
aiRouter.get('/faq', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const aiAgentId = req.query.ai_agent_id ? parseInt(req.query.ai_agent_id as string, 10) : undefined;

    const where: any = { account_id: accountId };
    if (aiAgentId) {
      where.ai_agent_id = aiAgentId;
    }

    const items = await prisma.faq_knowledge.findMany({
      where,
      orderBy: { created_at: 'desc' },
    });

    return res.json(items.map(faqResponse));
  } catch (err) {
    next(err);
  }
});

// 13. POST /faq
const createFaqSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  ai_agent_id: z.number().optional().nullable(),
  tags: z.array(z.string()).optional(),
  is_active: z.boolean().optional(),
});

aiRouter.post('/faq', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const payload = createFaqSchema.parse(req.body);

    const faq = await prisma.faq_knowledge.create({
      data: {
        account_id: accountId,
        question: payload.question,
        answer: payload.answer,
        ai_agent_id: payload.ai_agent_id ?? null,
        tags_json: payload.tags || [],
        is_active: payload.is_active ?? true,
      },
    });

    return res.status(201).json(faqResponse(faq));
  } catch (err) {
    next(err);
  }
});

// 14. PUT /faq/:faqId
const updateFaqSchema = z.object({
  question: z.string().min(1).optional(),
  answer: z.string().min(1).optional(),
  ai_agent_id: z.number().optional().nullable(),
  tags: z.array(z.string()).optional(),
  is_active: z.boolean().optional(),
});

aiRouter.put('/faq/:faqId', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const faqId = parseInt(req.params.faqId, 10);
    if (isNaN(faqId)) {
      throw new BadRequestError('Invalid FAQ ID.');
    }
    const payload = updateFaqSchema.parse(req.body);

    const faq = await prisma.faq_knowledge.findFirst({
      where: { id: faqId, account_id: accountId },
    });

    if (!faq) {
      throw new NotFoundError('FAQ entry not found.');
    }

    const updated = await prisma.faq_knowledge.update({
      where: { id: faq.id },
      data: {
        question: payload.question !== undefined ? payload.question : faq.question,
        answer: payload.answer !== undefined ? payload.answer : faq.answer,
        ai_agent_id: payload.ai_agent_id !== undefined ? payload.ai_agent_id : faq.ai_agent_id,
        tags_json: payload.tags !== undefined ? payload.tags : (faq.tags_json as any),
        is_active: payload.is_active !== undefined ? payload.is_active : faq.is_active,
      },
    });

    return res.json(faqResponse(updated));
  } catch (err) {
    next(err);
  }
});

// 15. POST /generation/inbox-reply
const inboxReplyGenerationSchema = z.object({
  conversation_id: z.number(),
  ai_agent_id: z.number().optional().nullable(),
  platform_connection_id: z.number().optional().nullable(),
  instructions: z.string().optional().nullable(),
  send_now: z.boolean().optional(),
  persist_draft: z.boolean().optional(),
});

aiRouter.post('/generation/inbox-reply', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const payload = inboxReplyGenerationSchema.parse(req.body);

    const conversation = await prisma.conversations.findFirst({
      where: { id: payload.conversation_id, account_id: accountId },
    });
    if (!conversation) {
      throw new NotFoundError('Conversation not found.');
    }

    const aiAgentId = payload.ai_agent_id ?? null;
    const connectionId = payload.platform_connection_id ?? conversation.platform_connection_id ?? null;

    const resolved = await resolvePrompt(accountId, 'INBOX_REPLY', aiAgentId, connectionId);

    const recentMessages = await prisma.messages.findMany({
      where: { conversation_id: conversation.id, account_id: accountId },
      orderBy: { created_at: 'desc' },
      take: 5,
    });
    const history = recentMessages.reverse().map((m) => `${m.sender_type}: ${m.content}`).join('\n');

    const promptTextParts: string[] = [];
    if (resolved.prompt) {
      promptTextParts.push(resolved.prompt.content);
    }
    promptTextParts.push(
      `Customer name: ${conversation.customer_name || 'Unknown'}`,
      `Latest message: ${conversation.latest_message_preview || ''}`
    );
    if (history) {
      promptTextParts.push(`Conversation history:\n${history}`);
    }
    const promptText = promptTextParts.join('\n\n');

    const completion = await generateCompletion({
      accountId,
      actorUserId: req.user.id,
      promptText,
      promptType: 'INBOX_REPLY',
      aiAgentId,
      platformConnectionId: connectionId,
      featureName: 'INBOX_REPLY',
      referenceType: 'conversation',
      referenceId: String(conversation.id),
      instructions: payload.instructions ?? null,
    });

    let pageToken: string | null = null;
    if (payload.send_now) {
      if (!conversation.platform_connection_id) {
        throw new BadRequestError('No platform connection linked to this conversation.');
      }
      const connection = await prisma.platformConnection.findFirst({
        where: { id: conversation.platform_connection_id, accountId },
      });
      if (!connection || !connection.encryptedAccessToken) {
        throw new BadRequestError('Platform connection token not found.');
      }
      pageToken = tokenCipher.decrypt(connection.encryptedAccessToken);
      if (!pageToken) {
        throw new BadRequestError('Failed to decrypt page token.');
      }
    }

    let messageRow: any = null;
    const shouldPersist = Boolean(payload.persist_draft) || Boolean(payload.send_now);
    if (shouldPersist) {
      messageRow = await prisma.messages.create({
        data: {
          account_id: accountId,
          conversation_id: conversation.id,
          sender_type: 'LLM_BOT',
          direction: 'OUTBOUND',
          delivery_status: 'PENDING',
          content: completion.content,
          created_by_user_id: req.user.id,
          metadata_json: {},
        },
      });
    }

    if (payload.send_now) {
      try {
        const result = await fbClient.sendMessage(pageToken as string, conversation.customer_external_id, completion.content);
        const externalMessageId = String(result?.message_id || result?.id || '') || null;
        if (messageRow) {
          await prisma.messages.update({
            where: { id: messageRow.id },
            data: {
              delivery_status: 'SENT',
              external_message_id: externalMessageId,
            },
          });
        }
      } catch (err: any) {
        const errorMessage = err.message || 'Facebook API error during send.';
        if (messageRow) {
          await prisma.messages.update({
            where: { id: messageRow.id },
            data: { delivery_status: 'FAILED', error_message: errorMessage },
          });
        }
        throw new BadRequestError(`Facebook API send failed: ${errorMessage}`);
      }

      // Auto-pause AI chat so the bot does not interfere mid-conversation.
      const pauseUntil = new Date(Date.now() + 15 * 60 * 1000);
      await prisma.conversations.update({
        where: { id: conversation.id },
        data: {
          metadata_json: {
            ...(conversation.metadata_json as any || {}),
            ai_chat: { mode: 'manual', manual_until: pauseUntil.toISOString() },
          },
        },
      });
    }

    const requiresApproval = !payload.send_now && Boolean(payload.persist_draft);

    return res.status(201).json({
      content: completion.content,
      requires_approval: requiresApproval,
      provider: completion.provider,
      model_name: completion.modelName,
      prompt_tokens: completion.promptTokens,
      completion_tokens: completion.completionTokens,
      total_tokens: completion.totalTokens,
      prompt_id: resolved.prompt ? resolved.prompt.id : null,
      prompt_scope: resolved.source_scope,
      ai_agent_id: aiAgentId,
      platform_connection_id: connectionId,
      draft_reference_type: messageRow ? 'message' : null,
      draft_object_id: messageRow ? messageRow.id : null,
    });
  } catch (err) {
    next(err);
  }
});

// 16. POST /generation/comment-reply
const commentReplyGenerationSchema = z.object({
  comment_id: z.number(),
  ai_agent_id: z.number().optional().nullable(),
  instructions: z.string().optional().nullable(),
  send_now: z.boolean().optional(),
  persist_draft: z.boolean().optional(),
});

aiRouter.post('/generation/comment-reply', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const payload = commentReplyGenerationSchema.parse(req.body);

    const comment = await prisma.facebook_comments.findFirst({
      where: { id: payload.comment_id, account_id: accountId },
    });
    if (!comment) {
      throw new NotFoundError('Comment not found.');
    }

    const aiAgentId = payload.ai_agent_id ?? null;
    const connectionId = comment.platform_connection_id ?? null;

    const resolved = await resolvePrompt(accountId, 'COMMENT_REPLY', aiAgentId, connectionId);

    const promptTextParts: string[] = [];
    if (resolved.prompt) {
      promptTextParts.push(resolved.prompt.content);
    }
    promptTextParts.push(
      `Commenter name: ${comment.commenter_name || 'Unknown'}`,
      `Comment: ${comment.comment_text}`
    );
    if (payload.instructions) {
      promptTextParts.push(`Instructions: ${payload.instructions}`);
    }
    const promptText = promptTextParts.join('\n\n');

    const completion = await generateCompletion({
      accountId,
      actorUserId: req.user.id,
      promptText,
      promptType: 'COMMENT_REPLY',
      aiAgentId,
      platformConnectionId: connectionId,
      featureName: 'COMMENT_REPLY',
      referenceType: 'facebook_comment',
      referenceId: String(comment.id),
      instructions: payload.instructions ?? null,
    });

    let replyRow: any = null;
    let draftObjectType: string | null = null;
    let draftObjectId: number | null = null;

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

      replyRow = await prisma.facebook_comment_replies.create({
        data: {
          account_id: accountId,
          comment_id: comment.id,
          created_by_user_id: req.user.id,
          sender_type: 'LLM_BOT',
          reply_status: 'DRAFT',
          content: completion.content,
          metadata_json: {},
        },
      });
      draftObjectType = 'facebook_comment_reply';
      draftObjectId = replyRow.id;

      try {
        const result = await fbClient.replyToComment(pageToken, comment.external_comment_id, completion.content);
        const externalReplyId = String(result?.id || '') || null;
        await prisma.facebook_comment_replies.update({
          where: { id: replyRow.id },
          data: {
            reply_status: 'SENT',
            external_reply_id: externalReplyId,
            sent_at: new Date(),
          },
        });
        await prisma.facebook_comments.update({
          where: { id: comment.id },
          data: { status: 'REPLIED', last_replied_at: new Date() },
        });
      } catch (err: any) {
        const errorMessage = err.message || 'Facebook API error during comment reply.';
        await prisma.facebook_comment_replies.update({
          where: { id: replyRow.id },
          data: { reply_status: 'FAILED', error_message: errorMessage },
        });
        throw new BadRequestError(`Facebook API comment reply failed: ${errorMessage}`);
      }
    } else if (payload.persist_draft) {
      await prisma.facebook_comments.update({
        where: { id: comment.id },
        data: { ai_draft_reply: completion.content },
      });
      draftObjectType = 'facebook_comment';
      draftObjectId = comment.id;
    }

    const requiresApproval = !payload.send_now;

    return res.status(201).json({
      content: completion.content,
      requires_approval: requiresApproval,
      provider: completion.provider,
      model_name: completion.modelName,
      prompt_tokens: completion.promptTokens,
      completion_tokens: completion.completionTokens,
      total_tokens: completion.totalTokens,
      prompt_id: resolved.prompt ? resolved.prompt.id : null,
      prompt_scope: resolved.source_scope,
      ai_agent_id: aiAgentId,
      platform_connection_id: connectionId,
      draft_reference_type: draftObjectType,
      draft_object_id: draftObjectId,
    });
  } catch (err) {
    next(err);
  }
});

// 17. POST /generation/post
const postGenerationSchema = z.object({
  platform_connection_id: z.number().optional().nullable(),
  ai_agent_id: z.number().optional().nullable(),
  post_id: z.number().optional().nullable(),
  title_hint: z.string().optional().nullable(),
  instructions: z.string().optional().nullable(),
  persist_draft: z.boolean().optional(),
});

aiRouter.post('/generation/post', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const payload = postGenerationSchema.parse(req.body);

    const aiAgentId = payload.ai_agent_id ?? null;
    const agent = aiAgentId
      ? await prisma.ai_agents.findFirst({ where: { id: aiAgentId, account_id: accountId } })
      : null;
    const connectionId = payload.platform_connection_id ?? agent?.platform_connection_id ?? null;

    const resolved = await resolvePrompt(accountId, 'POST_GENERATION', aiAgentId, connectionId);

    const promptTextParts: string[] = [];
    if (resolved.prompt) {
      promptTextParts.push(resolved.prompt.content);
    }
    if (payload.title_hint) {
      promptTextParts.push(`Title hint: ${payload.title_hint}`);
    }
    if (payload.instructions) {
      promptTextParts.push(`Instructions: ${payload.instructions}`);
    }
    const promptText = promptTextParts.join('\n\n');

    const completion = await generateCompletion({
      accountId,
      actorUserId: req.user.id,
      promptText,
      promptType: 'POST_GENERATION',
      aiAgentId,
      platformConnectionId: connectionId,
      featureName: 'POST_GENERATION',
      referenceType: 'social_post',
      referenceId: payload.post_id ? String(payload.post_id) : null,
      instructions: payload.instructions ?? null,
    });

    const title = payload.title_hint || (agent?.business_type ? `${agent.business_type} update` : 'AI-generated post');
    const promptId = resolved.prompt ? resolved.prompt.id : null;

    let post: any;
    if (payload.post_id) {
      post = await prisma.social_posts.findFirst({
        where: { id: payload.post_id, account_id: accountId },
      });
      if (!post) {
        throw new NotFoundError('Post not found.');
      }
      const updateData: any = {
        title,
        content: completion.content,
        generated_by: 'LLM_BOT',
        is_llm_generated: true,
        requires_approval: true,
      };
      if (aiAgentId) {
        updateData.ai_agent_id = aiAgentId;
      }
      if (promptId) {
        updateData.ai_prompt_id = promptId;
      }
      post = await prisma.social_posts.update({
        where: { id: post.id },
        data: updateData,
      });
    } else {
      post = await prisma.social_posts.create({
        data: {
          account_id: accountId,
          platform_connection_id: connectionId,
          ai_agent_id: aiAgentId,
          ai_prompt_id: promptId,
          platform_type: 'FACEBOOK_PAGE',
          status: 'DRAFT',
          generated_by: 'LLM_BOT',
          title,
          content: completion.content,
          media_urls: [],
          is_llm_generated: true,
          requires_approval: true,
          metadata_json: {},
        },
      });
    }

    return res.status(201).json({
      content: completion.content,
      requires_approval: true,
      provider: completion.provider,
      model_name: completion.modelName,
      prompt_tokens: completion.promptTokens,
      completion_tokens: completion.completionTokens,
      total_tokens: completion.totalTokens,
      prompt_id: promptId,
      prompt_scope: resolved.source_scope,
      ai_agent_id: aiAgentId,
      platform_connection_id: connectionId,
      draft_reference_type: 'social_post',
      draft_object_id: post.id,
    });
  } catch (err) {
    next(err);
  }
});

export default aiRouter;
