import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../../core/db.js';
import { PlatformConnectionService } from '../../../services/platform_connection_service.js';
import { requireUser, AuthenticatedRequest } from '../../../middlewares/auth.js';
import { BadRequestError, ForbiddenError } from '../../../core/errors.js';

export const platformConnectionsRouter = Router();
const service = new PlatformConnectionService();

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
  // Verify membership
  const hasAccess = req.user.userRole === 'OWNER' || req.user.userRole === 'SUPER_ADMIN' ||
    (req.user.memberships || []).some((m: any) => m.accountId === accountId && m.status === 'ACTIVE');

  if (!hasAccess) {
    throw new ForbiddenError('You do not have access to this account.');
  }
  return accountId;
};

// GET /
platformConnectionsRouter.get('/', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const connections = await service.listConnections(accountId);
    return res.json({ items: connections, total: connections.length });
  } catch (err) {
    next(err);
  }
});

// POST /
const createConnectionSchema = z.object({
  platform_type: z.enum(['FACEBOOK_PAGE', 'WHATSAPP']),
  name: z.string().min(2).max(255),
  external_id: z.string().max(255).optional().nullable(),
  external_name: z.string().max(255).optional().nullable(),
  access_token: z.string().min(8).max(2048).optional().nullable(),
  refresh_token: z.string().min(8).max(2048).optional().nullable(),
  webhook: z.object({
    webhook_url: z.string().url().optional().nullable(),
    webhook_secret: z.string().max(255).optional().nullable(),
    webhook_verify_token: z.string().max(255).optional().nullable(),
    webhook_active: z.boolean().default(false),
  }).optional().nullable(),
  metadata_json: z.record(z.any()).default({}),
  settings_json: z.record(z.any()).default({}),
});

platformConnectionsRouter.post('/', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const payload = createConnectionSchema.parse(req.body);
    const connection = await service.createConnection(accountId, payload);
    return res.status(201).json(connection);
  } catch (err) {
    next(err);
  }
});

// POST /facebook/oauth/start
platformConnectionsRouter.post('/facebook/oauth/start', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const response = await service.facebook.startOAuth(accountId, req.user.id);
    return res.json(response);
  } catch (err) {
    next(err);
  }
});

// POST /facebook/oauth/complete
const oauthCompleteSchema = z.object({
  state: z.string(),
  code: z.string(),
});

platformConnectionsRouter.post('/facebook/oauth/complete', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const payload = oauthCompleteSchema.parse(req.body);
    const response = await service.facebook.completeOAuth(accountId, req.user.id, payload.state, payload.code);
    return res.json(response);
  } catch (err) {
    next(err);
  }
});

// POST /facebook/oauth/connect
const oauthConnectSchema = z.object({
  state: z.string(),
  page_id: z.string(),
  connection_name: z.string().optional(),
  webhook_verify_token: z.string().optional(),
  webhook_secret: z.string().optional(),
});

platformConnectionsRouter.post('/facebook/oauth/connect', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const payload = oauthConnectSchema.parse(req.body);
    const connection = await service.facebook.connectPageFromOAuth(
      accountId,
      req.user.id,
      payload.state,
      payload.page_id,
      payload.connection_name,
      payload.webhook_verify_token,
      payload.webhook_secret
    );
    return res.status(201).json(service['toResponse'](connection));
  } catch (err) {
    next(err);
  }
});

// POST /facebook/manual-connect
const facebookManualSchema = z.object({
  page_id: z.string(),
  page_access_token: z.string(),
  connection_name: z.string().optional(),
  user_access_token: z.string().optional(),
  webhook_verify_token: z.string().optional(),
  webhook_secret: z.string().optional(),
});

platformConnectionsRouter.post('/facebook/manual-connect', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const payload = facebookManualSchema.parse(req.body);
    const connection = await service.connectFacebookPageManually(accountId, payload);
    return res.status(201).json(connection);
  } catch (err) {
    next(err);
  }
});

// POST /whatsapp/manual-connect
const whatsappManualSchema = z.object({
  phone_number_id: z.string(),
  access_token: z.string(),
  connection_name: z.string().optional(),
  business_account_id: z.string().optional(),
  display_phone_number: z.string().optional(),
  webhook_verify_token: z.string().optional(),
  webhook_secret: z.string().optional(),
});

platformConnectionsRouter.post('/whatsapp/manual-connect', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const payload = whatsappManualSchema.parse(req.body);
    const connection = await service.connectWhatsAppManually(accountId, payload);
    return res.status(201).json(connection);
  } catch (err) {
    next(err);
  }
});

// GET /:id
platformConnectionsRouter.get('/:id', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const connection = await service.getConnection(accountId, parseInt(req.params.id, 10));
    return res.json(connection);
  } catch (err) {
    next(err);
  }
});

// PUT /:id
const updateConnectionSchema = z.object({
  name: z.string().min(2).max(255).optional(),
  external_id: z.string().max(255).optional(),
  external_name: z.string().max(255).optional(),
  access_token: z.string().min(8).max(2048).optional(),
  refresh_token: z.string().min(8).max(2048).optional(),
  webhook: z.object({
    webhook_url: z.string().url().optional().nullable(),
    webhook_secret: z.string().max(255).optional().nullable(),
    webhook_verify_token: z.string().max(255).optional().nullable(),
    webhook_active: z.boolean().default(false),
  }).optional(),
  metadata_json: z.record(z.any()).optional(),
  settings_json: z.record(z.any()).optional(),
  last_error: z.string().max(500).optional().nullable(),
});

platformConnectionsRouter.put('/:id', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const payload = updateConnectionSchema.parse(req.body);
    const connection = await service.updateConnection(accountId, parseInt(req.params.id, 10), payload);
    return res.json(connection);
  } catch (err) {
    next(err);
  }
});

// PATCH /:id/status
const updateStatusSchema = z.object({
  status: z.enum(['PENDING', 'CONNECTED', 'ACTION_REQUIRED', 'DISCONNECTED', 'ERROR']),
  last_error: z.string().max(500).optional().nullable(),
});

platformConnectionsRouter.patch('/:id/status', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const payload = updateStatusSchema.parse(req.body);
    const connection = await service.updateStatus(accountId, parseInt(req.params.id, 10), payload);
    return res.json(connection);
  } catch (err) {
    next(err);
  }
});

// POST /:id/facebook/sync
platformConnectionsRouter.post('/:id/facebook/sync', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const connectionId = parseInt(req.params.id, 10);
    const connection = await service['getConnectionForAccount'](accountId, connectionId);
    const synced = await service.facebook.syncConnection(connection);
    return res.json(service['toResponse'](synced));
  } catch (err) {
    next(err);
  }
});

// POST /:id/whatsapp/sync
platformConnectionsRouter.post('/:id/whatsapp/sync', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const connectionId = parseInt(req.params.id, 10);
    const connection = await service['getConnectionForAccount'](accountId, connectionId);
    const synced = await service.whatsapp.syncConnection(connection);
    return res.json(service['toResponse'](synced));
  } catch (err) {
    next(err);
  }
});

// POST /:id/facebook/subscribe-webhooks
platformConnectionsRouter.post('/:id/facebook/subscribe-webhooks', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const connectionId = parseInt(req.params.id, 10);
    const connection = await service['getConnectionForAccount'](accountId, connectionId);
    const synced = await service.facebook.subscribePageWebhooks(connection);
    return res.json(service['toResponse'](synced));
  } catch (err) {
    next(err);
  }
});

// POST /:id/disconnect
platformConnectionsRouter.post('/:id/disconnect', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const connection = await service.disconnectConnection(accountId, parseInt(req.params.id, 10));
    return res.json(connection);
  } catch (err) {
    next(err);
  }
});

// DELETE /:id
platformConnectionsRouter.delete('/:id', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    await service.deleteConnection(accountId, parseInt(req.params.id, 10));
    return res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default platformConnectionsRouter;
