import { Worker, Job } from 'bullmq';
import { redisConnection, messagesQueue } from './queues.js';
import { prisma } from '../core/db.js';
import { logger } from '../core/logging.js';
import { tokenCipher } from '../utils/crypto.js';
import { FacebookGraphAPIClient } from '../integrations/facebook/client.js';
import { getAIChatState } from '../integrations/facebook/service.js';
import {
  generateCompletion,
  evaluateCustomerIntent,
  resolveIntentPolicy,
  buildIntentRefusal,
  DEFAULT_INTENT_POLICY_TEXT,
} from '../services/llm_service.js';

const fbClient = new FacebookGraphAPIClient();

const AUTO_REPLY_DEBOUNCE_MS = 6000;
const AUTO_REPLY_REGENERATE_WINDOW_MS = 4000;
const AUTO_REPLY_MAX_REGENERATIONS = 3;

// Extract the first customer message from a facebook_page webhook payload.
// Skips echo events (the page's own outgoing messages) and any sender that is the page itself.
const extractInboundMessage = (payload: any): { senderId: string; pageId: string; text: string; messageId: string | null; timestamp: string } | null => {
  for (const entry of payload?.entry || []) {
    const entryId = entry?.id ? String(entry.id) : null;
    for (const event of entry?.messaging || []) {
      if (event?.message?.is_echo) continue;
      const senderId = event?.sender?.id;
      const text = event?.message?.text;
      const messageId = event?.message?.mid;
      if (!senderId || !text || (entryId && senderId === entryId)) continue;
      const pageId = event?.recipient?.id || entryId;
      if (!pageId || senderId === pageId) continue;
      const timestamp = event?.timestamp || event?.message?.ts;
      return { senderId: String(senderId), pageId: String(pageId), text, messageId: messageId ? String(messageId) : null, timestamp: timestamp ? String(timestamp) : new Date().toISOString() };
    }
  }
  return null;
};

// Extract a comment event from a facebook_page webhook payload.
const extractInboundComment = (payload: any): { commentId: string; postId: string; commenterId: string; commenterName: string | null; text: string } | null => {
  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value;
      if (!value?.comment_id) continue;
      return {
        commentId: String(value.comment_id),
        postId: value.post_id ? String(value.post_id) : '',
        commenterId: value.from?.id ? String(value.from.id) : '',
        commenterName: value.from?.name ? String(value.from.name) : null,
        text: String(value.message || ''),
      };
    }
  }
  return null;
};

const parseMetadata = (value: any): Record<string, any> => {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value;
};

// Generate one reply for the conversation from its full message history.
async function generateReplyContent(accountId: number, connectionId: number, conversation: any): Promise<{ content: string; intentEval: any }> {
  const agent = await prisma.ai_agents.findFirst({
    where: { account_id: accountId, platform_connection_id: connectionId, status: 'ACTIVE' },
  });
  const aiAgentId = agent?.id ?? null;

  const recentMessages = await prisma.messages.findMany({
    where: { conversation_id: conversation.id, account_id: accountId },
    orderBy: { created_at: 'desc' },
    take: 20,
  });
  const history = recentMessages.slice(0, 8).reverse().map((m) => `${m.sender_type}: ${m.content}`).join('\n');
  const tail = recentMessages.slice().reverse().slice(-20).map((m) => `${m.sender_type}: ${m.content}`).join('\n').slice(0, 2000);

  const resolved = await resolvePromptForWorker(accountId, 'INBOX_REPLY', aiAgentId, connectionId);
  const promptTextParts: string[] = [];
  if (resolved.prompt) promptTextParts.push(resolved.prompt.content);
  promptTextParts.push(
    `Customer name: ${conversation.customer_name || 'Unknown'}`,
    `Latest message: ${conversation.latest_message_preview || ''}`
  );
  if (history) promptTextParts.push(`Conversation history:\n${history}`);
  const promptText = promptTextParts.join('\n\n');

  const policyText = (await resolveIntentPolicy(accountId, aiAgentId)) ?? DEFAULT_INTENT_POLICY_TEXT;
  const intentEval = await evaluateCustomerIntent(accountId, aiAgentId, tail, policyText);

  if (intentEval.intent === 'not_permitted' && intentEval.confidence >= 0.8) {
    return { content: buildIntentRefusal(), intentEval };
  }

  const steering: string[] = [];
  if (intentEval.intent === 'purchase') {
    steering.push('Sales steering: the customer shows purchase intent. Guide them toward completing the purchase — give price, availability, and payment details from the knowledge base. Keep the tone helpful and focused on closing the sale.');
  } else if (intentEval.intent === 'casual') {
    steering.push('Concise steering: the customer is chatting casually. Reply briefly and warmly, gently point them to the catalog or products, and do not over-engage.');
  } else {
    steering.push(`Policy refusal: the customer is requesting something not permitted by the page policy. Politely decline while staying helpful. Page policy: ${policyText}`);
  }
  const completion = await generateCompletion({
    accountId,
    actorUserId: null,
    promptText,
    promptType: 'INBOX_REPLY',
    aiAgentId,
    platformConnectionId: connectionId,
    featureName: 'INBOX_REPLY',
    referenceType: 'conversation',
    referenceId: String(conversation.id),
    instructions: steering.join('\n\n') || null,
    skipStyleExamples: intentEval.intent === 'not_permitted',
    skipProducts: intentEval.intent === 'not_permitted',
  });
  return { content: completion.content, intentEval };
}

const getLatestInboundMessage = (accountId: number, conversationId: number) =>
  prisma.messages.findFirst({
    where: {
      conversation_id: conversationId,
      account_id: accountId,
      sender_type: 'CUSTOMER',
      direction: 'INBOUND',
    },
    orderBy: { id: 'desc' },
  });

// Generate and send one reply for a conversation. Waits for the burst to settle
// (6s debounce), then generates; if a newer customer message arrives while the
// LLM is working, the reply is regenerated with the new text included (up to a
// 4s regeneration window), so a burst always gets exactly one unified reply.
async function generateAndSendReply(accountId: number, connection: any, conversation: any, expectedInboundMessageId: number): Promise<void> {
  const connectionId = connection.id;
  const pageToken = tokenCipher.decrypt(connection.encryptedAccessToken);
  if (!pageToken) {
    throw new Error('Connection has no decryptable page token.');
  }

  const aiState = getAIChatState(conversation.metadata_json);
  if (aiState.mode !== 'auto') {
    logger.info(`AI chat is ${aiState.mode} for conversation ${conversation.id} — skipping auto reply.`);
    return;
  }

  // Show "typing..." while we prepare the reply; ignore failures (indicator is best-effort).
  try {
    await fbClient.sendTypingIndicator(pageToken, conversation.customer_external_id, 'typing_on');
  } catch {
    // Typing indicator is best-effort; continue without it.
  }

  const regenerateDeadline = Date.now() + AUTO_REPLY_REGENERATE_WINDOW_MS;
  let lastInboundId = expectedInboundMessageId;
  let generation: { content: string; intentEval: any } | null = null;
  let regenerations = 0;

  for (;;) {
    generation = await generateReplyContent(accountId, connectionId, conversation);

    const latestInboundNow = await getLatestInboundMessage(accountId, conversation.id);
    if (!latestInboundNow || latestInboundNow.id === lastInboundId) {
      break;
    }

    if (Date.now() >= regenerateDeadline || regenerations >= AUTO_REPLY_MAX_REGENERATIONS) {
      logger.info(`Conversation ${conversation.id}: regeneration window exceeded — sending reply for latest message.`);
      break;
    }

    lastInboundId = latestInboundNow.id;
    regenerations += 1;
    logger.info(`Conversation ${conversation.id}: newer inbound message during generation — regenerating (${regenerations}).`);
  }

  if (!generation) {
    return;
  }
  const { content, intentEval } = generation;

  // Persist the outgoing bot message, then send via Graph API.
  const messageRow = await prisma.messages.create({
    data: {
      account_id: accountId,
      conversation_id: conversation.id,
      sender_type: 'LLM_BOT',
      direction: 'OUTBOUND',
      delivery_status: 'PENDING',
      content,
      metadata_json: {
        intent_eval: {
          intent: intentEval.intent,
          confidence: intentEval.confidence,
          reason: intentEval.reason,
        },
        auto_reply: true,
      },
    },
  });

  let externalMessageId: string | null = null;
  try {
    const result = await fbClient.sendMessage(pageToken, conversation.customer_external_id, content);
    externalMessageId = String(result?.message_id || result?.id || '') || null;
    await prisma.messages.update({
      where: { id: messageRow.id },
      data: { delivery_status: 'SENT', external_message_id: externalMessageId },
    });
  } catch (err: any) {
    await prisma.messages.update({
      where: { id: messageRow.id },
      data: { delivery_status: 'FAILED', error_message: String(err?.message || err).slice(0, 480) },
    });
    throw err;
  } finally {
    try {
      await fbClient.sendTypingIndicator(pageToken, conversation.customer_external_id, 'typing_off');
    } catch {
      // Best-effort.
    }
  }

  logger.info(`Auto-replied to conversation ${conversation.id} (${intentEval.intent}, ${intentEval.confidence}) — message ${externalMessageId || messageRow.id}`);
}

// Comment auto-reply: generate a public comment reply and post it when the post has auto-reply enabled.
async function autoReplyToComment(event: any, connection: any, comment: any): Promise<void> {
  const accountId = event.accountId;
  const pageToken = tokenCipher.decrypt(connection.encryptedAccessToken);
  if (!pageToken) return;

  if (!comment.post_external_id) return;
  const post = await prisma.social_posts.findFirst({
    where: { account_id: accountId, external_post_id: comment.post_external_id },
  });
  if (!post?.ai_auto_reply_enabled) return;

  const agent = await prisma.ai_agents.findFirst({
    where: { account_id: accountId, platform_connection_id: connection.id, status: 'ACTIVE' },
  });
  const aiAgentId = agent?.id ?? null;
  const resolved = await resolvePromptForWorker(accountId, 'COMMENT_REPLY', aiAgentId, connection.id);

  const promptTextParts: string[] = [];
  if (resolved.prompt) promptTextParts.push(resolved.prompt.content);
  promptTextParts.push(
    `Commenter name: ${comment.commenter_name || 'Unknown'}`,
    `Comment: ${comment.comment_text}`
  );
  const completion = await generateCompletion({
    accountId,
    actorUserId: null,
    promptText: promptTextParts.join('\n\n'),
    promptType: 'COMMENT_REPLY',
    aiAgentId,
    platformConnectionId: connection.id,
    featureName: 'COMMENT_REPLY',
    referenceType: 'facebook_comment',
    referenceId: String(comment.id),
    instructions: null,
  });

  const replyRow = await prisma.facebook_comment_replies.create({
    data: {
      account_id: accountId,
      comment_id: comment.id,
      sender_type: 'LLM_BOT',
      reply_status: 'DRAFT',
      content: completion.content,
      metadata_json: {},
    },
  });

  try {
    const result = await fbClient.replyToComment(pageToken, comment.external_comment_id, completion.content);
    const externalReplyId = String(result?.id || '') || null;
    await prisma.facebook_comment_replies.update({
      where: { id: replyRow.id },
      data: { reply_status: 'SENT', external_reply_id: externalReplyId, sent_at: new Date() },
    });
    await prisma.facebook_comments.update({
      where: { id: comment.id },
      data: { status: 'REPLIED', last_replied_at: new Date() },
    });
    logger.info(`Auto-replied to comment ${comment.id} (${externalReplyId || replyRow.id})`);
  } catch (err: any) {
    await prisma.facebook_comment_replies.update({
      where: { id: replyRow.id },
      data: { reply_status: 'FAILED', error_message: String(err?.message || err).slice(0, 480) },
    });
    throw err;
  }
}

// Prompt resolution with the same precedence as the API: agent+connection -> connection -> agent -> account.
async function resolvePromptForWorker(accountId: number, promptType: string, aiAgentId: number | null, connectionId: number | null): Promise<{ prompt: any; source_scope: string }> {
  const baseWhere: any = { account_id: accountId, prompt_type: promptType, is_active: true };
  const levels: Array<{ scope: string; where: any }> = [];
  if (aiAgentId && connectionId) {
    levels.push({ scope: 'agent+connection', where: { ai_agent_id: aiAgentId, platform_connection_id: connectionId } });
  }
  if (connectionId) {
    levels.push({ scope: 'connection', where: { platform_connection_id: connectionId, ai_agent_id: null } });
  }
  if (aiAgentId) {
    levels.push({ scope: 'agent', where: { ai_agent_id: aiAgentId, platform_connection_id: null } });
  }
  levels.push({ scope: 'account', where: { ai_agent_id: null, platform_connection_id: null } });

  for (const level of levels) {
    const prompt = await prisma.ai_prompts.findFirst({
      where: { ...baseWhere, ...level.where },
      orderBy: { updated_at: 'desc' },
    });
    if (prompt) return { prompt, source_scope: level.scope };
  }
  return { prompt: null, source_scope: 'account' };
}

// Main event processor: persists the inbound message/comment, then triggers auto-reply when applicable.
async function processWebhookEvent(event: any): Promise<void> {
  const payload = event.payloadJson || {};

  if (event.eventType === 'inbound_message' && event.platformType === 'FACEBOOK_PAGE') {
    const msg = extractInboundMessage(payload);
    if (!msg) {
      logger.info(`No actionable inbound message in event ${event.id} — ignoring.`);
      return;
    }

    if (!event.platformConnectionId) {
      logger.info(`Event ${event.id} has no platform connection — ignoring.`);
      return;
    }
    const connection = await prisma.platformConnection.findFirst({
      where: { id: event.platformConnectionId, accountId: event.accountId },
    });
    if (!connection) {
      logger.info(`Event ${event.id}: connection ${event.platformConnectionId} not found — ignoring.`);
      return;
    }

    const customerExternalId = msg.senderId;
    const pageId = msg.pageId;

    // Upsert the conversation
    let conversation = await prisma.conversations.findFirst({
      where: {
        account_id: event.accountId,
        platform_connection_id: connection.id,
        customer_external_id: customerExternalId,
      },
    });

    if (!conversation) {
      conversation = await prisma.conversations.create({
        data: {
          account_id: event.accountId,
          platform_connection_id: connection.id,
          platform_type: 'FACEBOOK_PAGE',
          external_thread_id: msg.senderId,
          customer_external_id: customerExternalId,
          customer_name: null,
          latest_message_preview: msg.text.slice(0, 480),
          latest_message_at: new Date(),
          last_inbound_at: new Date(),
          status: 'OPEN',
          metadata_json: { ai_chat: { mode: 'auto', manual_until: null } },
        },
      });
    } else {
      const metadata = parseMetadata(conversation.metadata_json);
      await prisma.conversations.update({
        where: { id: conversation.id },
        data: {
          latest_message_preview: msg.text.slice(0, 480),
          latest_message_at: new Date(),
          last_inbound_at: new Date(),
          status: 'OPEN',
          metadata_json: metadata,
        },
      });
    }

    // Persist the inbound customer message
    const inboundRow = await prisma.messages.create({
      data: {
        account_id: event.accountId,
        conversation_id: conversation.id,
        sender_type: 'CUSTOMER',
        direction: 'INBOUND',
        delivery_status: 'DELIVERED',
        sender_external_id: customerExternalId,
        external_message_id: msg.messageId,
        content: msg.text,
        metadata_json: { page_id: pageId, auto_reply: true },
      },
    });

    // Debounced auto-reply: schedule the reply job 5 seconds after this message.
    // If the customer sends more messages in that window, their jobs supersede this
    // one (the handler skips stale jobs), so one reply is generated for the whole burst.
    await messagesQueue.add(
      'auto_reply',
      {
        accountId: event.accountId,
        connectionId: connection.id,
        conversationId: conversation.id,
        lastInboundMessageId: inboundRow.id,
      },
      {
        delay: AUTO_REPLY_DEBOUNCE_MS,
        jobId: `auto_reply_${conversation.id}_${inboundRow.id}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: false,
      }
    );
    return;
  }

  if (event.eventType === 'inbound_comment' && event.platformType === 'FACEBOOK_PAGE') {
    const commentInfo = extractInboundComment(payload);
    if (!commentInfo) return;

    if (!event.platformConnectionId) return;
    const connection = await prisma.platformConnection.findFirst({
      where: { id: event.platformConnectionId, accountId: event.accountId },
    });
    if (!connection) return;

    let comment = await prisma.facebook_comments.findFirst({
      where: { account_id: event.accountId, external_comment_id: commentInfo.commentId },
    });

    if (!comment) {
      comment = await prisma.facebook_comments.create({
        data: {
          account_id: event.accountId,
          platform_connection_id: connection.id,
          platform_type: 'FACEBOOK_PAGE',
          post_external_id: commentInfo.postId || '',
          external_comment_id: commentInfo.commentId,
          commenter_external_id: commentInfo.commenterId || '',
          commenter_name: commentInfo.commenterName || null,
          comment_text: commentInfo.text,
          status: 'PENDING',
          metadata_json: {},
        },
      });
    } else {
      await prisma.facebook_comments.update({
        where: { id: comment.id },
        data: {
          comment_text: commentInfo.text,
          commenter_name: commentInfo.commenterName || comment.commenter_name,
        },
      });
    }

    await autoReplyToComment(event, connection, comment);
    return;
  }

  if (event.platformType === 'WHATSAPP') {
    logger.info(`Event ${event.id}: WhatsApp processing not yet implemented — stored only.`);
    return;
  }

  logger.info(`Event ${event.id}: unhandled type ${event.platformType}/${event.eventType} — stored only.`);
}

// BullMQ worker for the webhooks queue.
const webhookWorker = new Worker(
  'webhooks',
  async (job: Job<{ eventId: number }>) => {
    const eventId = job.data.eventId;
    const event = await prisma.webhookEvent.findUnique({ where: { id: eventId } });
    if (!event) {
      logger.warn(`Webhook event ${eventId} not found — skipping.`);
      return;
    }
    if (event.status !== 'PENDING') {
      logger.info(`Webhook event ${eventId} already ${event.status} — skipping.`);
      return;
    }

    await prisma.webhookEvent.update({
      where: { id: eventId },
      data: { status: 'PROCESSING', processingStartedAt: new Date(), attempts: { increment: 1 } },
    });

    try {
      await processWebhookEvent(event);
      await prisma.webhookEvent.update({
        where: { id: eventId },
        data: { status: 'PROCESSED', processedAt: new Date() },
      });
      logger.info(`Webhook event ${eventId} processed.`);
    } catch (err: any) {
      const errorMessage = String(err?.message || err).slice(0, 480);
      logger.error(`Webhook event ${eventId} failed:`, errorMessage);
      await prisma.webhookEvent.update({
        where: { id: eventId },
        data: { status: 'FAILED', errorMessage },
      });
      throw err;
    }
  },
  {
    connection: redisConnection as any,
    concurrency: 5,
  }
);

webhookWorker.on('completed', (job) => {
  logger.info(`Job ${job.id} completed.`);
});

webhookWorker.on('failed', (job, err) => {
  logger.error(`Job ${job?.id} failed:`, err.message);
});

logger.info('Webhook worker started. Consuming queue: webhooks');

// ---------------------------------------------------------------------------
// Messages queue: debounced auto-reply
// ---------------------------------------------------------------------------

interface AutoReplyJobData {
  accountId: number;
  connectionId: number;
  conversationId: number;
  lastInboundMessageId: number;
}

// Runs after the debounce window. If a newer customer message arrived since this
// job was scheduled, the job is stale (a newer job owns the reply) and it is skipped.
async function handleAutoReplyJob(job: Job<AutoReplyJobData>): Promise<void> {
  const { accountId, connectionId, conversationId, lastInboundMessageId } = job.data;

  const lockKey = `autoreply:lock:${conversationId}`;
  const lockAcquired = await redisConnection.set(lockKey, String(job.id ?? 'job'), 'EX', 45, 'NX');
  if (!lockAcquired) {
    logger.info(`Auto-reply job ${job.id}: conversation ${conversationId} already generating — skipping.`);
    return;
  }

  try {
    const conversation = await prisma.conversations.findFirst({
      where: { id: conversationId, account_id: accountId },
    });
    if (!conversation) {
      logger.info(`Auto-reply job ${job.id}: conversation ${conversationId} not found — skipping.`);
      return;
    }

    const latestInbound = await prisma.messages.findFirst({
      where: {
        conversation_id: conversationId,
        account_id: accountId,
        sender_type: 'CUSTOMER',
        direction: 'INBOUND',
      },
      orderBy: { id: 'desc' },
    });
    if (!latestInbound || latestInbound.id !== lastInboundMessageId) {
      logger.info(`Auto-reply job ${job.id}: stale (newer inbound message) — skipping.`);
      return;
    }

    const connection = await prisma.platformConnection.findFirst({
      where: { id: connectionId, accountId },
    });
    if (!connection) {
      logger.info(`Auto-reply job ${job.id}: connection ${connectionId} not found — skipping.`);
      return;
    }

    await generateAndSendReply(accountId, connection, conversation, lastInboundMessageId);
  } finally {
    await redisConnection.del(lockKey);
  }
}

const messagesWorker = new Worker(
  'messages',
  async (job: Job<AutoReplyJobData>) => {
    await handleAutoReplyJob(job);
  },
  {
    connection: redisConnection as any,
    concurrency: 5,
  }
);

messagesWorker.on('completed', (job) => {
  logger.info(`Auto-reply job ${job.id} completed.`);
});

messagesWorker.on('failed', (job, err) => {
  logger.error(`Auto-reply job ${job?.id} failed:`, err.message);
});

logger.info('Messages worker started. Consuming queue: messages (debounced auto-reply)');

export { webhookWorker, messagesWorker };
