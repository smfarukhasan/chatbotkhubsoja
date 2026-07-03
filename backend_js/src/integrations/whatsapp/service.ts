import { prisma } from '../../core/db.js';
import { tokenCipher } from '../../utils/crypto.js';
import { WhatsAppCloudAPIClient } from './client.js';
import { PlatformType, ConnectionStatus } from '@prisma/client';
import { BadRequestError } from '../../core/errors.js';

export class WhatsAppIntegrationService {
  private client: WhatsAppCloudAPIClient;

  constructor() {
    this.client = new WhatsAppCloudAPIClient();
  }

  async connectPhoneNumberManually(
    accountId: number,
    phoneNumberId: string,
    accessToken: string,
    connectionName?: string,
    businessAccountId?: string,
    displayPhoneNumber?: string,
    webhookVerifyToken?: string,
    webhookSecret?: string
  ): Promise<any> {
    const profile = await this.client.getPhoneNumberProfile(phoneNumberId, accessToken);
    return this.upsertConnection(
      accountId,
      profile.phone_number_id,
      displayPhoneNumber || profile.display_phone_number || 'WhatsApp',
      profile.verified_name || null,
      profile.quality_rating || null,
      accessToken,
      businessAccountId || null,
      connectionName,
      webhookVerifyToken,
      webhookSecret,
      'manual'
    );
  }

  async syncConnection(connection: any): Promise<any> {
    const accessToken = this.getAccessToken(connection);
    const phoneNumberId = connection.externalId;
    if (!accessToken || !phoneNumberId) {
      throw new BadRequestError('Connection is missing external ID or access token.');
    }

    const profile = await this.client.getPhoneNumberProfile(phoneNumberId, accessToken);

    const whatsappMeta = {
      ...(connection.metadataJson as Record<string, any> || {}).whatsapp,
      display_phone_number: profile.display_phone_number,
      verified_name: profile.verified_name,
      quality_rating: profile.quality_rating,
      last_synced_at: new Date().toISOString(),
      sync_state: 'synced',
      token_status: 'valid',
    };

    return prisma.platformConnection.update({
      where: { id: connection.id },
      data: {
        externalId: profile.phone_number_id,
        externalName: profile.display_phone_number || connection.externalName,
        status: ConnectionStatus.CONNECTED,
        lastError: null,
        metadataJson: {
          ...(connection.metadataJson as Record<string, any> || {}),
          whatsapp: whatsappMeta,
        },
      },
    });
  }

  private getAccessToken(connection: any): string | null {
    const encrypted = connection.encryptedAccessToken;
    if (!encrypted) return null;
    return tokenCipher.decrypt(encrypted);
  }

  private async upsertConnection(
    accountId: number,
    phoneNumberId: string,
    displayPhoneNumber: string,
    verifiedName: string | null,
    qualityRating: string | null,
    accessToken: string,
    businessAccountId: string | null,
    connectionName?: string,
    webhookVerifyToken?: string | null,
    webhookSecret?: string | null,
    connectedVia = 'manual'
  ): Promise<any> {
    const name = connectionName || displayPhoneNumber;
    const encryptedAccessToken = tokenCipher.encrypt(accessToken);
    const last4 = accessToken.slice(-4);
    const tokenHint = last4 ? `...${last4}` : null;

    const whatsappMeta = {
      display_phone_number: displayPhoneNumber,
      verified_name: verifiedName,
      quality_rating: qualityRating,
      business_account_id: businessAccountId,
      last_synced_at: new Date().toISOString(),
      sync_state: 'pending',
      token_status: 'valid',
      connected_via: connectedVia,
    };

    const existing = await prisma.platformConnection.findFirst({
      where: {
        accountId,
        platformType: PlatformType.WHATSAPP,
        externalId: phoneNumberId,
      },
    });

    if (existing) {
      return prisma.platformConnection.update({
        where: { id: existing.id },
        data: {
          name,
          externalName: displayPhoneNumber,
          status: ConnectionStatus.CONNECTED,
          encryptedAccessToken,
          tokenHint,
          webhookActive: webhookVerifyToken ? true : existing.webhookActive,
          webhookVerifyToken: webhookVerifyToken || existing.webhookVerifyToken,
          webhookSecret: webhookSecret || existing.webhookSecret,
          metadataJson: {
            ...(existing.metadataJson as Record<string, any> || {}),
            whatsapp: whatsappMeta,
          },
          lastError: null,
        },
      });
    }

    return prisma.platformConnection.create({
      data: {
        accountId,
        platformType: PlatformType.WHATSAPP,
        name,
        externalId: phoneNumberId,
        externalName: displayPhoneNumber,
        status: ConnectionStatus.CONNECTED,
        encryptedAccessToken,
        tokenHint,
        webhookActive: webhookVerifyToken ? true : false,
        webhookVerifyToken: webhookVerifyToken || null,
        webhookSecret: webhookSecret || null,
        metadataJson: {
          whatsapp: whatsappMeta,
        },
        settingsJson: {},
      },
    });
  }
}
