import crypto from 'crypto';
import { getSettings } from '../config/settings.js';

const settings = getSettings();

class TokenCipher {
  private signingKey: Buffer;
  private encryptionKey: Buffer;

  constructor() {
    const secret = settings.secret_key;
    const digest = crypto.createHash('sha256').update(secret).digest();
    this.signingKey = digest.subarray(0, 16);
    this.encryptionKey = digest.subarray(16, 32);
  }

  encrypt(value: string | null | undefined): string | null {
    if (!value) return null;

    const version = Buffer.from([0x80]);
    const timestamp = Buffer.alloc(8);
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    timestamp.writeBigUInt64BE(nowSeconds);

    const iv = crypto.randomBytes(16);

    const cipher = crypto.createCipheriv('aes-128-cbc', this.encryptionKey, iv);
    let ciphertext = cipher.update(Buffer.from(value, 'utf8'));
    ciphertext = Buffer.concat([ciphertext, cipher.final()]);

    const hmacInput = Buffer.concat([version, timestamp, iv, ciphertext]);
    const hmac = crypto.createHmac('sha256', this.signingKey).update(hmacInput).digest();

    const token = Buffer.concat([version, timestamp, iv, ciphertext, hmac]);
    return token.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  decrypt(value: string | null | undefined): string | null {
    if (!value) return null;

    try {
      const token = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      if (token[0] !== 0x80) return null;

      const iv = token.subarray(9, 25);
      const ciphertext = token.subarray(25, token.length - 32);
      const hmacReceived = token.subarray(token.length - 32);

      const hmacInput = token.subarray(0, token.length - 32);
      const hmacExpected = crypto.createHmac('sha256', this.signingKey).update(hmacInput).digest();

      if (!crypto.timingSafeEqual(hmacReceived, hmacExpected)) {
        return null;
      }

      const decipher = crypto.createDecipheriv('aes-128-cbc', this.encryptionKey, iv);
      let decrypted = decipher.update(ciphertext);
      decrypted = Buffer.concat([decrypted, decipher.final()]);

      return decrypted.toString('utf8');
    } catch {
      return null;
    }
  }
}

export const tokenCipher = new TokenCipher();
