import { getSettings } from '../../config/settings.js';
import { prisma } from '../../core/db.js';
import { tokenCipher } from '../../utils/crypto.js';
import { FacebookGraphAPIClient, FacebookPageCandidate } from './client.js';
import { FacebookOAuthSessionStore } from './oauth_sessions.js';
import { PlatformType, ConnectionStatus } from '@prisma/client';
import { BadRequestError, NotFoundError } from '../../core/errors.js';

const settings = getSettings();

export class FacebookIntegrationService {
  private client: FacebookGraphAPIClient;
  private oauthSessions: FacebookOAuthSessionStore;
  private OAUTH_SCOPES = [
    'pages_show_list',
    'pages_manage_metadata',
    'pages_messaging',
    'pages_read_engagement',
    'pages_manage_posts',
    'pages_manage_engagement',
  ];

  constructor() {
    this.client = new FacebookGraphAPIClient();
    this.oauthSessions = new FacebookOAuthSessionStore();
  }

  async startOAuth(accountId: number, actorUserId: number): Promise<any> {
    if (!settings.facebook_app_id) {
      throw new BadRequestError('Facebook OAuth is not configured on the server.');
    }
    const state = this.oauthSessions.create({
      account_id: accountId,
      actor_user_id: actorUserId,
      redirect_uri: settings.facebook_oauth_redirect_uri,
    });
    return {
      state,
      auth_url: this.client.buildOAuthUrl(state, settings.facebook_oauth_redirect_uri, this.OAUTH_SCOPES),
      redirect_uri: settings.facebook_oauth_redirect_uri,
      scopes: this.OAUTH_SCOPES,
    };
  }

  async completeOAuth(accountId: number, actorUserId: number, state: string, code: string): Promise<any> {
    const session = this.getValidSession(state, accountId, actorUserId);
    const tokenExchange = await this.client.exchangeCodeForUserToken(code, session.redirect_uri);
    const userToken = tokenExchange.access_token;
    
    const longLivedExchange = await this.client.exchangeForLongLivedUserToken(userToken);
    const longLivedUserToken = longLivedExchange.access_token;
    
    const pages = await this.client.listManagedPages(longLivedUserToken);
    
    this.oauthSessions.save(state, {
      ...session,
      long_lived_user_token: longLivedUserToken,
      pages,
    });

    return {
      state,
      pages: pages.map((p) => ({
        page_id: p.page_id,
        page_name: p.page_name,
      })),
    };
  }

  async connectPageFromOAuth(
    accountId: number,
    actorUserId: number,
    state: string,
    pageId: string,
    connectionName?: string,
    webhookVerifyToken?: string,
    webhookSecret?: string
  ): Promise<any> {
    const session = this.getValidSession(state, accountId, actorUserId);
    const pages: FacebookPageCandidate[] = session.pages || [];
    const page = pages.find((p) => p.page_id === pageId);
    if (!page) {
      throw new NotFoundError('Selected Facebook Page was not found in the OAuth session.');
    }

    const connection = await this.upsertConnection(
      accountId,
      page,
      connectionName,
      session.long_lived_user_token,
      webhookVerifyToken,
      webhookSecret,
      'oauth'
    );
    this.oauthSessions.delete(state);
    return connection;
  }

  async connectPageFromManualToken(
    accountId: number,
    pageId: string,
    pageAccessToken: string,
    connectionName?: string,
    userAccessToken?: string,
    webhookVerifyToken?: string,
    webhookSecret?: string
  ): Promise<any> {
    const profile = await this.client.getPageProfile(pageId, pageAccessToken);
    const page: FacebookPageCandidate = {
      page_id: profile.page_id,
      page_name: profile.page_name,
      page_access_token: pageAccessToken,
      category: profile.category,
      picture_url: profile.picture_url,
      tasks: [],
    };
    return this.upsertConnection(
      accountId,
      page,
      connectionName,
      userAccessToken,
      webhookVerifyToken,
      webhookSecret,
      'manual'
    );
  }

  async syncConnection(connection: any): Promise<any> {
    const pageToken = this.getPageAccessToken(connection);
    const pageId = connection.externalId;
    if (!pageToken || !pageId) {
      throw new BadRequestError('Connection is missing external ID or page access token.');
    }

    const profile = await this.client.getPageProfile(pageId, pageToken);
    
    let webhookSubscriptionState = 'unknown';
    try {
      const subscriptions = await this.client.getPageSubscriptions(pageId, pageToken);
      const isSubscribed = (subscriptions.data || []).some(
        (sub: any) => sub.active === true && String(sub.id) === String(settings.facebook_app_id)
      );
      webhookSubscriptionState = isSubscribed ? 'subscribed' : 'not_subscribed';
    } catch {
      // Subscriptions call failed, ignore
    }

    const metadata = {
      ...(connection.metadataJson as Record<string, any> || {}),
      facebook: {
        page_name: profile.page_name,
        page_category: profile.category,
        page_picture_url: profile.picture_url,
        followers_count: profile.followers_count,
        last_synced_at: new Date().toISOString(),
        sync_state: 'synced',
        token_status: 'valid',
        webhook_subscription_state: webhookSubscriptionState,
      },
    };

    return prisma.platformConnection.update({
      where: { id: connection.id },
      data: {
        name: connection.name || profile.page_name,
        externalName: profile.page_name,
        status: ConnectionStatus.CONNECTED,
        lastError: null,
        metadataJson: metadata,
      },
    });
  }

  async subscribePageWebhooks(connection: any): Promise<any> {
    const pageToken = this.getPageAccessToken(connection);
    const pageId = connection.externalId;
    if (!pageToken || !pageId) {
      throw new BadRequestError('Connection is missing external ID or page access token.');
    }

    await this.client.subscribePageToApp(pageId, pageToken);
    return this.syncConnection(connection);
  }

  private getValidSession(state: string, accountId: number, actorUserId: number): any {
    const session = this.oauthSessions.get(state);
    if (!session) {
      throw new BadRequestError('OAuth state has expired or is invalid.');
    }
    if (session.account_id !== accountId || session.actor_user_id !== actorUserId) {
      throw new BadRequestError('OAuth state account/actor mismatch.');
    }
    return session;
  }

  private getPageAccessToken(connection: any): string | null {
    const encrypted = connection.encryptedAccessToken;
    if (!encrypted) return null;
    return tokenCipher.decrypt(encrypted);
  }

  private async upsertConnection(
    accountId: number,
    page: FacebookPageCandidate,
    connectionName?: string,
    userAccessToken?: string | null,
    webhookVerifyToken?: string | null,
    webhookSecret?: string | null,
    connectedVia = 'oauth'
  ): Promise<any> {
    const name = connectionName || page.page_name;
    const encryptedAccessToken = tokenCipher.encrypt(page.page_access_token);
    const encryptedRefreshToken = tokenCipher.encrypt(userAccessToken);
    
    const last4 = page.page_access_token.slice(-4);
    const tokenHint = last4 ? `...${last4}` : null;

    const metadata = {
      facebook: {
        page_name: page.page_name,
        page_category: page.category,
        page_picture_url: page.picture_url,
        last_synced_at: new Date().toISOString(),
        sync_state: 'pending',
        token_status: 'valid',
        connected_via: connectedVia,
      },
    };

    // Find existing
    const existing = await prisma.platformConnection.findFirst({
      where: {
        accountId,
        platformType: PlatformType.FACEBOOK_PAGE,
        externalId: page.page_id,
      },
    });

    if (existing) {
      return prisma.platformConnection.update({
        where: { id: existing.id },
        data: {
          name,
          externalName: page.page_name,
          status: ConnectionStatus.CONNECTED,
          encryptedAccessToken,
          encryptedRefreshToken,
          tokenHint,
          webhookActive: webhookVerifyToken ? true : existing.webhookActive,
          webhookVerifyToken: webhookVerifyToken || existing.webhookVerifyToken,
          webhookSecret: webhookSecret || existing.webhookSecret,
          metadataJson: metadata,
          lastError: null,
        },
      });
    }

    return prisma.platformConnection.create({
      data: {
        accountId,
        platformType: PlatformType.FACEBOOK_PAGE,
        name,
        externalId: page.page_id,
        externalName: page.page_name,
        status: ConnectionStatus.CONNECTED,
        encryptedAccessToken,
        encryptedRefreshToken,
        tokenHint,
        webhookActive: webhookVerifyToken ? true : false,
        webhookVerifyToken: webhookVerifyToken || null,
        webhookSecret: webhookSecret || null,
        metadataJson: metadata,
        settingsJson: {},
      },
    });
  }

  async listLiveConversations(accountId: number, connectionId?: number, pageSize = 25, after?: string): Promise<any> {
    const connections = await prisma.platformConnection.findMany({
      where: {
        accountId,
        platformType: PlatformType.FACEBOOK_PAGE,
        status: ConnectionStatus.CONNECTED,
        ...(connectionId ? { id: connectionId } : {}),
      },
      orderBy: { id: 'asc' },
    });

    if (connectionId && connections.length === 0) {
      throw new NotFoundError('Facebook connection not found.');
    }

    const items: any[] = [];
    let nextCursor: string | null = null;
    const limit = Math.max(1, Math.min(pageSize, 50));

    for (const connection of connections) {
      const pageId = (connection.metadataJson as any)?.facebook?.page_id || connection.externalId;
      const pageToken = this.getPageAccessToken(connection);
      if (!pageId || !pageToken) continue;

      try {
        const payload = await this.client.listPageConversations(pageId, pageToken, limit, after);
        const data = payload.data || [];
        
        const customerIds = data.map((row: any) => {
          const participants = (row.senders?.data || []);
          const customer = participants.find((p: any) => String(p.id) !== String(pageId));
          return customer?.id ? String(customer.id) : null;
        }).filter(Boolean) as string[];

        const aiChatStates: Record<string, any> = {};
        if (customerIds.length > 0) {
          const dbConversations = await prisma.conversations.findMany({
            where: {
              account_id: accountId,
              platform_connection_id: connection.id,
              customer_external_id: { in: customerIds },
            },
          });
          for (const conv of dbConversations) {
            aiChatStates[conv.customer_external_id] = getAIChatState(conv.metadata_json);
          }
        }

        for (const row of data) {
          const participants = (row.senders?.data || []).map((p: any) => ({
            id: String(p.id),
            name: p.name,
            email: p.email,
          }));

          const customer = participants.find((p: any) => p.id !== String(pageId));
          const customerExternalId = customer?.id || pageId;
          const aiChatState = aiChatStates[customerExternalId] || { mode: 'auto', manual_until: null };

          items.push({
            id: String(row.id),
            platform_connection_id: connection.id,
            connection_name: connection.name,
            page_id: pageId,
            customer_external_id: customerExternalId,
            customer_name: customer?.name || connection.externalName || connection.name,
            latest_message_preview: row.snippet || (row.message_count ? `${row.message_count} messages` : null),
            latest_message_at: row.updated_time,
            ai_chat_mode: aiChatState.mode,
            ai_chat_manual_until: aiChatState.manual_until,
            unread_count: row.unread_count || 0,
            message_count: row.message_count || 0,
            link: row.link,
            participants,
          });
        }

        if (!nextCursor) {
          nextCursor = payload.paging?.cursors?.after || null;
        }
      } catch (err: any) {
        console.error('Error fetching conversations for page:', pageId, err);
      }
    }

    items.sort((a, b) => {
      const timeA = a.latest_message_at ? new Date(a.latest_message_at).getTime() : 0;
      const timeB = b.latest_message_at ? new Date(b.latest_message_at).getTime() : 0;
      return timeB - timeA;
    });

    return {
      items: items.slice(0, pageSize),
      total: items.length,
      page_size: pageSize,
      next_cursor: nextCursor,
    };
  }

  async listLiveMessages(accountId: number, connectionId: number, conversationId: string, pageSize = 100, after?: string): Promise<any> {
    const connection = await prisma.platformConnection.findFirst({
      where: {
        id: connectionId,
        accountId,
        platformType: PlatformType.FACEBOOK_PAGE,
        status: ConnectionStatus.CONNECTED,
      },
    });

    if (!connection) {
      throw new NotFoundError('Facebook connection not found.');
    }

    const pageId = (connection.metadataJson as any)?.facebook?.page_id || connection.externalId;
    const pageToken = this.getPageAccessToken(connection);
    if (!pageId || !pageToken) {
      throw new BadRequestError('Facebook connection is missing page credentials.');
    }

    const limit = Math.max(1, Math.min(pageSize, 200));
    const payload = await this.client.listConversationMessages(conversationId, pageToken, limit, after);
    const data = payload.data || [];

    const items = data.map((row: any) => {
      const sender = row.from || {};
      const senderExternalId = sender.id ? String(sender.id) : null;
      const recipients = (row.to?.data || []).map((recipient: any) => ({
        id: String(recipient.id),
        name: recipient.name,
        email: recipient.email,
      }));

      let content = row.message || '';
      if (!content.trim()) {
        if (row.attachments) content = '[attachment]';
        else if (row.sticker) content = '[sticker]';
        else if (row.shares) content = '[shared content]';
        else content = '[empty message]';
      }

      return {
        id: String(row.id),
        conversation_id: conversationId,
        platform_connection_id: connection.id,
        created_at: row.created_time,
        sender_name: sender.name || null,
        sender_external_id: senderExternalId,
        direction: senderExternalId === pageId ? 'OUTBOUND' : 'INBOUND',
        content,
        recipients,
      };
    });

    items.sort((a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    return {
      items,
      total: items.length,
      page_size: pageSize,
      next_cursor: payload.paging?.cursors?.after || null,
    };
  }

  async sendLiveReply(accountId: number, connectionId: number, recipientId: string, content: string): Promise<any> {
    const connection = await prisma.platformConnection.findFirst({
      where: {
        id: connectionId,
        accountId,
        platformType: PlatformType.FACEBOOK_PAGE,
        status: ConnectionStatus.CONNECTED,
      },
    });

    if (!connection) {
      throw new NotFoundError('Facebook connection not found.');
    }

    const pageId = (connection.metadataJson as any)?.facebook?.page_id || connection.externalId;
    const pageToken = this.getPageAccessToken(connection);
    if (!pageId || !pageToken) {
      throw new BadRequestError('Facebook connection is missing page credentials.');
    }

    const payload = await this.client.sendMessage(pageToken, recipientId, content);

    return {
      id: String(payload.message_id || payload.recipient_id || 'live-reply'),
      conversation_id: 'live',
      platform_connection_id: connection.id,
      created_at: new Date().toISOString(),
      sender_name: connection.externalName || connection.name,
      sender_external_id: pageId,
      direction: 'OUTBOUND',
      content: content.trim(),
      recipients: [
        {
          id: recipientId,
          name: null,
          email: null,
        },
      ],
    };
  }

  async updateLiveConversationAiChat(
    accountId: number,
    connectionId: number,
    conversationId: string,
    customerExternalId: string,
    customerName: string | null,
    mode: 'auto' | 'manual' | 'off',
    manualMinutes?: number
  ): Promise<any> {
    const connection = await prisma.platformConnection.findFirst({
      where: {
        id: connectionId,
        accountId,
        platformType: PlatformType.FACEBOOK_PAGE,
        status: ConnectionStatus.CONNECTED,
      },
    });

    if (!connection) {
      throw new NotFoundError('Facebook connection not found.');
    }

    if (mode === 'manual' && manualMinutes === undefined) {
      throw new BadRequestError('Manual mode requires a timer in minutes.');
    }

    let conversation = await prisma.conversations.findFirst({
      where: {
        account_id: accountId,
        platform_connection_id: connection.id,
        customer_external_id: customerExternalId,
      },
    });

    let manualUntil: Date | null = null;
    if (mode === 'manual' && manualMinutes) {
      manualUntil = new Date(Date.now() + manualMinutes * 60 * 1000);
    }

    const aiChatMetadata = {
      mode,
      manual_until: manualUntil ? manualUntil.toISOString() : null,
    };

    if (!conversation) {
      conversation = await prisma.conversations.create({
        data: {
          account_id: accountId,
          platform_connection_id: connection.id,
          platform_type: 'FACEBOOK_PAGE',
          external_thread_id: conversationId,
          customer_external_id: customerExternalId,
          customer_name: customerName || connection.externalName || connection.name,
          metadata_json: {
            ai_chat: aiChatMetadata,
          },
        },
      });
    } else {
      const existingMetadata = (conversation.metadata_json as any) || {};
      conversation = await prisma.conversations.update({
        where: { id: conversation.id },
        data: {
          external_thread_id: conversationId,
          customer_name: customerName || conversation.customer_name,
          metadata_json: {
            ...existingMetadata,
            ai_chat: aiChatMetadata,
          },
        },
      });
    }

    const state = getAIChatState(conversation.metadata_json);
    return {
      ai_chat_mode: state.mode,
      ai_chat_manual_until: state.manual_until,
    };
  }
}

export function getAIChatState(metadata: any) {
  const aiChat = metadata?.ai_chat || {};
  const mode = aiChat.mode || 'auto';
  const manualUntilStr = aiChat.manual_until;
  const manualUntil = manualUntilStr ? new Date(manualUntilStr) : null;
  const now = new Date();

  if (mode === 'off') {
    return { mode: 'off', manual_until: null };
  }
  if (mode === 'manual' && manualUntil && manualUntil > now) {
    return { mode: 'manual', manual_until: manualUntil.toISOString() };
  }
  return { mode: 'auto', manual_until: null };
}
