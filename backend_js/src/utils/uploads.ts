import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Request } from 'express';
import { getSettings } from '../config/settings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Root uploads directory (served statically at /uploads) and per-resource
// subdirectories. Never trust client-supplied filenames or extensions.
export const UPLOADS_DIR = path.resolve(__dirname, '../../uploads');
export const PRODUCTS_UPLOAD_DIR = path.join(UPLOADS_DIR, 'products');

export function ensureUploadDirs(): void {
  fs.mkdirSync(PRODUCTS_UPLOAD_DIR, { recursive: true });
}

// Build the absolute public URL for an uploaded file. When public_base_url is
// configured (e.g. behind a reverse proxy / CDN) it wins; otherwise derive it
// from the incoming request protocol and host.
export function buildPublicFileUrl(req: Request, filename: string): string {
  const base = getSettings().public_base_url;
  if (base) {
    return `${base.replace(/\/$/, '')}/uploads/products/${filename}`;
  }
  const host = req.get('host') || 'localhost';
  return `${req.protocol}://${host}/uploads/products/${filename}`;
}
