import { prisma } from '../core/db.js';
import { FacebookIntegrationService } from '../integrations/facebook/service.js';
import { WhatsAppIntegrationService } from '../integrations/whatsapp/service.js';
import { tokenCipher } from '../utils/crypto.js';
import { PlatformType, ConnectionStatus } from '@prisma/client';
import { BadRequestError, NotFoundError } from '../core/errors.js';

export class PlatformConnectionService {
  public facebook: FacebookIntegrationService;
  public whatsapp: WhatsAppIntegrationService;

  constructor() {
    this.facebook = new FacebookIntegrationService();
    this.whatsapp = new WhatsAppIntegrationService();
  }

  async listConnections(accountId: number): Promise<any[]> {
    const connections = await prisma.platformConnection.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
    });
    return connections.map((c) => this.toResponse(c));
  }

  async getConnection(accountId: number, connectionId: number): Promise<any> {
    const connection = await this.getConnectionForAccount(accountId, connectionId);
    return this.toResponse(connection);
  }

  async createConnection(accountId: number, payload: any): Promise<any> {
    const encryptedAccessToken = tokenCipher.encrypt(payload.access_token);
    const encryptedRefreshToken = tokenCipher.encrypt(payload.refresh_token);
    const last4 = payload.access_token ? payload.access_token.slice(-4) : null;
    const tokenHint = last4 ? `...${last4}` : null;

    const connection = await prisma.platformConnection.create({
      data: {
        accountId,
        platformType: payload.platform_type,
        name: payload.name,
        externalId: payload.external_id || null,
        externalName: payload.external_name || null,
        encryptedAccessToken,
        encryptedRefreshToken,
        tokenHint,
        webhookActive: payload.webhook?.webhook_active || false,
        webhookUrl: payload.webhook?.webhook_url || null,
        webhookSecret: payload.webhook?.webhook_secret || null,
        webhookVerifyToken: payload.webhook?.webhook_verify_token || null,
        metadataJson: payload.metadata_json || {},
        settingsJson: payload.settings_json || {},
      },
    });

    return this.toResponse(connection);
  }

  async updateConnection(accountId: number, connectionId: number, payload: any): Promise<any> {
    const connection = await this.getConnectionForAccount(accountId, connectionId);

    const updateData: any = {};
    if (payload.name !== undefined) updateData.name = payload.name;
    if (payload.external_id !== undefined) updateData.externalId = payload.external_id;
    if (payload.external_name !== undefined) updateData.externalName = payload.external_name;
    if (payload.last_error !== undefined) updateData.lastError = payload.last_error;
    if (payload.metadata_json !== undefined) updateData.metadataJson = payload.metadata_json;
    if (payload.settings_json !== undefined) updateData.settingsJson = payload.settings_json;

    if (payload.access_token !== undefined) {
      updateData.encryptedAccessToken = tokenCipher.encrypt(payload.access_token);
      const last4 = payload.access_token ? payload.access_token.slice(-4) : null;
      updateData.tokenHint = last4 ? `...${last4}` : null;
    }

    if (payload.refresh_token !== undefined) {
      updateData.encryptedRefreshToken = tokenCipher.encrypt(payload.refresh_token);
    }

    if (payload.webhook !== undefined) {
      updateData.webhookActive = payload.webhook?.webhook_active || false;
      updateData.webhookUrl = payload.webhook?.webhook_url || null;
      updateData.webhookSecret = payload.webhook?.webhook_secret || null;
      updateData.webhookVerifyToken = payload.webhook?.webhook_verify_token || null;
    }

    const updated = await prisma.platformConnection.update({
      where: { id: connection.id },
      data: updateData,
    });

    return this.toResponse(updated);
  }

  async updateStatus(accountId: number, connectionId: number, payload: any): Promise<any> {
    const connection = await this.getConnectionForAccount(accountId, connectionId);
    const updated = await prisma.platformConnection.update({
      where: { id: connection.id },
      data: {
        status: payload.status,
        lastError: payload.last_error || null,
      },
    });
    return this.toResponse(updated);
  }

  async disconnectConnection(accountId: number, connectionId: number): Promise<any> {
    const connection = await this.getConnectionForAccount(accountId, connectionId);
    const updated = await prisma.platformConnection.update({
      where: { id: connection.id },
      data: {
        status: ConnectionStatus.DISCONNECTED,
        encryptedAccessToken: null,
        encryptedRefreshToken: null,
        tokenHint: null,
        lastError: null,
      },
    });
    return this.toResponse(updated);
  }

  async deleteConnection(accountId: number, connectionId: number): Promise<void> {
    const connection = await this.getConnectionForAccount(accountId, connectionId);
    await prisma.platformConnection.delete({
      where: { id: connection.id },
    });
  }

  async connectFacebookPageManually(accountId: number, payload: any): Promise<any> {
    const connection = await this.facebook.connectPageFromManualToken(
      accountId,
      payload.page_id,
      payload.page_access_token,
      payload.connection_name || null,
      payload.user_access_token || null,
      payload.webhook_verify_token || null,
      payload.webhook_secret || null
    );
    return this.toResponse(connection);
  }

  async connectWhatsAppManually(accountId: number, payload: any): Promise<any> {
    const connection = await this.whatsapp.connectPhoneNumberManually(
      accountId,
      payload.phone_number_id,
      payload.access_token,
      payload.connection_name || null,
      payload.business_account_id || null,
      payload.display_phone_number || null,
      payload.webhook_verify_token || null,
      payload.webhook_secret || null
    );
    return this.toResponse(connection);
  }

  private async getConnectionForAccount(accountId: number, connectionId: number): Promise<any> {
    const connection = await prisma.platformConnection.findFirst({
      where: { id: connectionId, accountId },
    });
    if (!connection) {
      throw new NotFoundError('Platform connection not found.');
    }
    return connection;
  }

  private toResponse(connection: any): any {
    const metadata = connection.metadataJson as Record<string, any> || {};
    
    let pagePictureUrl = null;
    let followersCount = null;
    let lastSyncedAt = null;
    let syncState = 'pending';
    let tokenStatus = 'valid';
    let webhookSubscriptionState = 'unknown';

    if (connection.platformType === PlatformType.FACEBOOK_PAGE) {
      const fb = metadata.facebook || {};
      pagePictureUrl = fb.page_picture_url || null;
      followersCount = fb.followers_count || null;
      lastSyncedAt = fb.last_synced_at || null;
      syncState = fb.sync_state || 'pending';
      tokenStatus = fb.token_status || 'valid';
      webhookSubscriptionState = fb.webhook_subscription_state || 'unknown';
    } else if (connection.platformType === PlatformType.WHATSAPP) {
      const wa = metadata.whatsapp || {};
      followersCount = null;
      lastSyncedAt = wa.last_synced_at || null;
      syncState = wa.sync_state || 'pending';
      tokenStatus = wa.token_status || 'valid';
      webhookSubscriptionState = 'not_applicable';
    }

    const response = {
      id: connection.id,
      account_id: connection.accountId,
      platform_type: connection.platformType,
      name: connection.name,
      external_id: connection.externalId,
      external_name: connection.externalName,
      status: connection.status,
      token_hint: connection.tokenHint,
      webhook: {
        webhook_url: connection.webhookUrl,
        webhook_active: connection.webhookActive,
        has_secret: !!connection.webhookSecret,
        has_verify_token: !!connection.webhookVerifyToken,
      },
      metadata_json: metadata,
      settings_json: connection.settingsJson || {},
      last_error: connection.lastError,
      integration_summary: {
        provider: connection.platformType?.toLowerCase().replace('_page', ''),
        connected_via: metadata.facebook?.connected_via || metadata.whatsapp?.connected_via || 'manual',
        sync_state: syncState,
        token_status: tokenStatus,
        last_synced_at: lastSyncedAt,
        webhook_subscription_state: webhookSubscriptionState,
        page_picture_url: pagePictureUrl,
        followers_count: followersCount,
        required_permissions: [],
        tasks: [],
      },
      created_at: connection.createdAt,
      updated_at: connection.updatedAt,
    };

    return response;
  }
}
