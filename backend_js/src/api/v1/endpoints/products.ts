import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../../core/db.js';
import { requireUser, AuthenticatedRequest } from '../../../middlewares/auth.js';
import { BadRequestError, ForbiddenError, NotFoundError, HttpError } from '../../../core/errors.js';
import { ensureUploadDirs, PRODUCTS_UPLOAD_DIR, buildPublicFileUrl } from '../../../utils/uploads.js';

export const productsRouter = Router();

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

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
  const hasAccess = req.user.userRole === 'OWNER' || req.user.userRole === 'SUPER_ADMIN' ||
    (req.user.memberships || []).some((m: any) => m.accountId === accountId && m.status === 'ACTIVE');

  if (!hasAccess) {
    throw new ForbiddenError('You do not have access to this account.');
  }
  return accountId;
};

// Helper: format product response (Decimal columns serialized as strings)
const toResponse = (product: any) => ({
  id: product.id,
  name: product.name,
  description: product.description,
  price: product.price ? product.price.toString() : null,
  currency: product.currency,
  price_text: product.price_text,
  images: product.images || [],
  category: product.category,
  is_available: product.is_available,
  platform_connection_id: product.platform_connection_id,
  created_at: product.created_at,
  updated_at: product.updated_at,
});

// Helper: assert a platform connection belongs to the account
const requireConnection = async (accountId: number, connectionId: number) => {
  const connection = await prisma.platformConnection.findFirst({
    where: { id: connectionId, accountId },
  });
  if (!connection) {
    throw new NotFoundError('Platform connection not found.');
  }
};

const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensureUploadDirs();
      cb(null, PRODUCTS_UPLOAD_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = MIME_EXTENSIONS[file.mimetype] || '.jpg';
      cb(null, `${randomUUID()}${ext}`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    if (MIME_EXTENSIONS[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new BadRequestError('Invalid image type. Only JPEG, PNG, WEBP, and GIF images are allowed.'));
    }
  },
  limits: { fileSize: 5 * 1024 * 1024 },
});

// Route-level middleware (upload only): lazily ensure the directory exists,
// run multer, and map multer failures to 400 BadRequest.
const uploadSingleImage = (req: Request, res: Response, next: NextFunction): void => {
  ensureUploadDirs();
  imageUpload.single('image')(req, res, (err: unknown) => {
    if (err) {
      if (err instanceof HttpError) {
        return next(err);
      }
      if (err instanceof multer.MulterError) {
        const message = err.code === 'LIMIT_FILE_SIZE'
          ? 'Image too large. Maximum size is 5 MB.'
          : 'Invalid image upload.';
        return next(new BadRequestError(message));
      }
      return next(new BadRequestError('Invalid image upload.'));
    }
    return next();
  });
};

// 1. POST /products/upload-image  (registered before any /:productId route)
productsRouter.post('/upload-image', requireUser, uploadSingleImage, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    getAccountId(req);
    const file = req.file;
    if (!file) {
      throw new BadRequestError('No image file uploaded. Field name must be "image".');
    }
    const url = buildPublicFileUrl(req, file.filename);
    return res.status(201).json({ url });
  } catch (err) {
    next(err);
  }
});

// 2. GET /products
productsRouter.get('/', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const connectionIdParam = req.query.connection_id as string | undefined;
    const q = req.query.q as string | undefined;
    const availableParam = req.query.available as string | undefined;

    const where: any = { account_id: accountId };
    if (connectionIdParam !== undefined) {
      const connectionId = parseInt(connectionIdParam, 10);
      if (isNaN(connectionId)) {
        throw new BadRequestError('Invalid connection_id filter.');
      }
      where.platform_connection_id = connectionId;
    }
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { category: { contains: q, mode: 'insensitive' } },
      ];
    }
    if (availableParam !== undefined) {
      if (availableParam === 'true') {
        where.is_available = true;
      } else if (availableParam === 'false') {
        where.is_available = false;
      } else {
        throw new BadRequestError('Invalid available filter. Use "true" or "false".');
      }
    }

    const products = await prisma.products.findMany({
      where,
      orderBy: { created_at: 'desc' },
    });

    return res.json(products.map(toResponse));
  } catch (err) {
    next(err);
  }
});

// 3. POST /products
const createProductSchema = z.object({
  name: z.string().min(1).max(255),
  platform_connection_id: z.number().int().positive(),
  images: z.array(z.string()).default([]),
  price: z.number().nonnegative().optional().nullable(),
  currency: z.string().max(10).optional().nullable(),
  price_text: z.string().max(100).optional().nullable(),
  description: z.string().optional().nullable(),
  category: z.string().max(100).optional().nullable(),
});

productsRouter.post('/', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const payload = createProductSchema.parse(req.body);

    await requireConnection(accountId, payload.platform_connection_id);

    const product = await prisma.products.create({
      data: {
        account_id: accountId,
        platform_connection_id: payload.platform_connection_id,
        name: payload.name,
        description: payload.description || null,
        price: payload.price ?? null,
        currency: payload.currency || null,
        price_text: payload.price_text || null,
        images: payload.images,
        category: payload.category || null,
        is_available: true,
      },
    });

    return res.status(201).json(toResponse(product));
  } catch (err) {
    next(err);
  }
});

// 4. PUT /products/:productId
const updateProductSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  platform_connection_id: z.number().int().positive().optional().nullable(),
  images: z.array(z.string()).optional(),
  price: z.number().nonnegative().optional().nullable(),
  currency: z.string().max(10).optional().nullable(),
  price_text: z.string().max(100).optional().nullable(),
  description: z.string().optional().nullable(),
  category: z.string().max(100).optional().nullable(),
});

productsRouter.put('/:productId', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const productId = parseInt(req.params.productId, 10);
    if (isNaN(productId)) {
      throw new BadRequestError('Invalid product ID.');
    }
    const payload = updateProductSchema.parse(req.body);

    const product = await prisma.products.findFirst({
      where: { id: productId, account_id: accountId },
    });
    if (!product) {
      throw new NotFoundError('Product not found.');
    }

    if (payload.platform_connection_id !== undefined && payload.platform_connection_id !== null) {
      await requireConnection(accountId, payload.platform_connection_id);
    }

    const updated = await prisma.products.update({
      where: { id: productId },
      data: {
        name: payload.name !== undefined ? payload.name : product.name,
        platform_connection_id: payload.platform_connection_id !== undefined ? payload.platform_connection_id : product.platform_connection_id,
        images: payload.images !== undefined ? payload.images : ((product.images as string[]) || []),
        price: payload.price !== undefined ? payload.price : product.price,
        currency: payload.currency !== undefined ? payload.currency : product.currency,
        price_text: payload.price_text !== undefined ? payload.price_text : product.price_text,
        description: payload.description !== undefined ? payload.description : product.description,
        category: payload.category !== undefined ? payload.category : product.category,
      },
    });

    return res.json(toResponse(updated));
  } catch (err) {
    next(err);
  }
});

// 5. DELETE /products/:productId
productsRouter.delete('/:productId', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const productId = parseInt(req.params.productId, 10);
    if (isNaN(productId)) {
      throw new BadRequestError('Invalid product ID.');
    }

    const product = await prisma.products.findFirst({
      where: { id: productId, account_id: accountId },
    });
    if (!product) {
      throw new NotFoundError('Product not found.');
    }

    await prisma.products.delete({
      where: { id: productId },
    });

    return res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// 6. PATCH /products/:productId/availability
const availabilitySchema = z.object({
  is_available: z.boolean(),
});

productsRouter.patch('/:productId/availability', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const productId = parseInt(req.params.productId, 10);
    if (isNaN(productId)) {
      throw new BadRequestError('Invalid product ID.');
    }
    const payload = availabilitySchema.parse(req.body);

    const product = await prisma.products.findFirst({
      where: { id: productId, account_id: accountId },
    });
    if (!product) {
      throw new NotFoundError('Product not found.');
    }

    const updated = await prisma.products.update({
      where: { id: productId },
      data: { is_available: payload.is_available },
    });

    return res.json(toResponse(updated));
  } catch (err) {
    next(err);
  }
});

export default productsRouter;
