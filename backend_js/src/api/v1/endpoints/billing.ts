import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../../core/db.js';
import { requireUser, AuthenticatedRequest } from '../../../middlewares/auth.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../../core/errors.js';

export const billingRouter = Router();

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

// Shared include: plan + features + feature catalog
const planInclude = {
  plan_features: {
    include: { feature_catalog: true },
  },
} as const;

const subscriptionInclude = {
  billing_plans: {
    include: planInclude,
  },
} as const;

// Serializers
const serializePlan = (plan: any) => {
  const { plan_features, ...rest } = plan;
  return {
    ...rest,
    billing_interval: rest.billing_interval.toLowerCase(),
    features: (plan_features || []).map((pf: any) => ({
      feature: pf.feature_catalog,
      included_value: String(pf.included_value),
      overage_price_usd: pf.overage_price_usd != null ? String(pf.overage_price_usd) : null,
      config_json: pf.config_json as any,
    })),
  };
};

const serializeSubscription = (sub: any) => {
  const { billing_plans, ...rest } = sub;
  return {
    ...rest,
    status: rest.status.toLowerCase(),
    plan: billing_plans ? serializePlan(billing_plans) : null,
  };
};

const serializeTransaction = (tx: any) => ({
  ...tx,
  transaction_type: tx.transaction_type.toLowerCase(),
  status: tx.status.toLowerCase(),
});

const serializeLedgerEntry = (entry: any) => ({
  ...entry,
  entry_type: entry.entry_type.toLowerCase(),
  source_type: entry.source_type.toLowerCase(),
  allocation_type: entry.allocation_type ? entry.allocation_type.toLowerCase() : null,
});

// 1. GET /billing/plans
billingRouter.get('/plans', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    getAccountId(req);

    const plans = await prisma.billing_plans.findMany({
      include: planInclude,
    });

    return res.json({
      items: plans.map(serializePlan),
      total: plans.length,
    });
  } catch (err) {
    next(err);
  }
});

// 2. GET /billing/features
billingRouter.get('/features', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    getAccountId(req);

    const items = await prisma.feature_catalog.findMany({
      where: { is_active: true },
    });

    return res.json({
      items,
      total: items.length,
    });
  } catch (err) {
    next(err);
  }
});

// 3. GET /billing/subscription
billingRouter.get('/subscription', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);

    const subscription = await prisma.account_subscriptions.findFirst({
      where: { account_id: accountId },
      orderBy: { created_at: 'desc' },
      include: subscriptionInclude,
    });

    if (!subscription) {
      return res.json(null);
    }

    return res.json(serializeSubscription(subscription));
  } catch (err) {
    next(err);
  }
});

// 4. POST /billing/subscription
const createSubscriptionSchema = z.object({
  billing_plan_code: z.string().min(1),
  status: z.enum(['trialing', 'active', 'past_due', 'canceled', 'expired']).optional(),
});

billingRouter.post('/subscription', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const payload = createSubscriptionSchema.parse(req.body);

    const plan = await prisma.billing_plans.findUnique({
      where: { code: payload.billing_plan_code },
    });
    if (!plan) {
      throw new NotFoundError('Billing plan not found.');
    }

    const now = new Date();
    const renewsAt = new Date(now.getTime());
    renewsAt.setMonth(renewsAt.getMonth() + 1);

    const subscription = await prisma.account_subscriptions.create({
      data: {
        account_id: accountId,
        billing_plan_id: plan.id,
        status: payload.status ? (payload.status.toUpperCase() as any) : ('TRIALING' as any),
        starts_at: now,
        renews_at: renewsAt,
        metadata_json: {},
      },
    });

    // Snapshot the plan's features for this subscription
    const planFeatures = await prisma.plan_features.findMany({
      where: { billing_plan_id: plan.id },
      include: { feature_catalog: true },
    });

    if (planFeatures.length > 0) {
      await prisma.account_subscription_feature_snapshot.createMany({
        data: planFeatures.map((pf) => ({
          account_subscription_id: subscription.id,
          feature_catalog_id: pf.feature_catalog_id,
          feature_code: pf.feature_catalog.code,
          feature_name: pf.feature_catalog.name,
          included_value: Number(pf.included_value),
          config_json: pf.config_json as any,
        })),
      });
    }

    // Apply monthly token credit (wallet + ledger + account) atomically
    const credit = plan.monthly_token_credit;
    if (credit > 0) {
      const [wallet] = await prisma.$transaction(async (tx) => {
        const w = await tx.token_wallets.upsert({
          where: { account_id: accountId },
          create: {
            account_id: accountId,
            status: 'ACTIVE' as any,
            balance_tokens: credit,
            reserved_tokens: 0,
            lifetime_credited_tokens: credit,
            lifetime_debited_tokens: 0,
            metadata_json: {},
          },
          update: {
            balance_tokens: { increment: credit },
            lifetime_credited_tokens: { increment: credit },
          },
        });

        await tx.token_ledger.create({
          data: {
            token_wallet_id: w.id,
            account_id: accountId,
            account_subscription_id: subscription.id,
            entry_type: 'CREDIT' as any,
            source_type: 'SUBSCRIPTION' as any,
            allocation_type: 'MONTHLY_FREE' as any,
            delta_tokens: credit,
            balance_before: w.balance_tokens - credit,
            balance_after: w.balance_tokens,
            remaining_tokens: credit,
            is_expired: false,
            occurred_at: now,
            metadata_json: {},
          },
        });

        const acc = await tx.account.update({
          where: { id: accountId },
          data: {
            tokenBalance: { increment: credit },
            monthlyTokenCredit: plan.monthly_token_credit,
          },
        });

        return [w, acc];
      });

      void wallet;
    }

    const created = await prisma.account_subscriptions.findUnique({
      where: { id: subscription.id },
      include: subscriptionInclude,
    });

    return res.status(201).json(serializeSubscription(created));
  } catch (err) {
    next(err);
  }
});

// 5. PUT /billing/subscription
const updateSubscriptionSchema = z.object({
  billing_plan_code: z.string().min(1),
  status: z.enum(['trialing', 'active', 'past_due', 'canceled', 'expired']).optional(),
});

billingRouter.put('/subscription', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const payload = updateSubscriptionSchema.parse(req.body);

    const subscription = await prisma.account_subscriptions.findFirst({
      where: { account_id: accountId },
      orderBy: { created_at: 'desc' },
      include: { billing_plans: true },
    });

    if (!subscription) {
      throw new NotFoundError('Subscription not found.');
    }

    const data: any = {};

    if (payload.billing_plan_code !== subscription.billing_plans.code) {
      const newPlan = await prisma.billing_plans.findUnique({
        where: { code: payload.billing_plan_code },
      });
      if (!newPlan) {
        throw new NotFoundError('Billing plan not found.');
      }

      data.billing_plan_id = newPlan.id;

      // Replace feature snapshots with the new plan's features
      await prisma.account_subscription_feature_snapshot.deleteMany({
        where: { account_subscription_id: subscription.id },
      });

      const newPlanFeatures = await prisma.plan_features.findMany({
        where: { billing_plan_id: newPlan.id },
        include: { feature_catalog: true },
      });

      if (newPlanFeatures.length > 0) {
        await prisma.account_subscription_feature_snapshot.createMany({
          data: newPlanFeatures.map((pf) => ({
            account_subscription_id: subscription.id,
            feature_catalog_id: pf.feature_catalog_id,
            feature_code: pf.feature_catalog.code,
            feature_name: pf.feature_catalog.name,
            included_value: Number(pf.included_value),
            config_json: pf.config_json as any,
          })),
        });
      }
    }

    if (payload.status) {
      data.status = payload.status.toUpperCase();
    }

    const updated = await prisma.account_subscriptions.update({
      where: { id: subscription.id },
      data,
      include: subscriptionInclude,
    });

    return res.json(serializeSubscription(updated));
  } catch (err) {
    next(err);
  }
});

// 6. GET /billing/wallet
billingRouter.get('/wallet', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);

    let wallet = await prisma.token_wallets.findUnique({
      where: { account_id: accountId },
    });

    if (!wallet) {
      const account = await prisma.account.findUnique({
        where: { id: accountId },
      });
      wallet = await prisma.token_wallets.create({
        data: {
          account_id: accountId,
          status: 'ACTIVE' as any,
          balance_tokens: account?.tokenBalance ?? 0,
          reserved_tokens: 0,
          lifetime_credited_tokens: 0,
          lifetime_debited_tokens: 0,
          metadata_json: {},
        },
      });
    }

    const credits = await prisma.token_ledger.findMany({
      where: {
        account_id: accountId,
        entry_type: 'CREDIT',
        is_expired: false,
        remaining_tokens: { gt: 0 },
      },
    });

    let availableMonthlyFreeTokens = 0;
    let availablePurchasedTokens = 0;
    let availableManualTokens = 0;

    for (const entry of credits) {
      const remaining = entry.remaining_tokens ?? 0;
      if (entry.allocation_type === 'MONTHLY_FREE') {
        availableMonthlyFreeTokens += remaining;
      } else if (entry.allocation_type === 'PURCHASED') {
        availablePurchasedTokens += remaining;
      } else {
        availableManualTokens += remaining;
      }
    }

    // Sum remaining tokens of entries expiring at the earliest future date
    let expiringNextTokens = 0;
    const nowMs = Date.now();
    const futureCredits = credits
      .filter((entry) => entry.expires_at && entry.expires_at.getTime() > nowMs)
      .sort((a, b) => a.expires_at!.getTime() - b.expires_at!.getTime());

    if (futureCredits.length > 0) {
      const earliest = futureCredits[0].expires_at!.getTime();
      expiringNextTokens = futureCredits
        .filter((entry) => entry.expires_at!.getTime() === earliest)
        .reduce((sum, entry) => sum + (entry.remaining_tokens ?? 0), 0);
    }

    return res.json({
      wallet: {
        ...wallet,
        status: wallet.status.toLowerCase(),
      },
      breakdown: {
        available_monthly_free_tokens: availableMonthlyFreeTokens,
        available_purchased_tokens: availablePurchasedTokens,
        available_manual_tokens: availableManualTokens,
        total_available_tokens: wallet.balance_tokens,
        expiring_next_tokens: expiringNextTokens,
      },
    });
  } catch (err) {
    next(err);
  }
});

// 7. GET /billing/transactions
billingRouter.get('/transactions', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const pageSize = req.query.page_size ? parseInt(req.query.page_size as string, 10) : 20;

    const where = { account_id: accountId };

    const items = await prisma.billing_transactions.findMany({
      where,
      orderBy: { occurred_at: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    const total = await prisma.billing_transactions.count({ where });

    return res.json({
      items: items.map(serializeTransaction),
      total,
      page,
      page_size: pageSize,
    });
  } catch (err) {
    next(err);
  }
});

// 8. GET /billing/token-ledger
billingRouter.get('/token-ledger', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const pageSize = req.query.page_size ? parseInt(req.query.page_size as string, 10) : 20;

    const where = { account_id: accountId };

    const items = await prisma.token_ledger.findMany({
      where,
      orderBy: { occurred_at: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    const total = await prisma.token_ledger.count({ where });

    return res.json({
      items: items.map(serializeLedgerEntry),
      total,
      page,
      page_size: pageSize,
    });
  } catch (err) {
    next(err);
  }
});

// 9. GET /billing/token-packages
billingRouter.get('/token-packages', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    getAccountId(req);

    const items = await prisma.token_purchase_packages.findMany({
      where: { is_active: true },
    });

    return res.json({
      items,
      total: items.length,
    });
  } catch (err) {
    next(err);
  }
});

// 10. POST /billing/token-packages
const createTokenPackageSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  token_amount: z.number().int().positive(),
  price_usd: z.number().nonnegative(),
  description: z.string().optional().nullable(),
  bonus_tokens: z.number().int().nonnegative().optional(),
  currency: z.string().min(1).optional(),
  metadata_json: z.record(z.string(), z.any()).optional(),
});

billingRouter.post('/token-packages', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    getAccountId(req);
    const payload = createTokenPackageSchema.parse(req.body);

    const tokenPackage = await prisma.token_purchase_packages.create({
      data: {
        code: payload.code,
        name: payload.name,
        description: payload.description ?? null,
        token_amount: payload.token_amount,
        bonus_tokens: payload.bonus_tokens ?? 0,
        price_usd: payload.price_usd,
        currency: payload.currency ?? 'USD',
        is_active: true,
        metadata_json: payload.metadata_json ?? {},
      },
    });

    return res.status(201).json(tokenPackage);
  } catch (err) {
    next(err);
  }
});

// 11. POST /billing/token-purchases
const createTokenPurchaseSchema = z.object({
  package_code: z.string().min(1),
});

billingRouter.post('/token-purchases', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const payload = createTokenPurchaseSchema.parse(req.body);

    const tokenPackage = await prisma.token_purchase_packages.findUnique({
      where: { code: payload.package_code },
    });
    if (!tokenPackage) {
      throw new NotFoundError('Token package not found.');
    }

    const now = new Date();
    const tokens = tokenPackage.token_amount + tokenPackage.bonus_tokens;
    const priceUsd = Number(tokenPackage.price_usd);

    const transaction = await prisma.billing_transactions.create({
      data: {
        account_id: accountId,
        token_purchase_package_id: tokenPackage.id,
        transaction_type: 'TOKEN_PURCHASE' as any,
        status: 'SUCCEEDED' as any,
        currency: 'USD',
        amount_usd: priceUsd,
        tax_usd: 0,
        total_amount_usd: priceUsd,
        occurred_at: now,
        paid_at: now,
        metadata_json: {},
      },
    });

    // Credit the wallet (wallet + ledger + account) atomically
    await prisma.$transaction(async (tx) => {
      const wallet = await tx.token_wallets.upsert({
        where: { account_id: accountId },
        create: {
          account_id: accountId,
          status: 'ACTIVE' as any,
          balance_tokens: tokens,
          reserved_tokens: 0,
          lifetime_credited_tokens: tokens,
          lifetime_debited_tokens: 0,
          metadata_json: {},
        },
        update: {
          balance_tokens: { increment: tokens },
          lifetime_credited_tokens: { increment: tokens },
        },
      });

      await tx.token_ledger.create({
        data: {
          token_wallet_id: wallet.id,
          account_id: accountId,
          billing_transaction_id: transaction.id,
          entry_type: 'CREDIT' as any,
          source_type: 'TOKEN_PACKAGE' as any,
          allocation_type: 'PURCHASED' as any,
          delta_tokens: tokens,
          balance_before: wallet.balance_tokens - tokens,
          balance_after: wallet.balance_tokens,
          unit_price_usd: tokens > 0 ? priceUsd / tokens : 0,
          total_price_usd: priceUsd,
          remaining_tokens: tokens,
          is_expired: false,
          occurred_at: now,
          metadata_json: {},
        },
      });

      await tx.account.update({
        where: { id: accountId },
        data: {
          tokenBalance: { increment: tokens },
        },
      });
    });

    return res.json(serializeTransaction(transaction));
  } catch (err) {
    next(err);
  }
});

export default billingRouter;
