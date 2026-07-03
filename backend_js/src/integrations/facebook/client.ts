import axios from 'axios';
import { getSettings } from '../../config/settings.js';

const settings = getSettings();

export interface FacebookPageCandidate {
  page_id: string;
  page_name: string;
  page_access_token: string;
  category?: string;
  tasks: string[];
  picture_url?: string;
}

export interface FacebookPageProfile {
  page_id: string;
  page_name: string;
  category?: string;
  followers_count?: number;
  picture_url?: string;
}

export class FacebookGraphAPIError extends Error {
  public code?: number;
  public subcode?: number;
  public statusCode?: number;
  public payload: any;

  constructor(message: string, code?: number, subcode?: number, statusCode?: number, payload?: any) {
    super(message);
    this.code = code;
    this.subcode = subcode;
    this.statusCode = statusCode;
    this.payload = payload || {};
  }

  get isTokenError(): boolean {
    return [102, 190].includes(this.code || 0) || [460, 463, 467].includes(this.subcode || 0);
  }

  get isPermissionError(): boolean {
    return [10, 200].includes(this.code || 0);
  }
}

export class FacebookGraphAPIClient {
  private baseUrl: string;
  private oauthBaseUrl: string;

  constructor() {
    this.baseUrl = `${settings.facebook_graph_api_base_url}/${settings.facebook_graph_api_version}`;
    this.oauthBaseUrl = `${settings.facebook_graph_api_base_url}/${settings.facebook_graph_api_version}/oauth`;
  }

  buildOAuthUrl(state: string, redirectUri: string, scopes: string[]): string {
    const params = new URLSearchParams({
      client_id: settings.facebook_app_id || '',
      redirect_uri: redirectUri,
      scope: scopes.join(','),
      state: state,
      response_type: 'code',
    });
    const dialogUrl = process.env.FACEBOOK_OAUTH_DIALOG_URL || 'https://www.facebook.com/dialog/oauth';
    return `${dialogUrl}?${params.toString()}`;
  }

  async exchangeCodeForUserToken(code: string, redirectUri: string): Promise<any> {
    return this.request('GET', `${this.oauthBaseUrl}/access_token`, {
      absoluteUrl: true,
      params: {
        client_id: settings.facebook_app_id || '',
        client_secret: settings.facebook_app_secret || '',
        redirect_uri: redirectUri,
        code,
      },
    });
  }

  async exchangeForLongLivedUserToken(accessToken: string): Promise<any> {
    return this.request('GET', `${this.oauthBaseUrl}/access_token`, {
      absoluteUrl: true,
      params: {
        grant_type: 'fb_exchange_token',
        client_id: settings.facebook_app_id || '',
        client_secret: settings.facebook_app_secret || '',
        fb_exchange_token: accessToken,
      },
    });
  }

  async listPageConversations(pageId: string, accessToken: string, limit = 25, after?: string): Promise<any> {
    return this.request('GET', `/${pageId}/conversations`, {
      accessToken,
      params: {
        limit,
        fields: 'id,updated_time,message_count,unread_count,snippet,link,senders',
        ...(after ? { after } : {}),
      },
    });
  }

  async listConversationMessages(conversationId: string, accessToken: string, limit = 100, after?: string): Promise<any> {
    return this.request('GET', `/${conversationId}/messages`, {
      accessToken,
      params: {
        limit,
        fields: 'id,created_time,message,from,to,attachments,sticker,shares',
        ...(after ? { after } : {}),
      },
    });
  }

  async listManagedPages(accessToken: string): Promise<FacebookPageCandidate[]> {
    const data = await this.request('GET', '/me/accounts', {
      accessToken,
      params: {
        fields: 'id,name,access_token,category,tasks,picture{url}',
      },
    });

    const items = data.data || [];
    return items.map((item: any) => ({
      page_id: String(item.id),
      page_name: item.name,
      page_access_token: item.access_token,
      category: item.category,
      tasks: item.tasks || [],
      picture_url: item.picture?.data?.url,
    }));
  }

  async getPageProfile(pageId: string, accessToken: string): Promise<FacebookPageProfile> {
    const data = await this.request('GET', `/${pageId}`, {
      accessToken,
      params: {
        fields: 'id,name,category,followers_count,picture{url}',
      },
    });

    return {
      page_id: String(data.id),
      page_name: data.name,
      category: data.category,
      followers_count: data.followers_count,
      picture_url: data.picture?.data?.url,
    };
  }

  async subscribePageToApp(pageId: string, accessToken: string): Promise<any> {
    return this.request('POST', `/${pageId}/subscribed_apps`, { accessToken });
  }

  async getPageSubscriptions(pageId: string, accessToken: string): Promise<any> {
    return this.request('GET', `/${pageId}/subscribed_apps`, { accessToken });
  }

  async sendMessage(pageAccessToken: string, recipientId: string, text: string): Promise<any> {
    return this.request('POST', '/me/messages', {
      accessToken: pageAccessToken,
      data: {
        recipient: { id: recipientId },
        messaging_type: 'RESPONSE',
        message: { text },
      },
    });
  }

  async replyToComment(pageAccessToken: string, commentId: string, text: string): Promise<any> {
    return this.request('POST', `/${commentId}/comments`, {
      accessToken: pageAccessToken,
      data: { message: text },
    });
  }

  async publishPost(pageAccessToken: string, pageId: string, message: string, link?: string, published = true): Promise<any> {
    const payload: any = { message, published };
    if (link) {
      payload.link = link;
    }
    return this.request('POST', `/${pageId}/feed`, {
      accessToken: pageAccessToken,
      data: payload,
    });
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    options: {
      accessToken?: string;
      params?: Record<string, any>;
      data?: Record<string, any>;
      absoluteUrl?: boolean;
    } = {}
  ): Promise<any> {
    const url = options.absoluteUrl ? path : `${this.baseUrl}${path}`;
    const params = { ...(options.params || {}) };
    if (options.accessToken) {
      params.access_token = options.accessToken;
    }

    try {
      const response = await axios({
        method,
        url,
        params: Object.keys(params).length ? params : undefined,
        data: options.data,
        timeout: 30000,
      });

      if (response.data && response.data.error) {
        const error = response.data.error;
        throw new FacebookGraphAPIError(
          error.message || 'Facebook API request failed.',
          error.code,
          error.error_subcode,
          response.status,
          response.data
        );
      }

      return response.data;
    } catch (err: any) {
      if (err instanceof FacebookGraphAPIError) {
        throw err;
      }
      const responseData = err.response?.data;
      const error = responseData?.error || {};
      throw new FacebookGraphAPIError(
        error.message || err.message || 'Facebook API request failed.',
        error.code,
        error.error_subcode,
        err.response?.status,
        responseData
      );
    }
  }
}
