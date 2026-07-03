import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { getSettings } from '../config/settings.js';

const settings = getSettings();
const ALGORITHM = 'HS256';

// Custom base64 decoding for passlib ab64 format (which uses '.' instead of '+', no padding)
const ab64Decode = (str: string): Buffer => {
  let standardBase64 = str.replace(/\./g, '+');
  while (standardBase64.length % 4) {
    standardBase64 += '=';
  }
  return Buffer.from(standardBase64, 'base64');
};

const verifyPbkdf2Sha256 = (password: string, hash: string): boolean => {
  try {
    // Passlib format: $pbkdf2-sha256$rounds$salt$digest
    const parts = hash.split('$');
    if (parts.length !== 5 || parts[1] !== 'pbkdf2-sha256') {
      return false;
    }
    const rounds = parseInt(parts[2], 10);
    const saltBuffer = ab64Decode(parts[3]);
    const originalDigestBuffer = ab64Decode(parts[4]);

    // Key length is the size of the digest
    const keyLen = originalDigestBuffer.length;

    // Perform pbkdf2 derivation
    const derived = crypto.pbkdf2Sync(
      password,
      saltBuffer,
      rounds,
      keyLen,
      'sha256'
    );

    return crypto.timingSafeEqual(derived, originalDigestBuffer);
  } catch (error) {
    return false;
  }
};

export const hashPassword = async (password: string): Promise<string> => {
  return bcrypt.hash(password, 10);
};

export const verifyPassword = async (plainPassword: string, hashedPassword: string): Promise<boolean> => {
  if (hashedPassword.startsWith('$pbkdf2-sha256$')) {
    return verifyPbkdf2Sha256(plainPassword, hashedPassword);
  }
  try {
    return await bcrypt.compare(plainPassword, hashedPassword);
  } catch {
    return false;
  }
};

interface TokenPayload {
  sub: string;
  type: 'access' | 'refresh';
  jti: string;
  exp: number;
}

export const createAccessToken = (userId: string): { token: string; expiresAt: Date } => {
  const expiresAt = new Date(Date.now() + settings.access_token_expire_minutes * 60 * 1000);
  const jti = crypto.randomUUID();
  const payload: TokenPayload = {
    sub: userId,
    type: 'access',
    jti,
    exp: Math.floor(expiresAt.getTime() / 1000),
  };
  const token = jwt.sign(payload, settings.secret_key, { algorithm: ALGORITHM });
  return { token, expiresAt };
};

export const createRefreshToken = (userId: string): { token: string; jti: string; expiresAt: Date } => {
  const expiresAt = new Date(Date.now() + settings.refresh_token_expire_days * 24 * 60 * 60 * 1000);
  const jti = crypto.randomUUID();
  const payload: TokenPayload = {
    sub: userId,
    type: 'refresh',
    jti,
    exp: Math.floor(expiresAt.getTime() / 1000),
  };
  const token = jwt.sign(payload, settings.secret_key, { algorithm: ALGORITHM });
  return { token, jti, expiresAt };
};

export const decodeToken = (token: string): TokenPayload => {
  try {
    return jwt.verify(token, settings.secret_key, { algorithms: [ALGORITHM] }) as TokenPayload;
  } catch (err) {
    throw new Error('Invalid or expired token.');
  }
};
