import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { prisma } from '../../../core/db.js';
import { PlatformType, WebhookEventSource, WebhookEventStatus } from '@prisma/client';
import { getSettings } from '../../../config/settings.js';
import { logger } from '../../../core/logging.js';
import { ForbiddenError, BadRequestError } from '../../../core/errors.js';
import { webhooksQueue } from '../../../workers/queues.js';

export const webhooksRouter = Router();
const settings = getSettings();

// Helper to verify SHA256 Hub signature
const verifyHubSignature = (rawBody: Buffer | undefined, signatureHeader: string | undefined, appSecret: string): boolean => {
  if (!appSecret) return true; // Bypass check if app secret not configured
  if (!rawBody) return false;
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;

  const expected = crypto
    .createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex');

  const signature = signatureHeader.split('=')[1];
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
};

// Helper: build unique event key for deduplication
const buildEventKey = (
  source: string,
  payload: any,
  headers: Record<string, any>,
  connectionId: number | null
): string => {
  const pieces = [
    source,
    String(connectionId || 'unknown'),
    headers['x-hub-signature-256'] || '',
    headers['x-whatsapp-idempotency-key'] || '',
    headers['x-request-id'] || '',
    JSON.stringify(payload),
  ];
  return crypto.createHash('sha256').update(pieces.join('|')).digest('hex');
};

// Helper: extract external ID from Facebook payload
const extractFacebookPageId = (payload: any): string | null => {
  const entries = payload.entry || [];
  if (entries.length && entries[0].id) {
    return String(entries[0].id);
  }
  return null;
};

// Helper: extract phone number ID from WhatsApp payload
const extractWhatsAppPhoneNumberId = (payload: any): string | null => {
  const entries = payload.entry || [];
  for (const entry of entries) {
    const changes = entry.changes || [];
    for (const change of changes) {
      const phoneId = change.value?.metadata?.phone_number_id;
      if (phoneId) {
        return String(phoneId);
      }
    }
  }
  return null;
};

// Helper: identify event type
const getEventType = (platformType: string, payload: any): string => {
  const entries = payload.entry || [];
  if (platformType === 'facebook_page') {
    if (entries.some((e: any) => e.messaging)) {
      return 'inbound_message';
    }
    if (entries.some((e: any) => e.changes)) {
      return 'inbound_comment';
    }
    return 'facebook_event';
  } else {
    if (entries.some((e: any) => (e.changes || []).some((c: any) => c.value?.messages))) {
      return 'inbound_message';
    }
    return 'whatsapp_event';
  }
};

// Helper: Ingest event to database
const ingestWebhookEvent = async (
  source: 'facebook_page' | 'whatsapp',
  platformType: 'facebook_page' | 'whatsapp',
  payload: any,
  headers: Record<string, any>
) => {
  const dbPlatformType = platformType === 'facebook_page' ? PlatformType.FACEBOOK_PAGE : PlatformType.WHATSAPP;
  const dbSource = source === 'facebook_page' ? WebhookEventSource.FACEBOOK_PAGE : WebhookEventSource.WHATSAPP;

  // Resolve connection
  let connection: any = null;
  const connectionIdHeader = headers['x-platform-connection-id'];
  
  if (connectionIdHeader && !isNaN(Number(connectionIdHeader))) {
    connection = await prisma.platformConnection.findFirst({
      where: {
        id: Number(connectionIdHeader),
        platformType: dbPlatformType,
      },
    });
  }

  if (!connection) {
    const externalId = platformType === 'facebook_page'
      ? extractFacebookPageId(payload)
      : extractWhatsAppPhoneNumberId(payload);

    if (externalId) {
      connection = await prisma.platformConnection.findFirst({
        where: {
          platformType: dbPlatformType,
          externalId,
        },
      });
    }
  }

  const eventKey = buildEventKey(source, payload, headers, connection?.id || null);

  // Check duplicate
  const existing = await prisma.webhookEvent.findUnique({
    where: { eventKey },
  });

  if (existing) {
    return { event: existing, created: false };
  }

  const deliveryId = headers['x-hub-signature-256'] ||
    headers['x-hub-signature'] ||
    headers['x-whatsapp-idempotency-key'] ||
    headers['x-request-id'] ||
    null;

  const event = await prisma.webhookEvent.create({
    data: {
      accountId: connection?.accountId || null,
      platformConnectionId: connection?.id || null,
      platformType: dbPlatformType,
      source: dbSource,
      status: WebhookEventStatus.PENDING,
      eventType: getEventType(platformType, payload),
      eventKey,
      deliveryId,
      receivedAt: new Date(),
      payloadJson: payload,
      headersJson: headers,
      metadataJson: { connection_resolved: connection !== null },
    },
  });

  return { event, created: true };
};

// GET /facebook-page
webhooksRouter.get('/facebook-page', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mode = req.query['hub.mode'] as string;
    const challenge = req.query['hub.challenge'] as string;
    const verifyToken = req.query['hub.verify_token'] as string;

    if (!verifyToken) {
      return next(new ForbiddenError('Verify token not provided.'));
    }

    const connection = await prisma.platformConnection.findFirst({
      where: {
        platformType: PlatformType.FACEBOOK_PAGE,
        webhookActive: true,
        webhookVerifyToken: verifyToken,
      },
    });

    if (mode === 'subscribe' && connection) {
      return res.type('text/plain').send(challenge || '');
    }

    return next(new ForbiddenError('Webhook challenge verification failed.'));
  } catch (err) {
    next(err);
  }
});

// POST /facebook-page
webhooksRouter.post('/facebook-page', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const signature = req.headers['x-hub-signature-256'] as string;
    const appSecret = settings.facebook_app_secret;
    const rawBody = (req as any).rawBody;

    if (appSecret && !verifyHubSignature(rawBody, signature, appSecret)) {
      return next(new ForbiddenError('Invalid Facebook webhook signature.'));
    }

    const { event, created } = await ingestWebhookEvent(
      'facebook_page',
      'facebook_page',
      req.body,
      req.headers
    );

    if (created) {
      try {
        await webhooksQueue.add('process_webhook_event', { eventId: event.id });
      } catch (err) {
        logger.error('Failed to queue webhook event processing:', err);
      }
    }

    return res.status(202).json({
      event_id: event.id,
      status: event.status,
      queued: created,
    });
  } catch (err) {
    next(err);
  }
});

// GET /whatsapp
webhooksRouter.get('/whatsapp', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mode = req.query['hub.mode'] as string;
    const challenge = req.query['hub.challenge'] as string;
    const verifyToken = req.query['hub.verify_token'] as string;

    if (!verifyToken) {
      return next(new ForbiddenError('Verify token not provided.'));
    }

    const connection = await prisma.platformConnection.findFirst({
      where: {
        platformType: PlatformType.WHATSAPP,
        webhookActive: true,
        webhookVerifyToken: verifyToken,
      },
    });

    if (mode === 'subscribe' && connection) {
      return res.type('text/plain').send(challenge || '');
    }

    return next(new ForbiddenError('Webhook challenge verification failed.'));
  } catch (err) {
    next(err);
  }
});

// POST /whatsapp
webhooksRouter.post('/whatsapp', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const signature = req.headers['x-hub-signature-256'] as string;
    const appSecret = settings.facebook_app_secret; // WhatsApp uses same meta signature validation
    const rawBody = (req as any).rawBody;

    if (appSecret && settings.whatsapp_verify_signature && !verifyHubSignature(rawBody, signature, appSecret)) {
      return next(new ForbiddenError('Invalid WhatsApp webhook signature.'));
    }

    const { event, created } = await ingestWebhookEvent(
      'whatsapp',
      'whatsapp',
      req.body,
      req.headers
    );

    if (created) {
      try {
        await webhooksQueue.add('process_webhook_event', { eventId: event.id });
      } catch (err) {
        logger.error('Failed to queue WhatsApp webhook event processing:', err);
      }
    }

    return res.status(202).json({
      event_id: event.id,
      status: event.status,
      queued: created,
    });
  } catch (err) {
    next(err);
  }
});

export default webhooksRouter;
