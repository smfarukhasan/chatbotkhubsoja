import { randomUUID } from 'crypto';

export interface OAuthSessionData {
  account_id: number;
  actor_user_id: number;
  redirect_uri: string;
  long_lived_user_token?: string;
  pages?: any[];
  expires_at: string;
}

export class FacebookOAuthSessionStore {
  // Use static memory store to survive instantiations
  private static store = new Map<string, OAuthSessionData>();

  create(payload: Omit<OAuthSessionData, 'expires_at' | 'long_lived_user_token' | 'pages'>, ttlSeconds = 900): string {
    const sessionId = randomUUID().replace(/-/g, '');
    this.save(sessionId, payload, ttlSeconds);
    return sessionId;
  }

  save(sessionId: string, payload: Omit<OAuthSessionData, 'expires_at'>, ttlSeconds = 900): void {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const data: OAuthSessionData = {
      ...payload,
      expires_at: expiresAt,
    };
    FacebookOAuthSessionStore.store.set(sessionId, data);
  }

  get(sessionId: string): OAuthSessionData | null {
    const item = FacebookOAuthSessionStore.store.get(sessionId);
    if (!item) return null;

    if (new Date(item.expires_at) <= new Date()) {
      FacebookOAuthSessionStore.store.delete(sessionId);
      return null;
    }

    return item;
  }

  delete(sessionId: string): void {
    FacebookOAuthSessionStore.store.delete(sessionId);
  }
}
