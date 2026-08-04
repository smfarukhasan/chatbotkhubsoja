import express from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { v4 as uuidv4 } from 'uuid';

import { getSettings } from './config/settings.js';
import { logger } from './core/logging.js';
import { errorHandler } from './core/errors.js';
import { apiRouter } from './api/router.js';
import { ensureUploadDirs, UPLOADS_DIR } from './utils/uploads.js';

const settings = getSettings();
export const app = express();

// Ensure upload storage directories exist on process boot.
ensureUploadDirs();

// Middleware: Request ID and performance logging
app.use((req, res, next) => {
  const requestId = req.header('x-request-id') || uuidv4();
  (req as any).requestId = requestId;
  res.setHeader('x-request-id', requestId);

  const startTime = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    
    // Log request completion
    logger.info(`${req.method} ${req.originalUrl} - ${res.statusCode} - ${duration}ms`, {
      requestId,
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration,
    });
  });

  next();
});

// Gzip compression
app.use(compression({ threshold: 1024 }));

// Security headers (Helmet)
app.use(
  helmet({
    contentSecurityPolicy: settings.environment === 'production',
  })
);

// CORS setup
app.use(
  cors({
    origin: settings.cors_origins.includes('*') ? true : settings.cors_origins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Account-ID'],
  })
);

// Parsers
app.use(express.json({
  limit: '10mb',
  verify: (req: any, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Static serving for uploaded files (e.g. product images at /uploads/products/<filename>)
app.use('/uploads', express.static(UPLOADS_DIR));

// Prefix router
app.use(settings.api_v1_prefix, apiRouter);

// Global exception handling middleware
app.use(errorHandler);
