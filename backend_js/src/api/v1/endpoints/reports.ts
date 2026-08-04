import { Router, Response, NextFunction } from 'express';
import { prisma } from '../../../core/db.js';
import { requireUser, AuthenticatedRequest } from '../../../middlewares/auth.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../../core/errors.js';

export const reportsRouter = Router();

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

// Helpers: date bucketing (zero-filled windows, 'YYYY-MM-DD' keys)
const toDateKey = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const lastNDates = (n: number): Date[] => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dates: Date[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    dates.push(d);
  }
  return dates;
};

const windowStartDate = (days: number): Date => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(today.getDate() - (days - 1));
  return start;
};

const bucketDailyCounts = (rows: { created_at: Date }[], days: number): { date: string; count: number }[] => {
  const dates = lastNDates(days);
  const counts = new Map<string, number>();
  for (const d of dates) {
    counts.set(toDateKey(d), 0);
  }
  for (const row of rows) {
    const key = toDateKey(row.created_at);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return dates.map((d) => ({ date: toDateKey(d), count: counts.get(toDateKey(d)) || 0 }));
};

const bucketDailyTokens = (rows: { used_at: Date; total_tokens: number }[], days: number): { date: string; tokens_consumed: number }[] => {
  const dates = lastNDates(days);
  const totals = new Map<string, number>();
  for (const d of dates) {
    totals.set(toDateKey(d), 0);
  }
  for (const row of rows) {
    const key = toDateKey(row.used_at);
    totals.set(key, (totals.get(key) || 0) + row.total_tokens);
  }
  return dates.map((d) => ({ date: toDateKey(d), tokens_consumed: totals.get(toDateKey(d)) || 0 }));
};

// 1. GET /reports/dashboard-summary
reportsRouter.get('/dashboard-summary', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [openConversations, pendingComments, scheduledPosts, latestAuditEvents, account] = await Promise.all([
      prisma.conversations.count({ where: { account_id: accountId, status: { in: ['OPEN', 'ASSIGNED'] } } }),
      prisma.facebook_comments.count({ where: { account_id: accountId, status: 'PENDING' } }),
      prisma.social_posts.count({ where: { account_id: accountId, status: 'SCHEDULED' } }),
      prisma.audit_logs.count({ where: { account_id: accountId, occurred_at: { gte: sevenDaysAgo } } }),
      prisma.account.findUnique({ where: { id: accountId } }),
    ]);

    const currentTokenBalance = account ? account.tokenBalance : 0;
    const monthlyTokenCredit = account ? account.monthlyTokenCredit : 0;

    return res.json({
      cards: [
        { label: 'Open Conversations', value: openConversations, secondary: null },
        { label: 'Pending Comments', value: pendingComments, secondary: null },
        { label: 'Scheduled Posts', value: scheduledPosts, secondary: null },
        { label: 'Token Balance', value: currentTokenBalance, secondary: null },
        { label: 'Latest Audit Events (7d)', value: latestAuditEvents, secondary: null },
      ],
      latest_audit_events: latestAuditEvents,
      open_conversations: openConversations,
      pending_comments: pendingComments,
      scheduled_posts: scheduledPosts,
      current_token_balance: currentTokenBalance,
      monthly_token_credit: monthlyTokenCredit,
    });
  } catch (err) {
    next(err);
  }
});

// 2. GET /reports/token-usage-summary
reportsRouter.get('/token-usage-summary', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);

    const [llmAgg, actionCount, actionGroups] = await Promise.all([
      prisma.llm_token_usage.aggregate({
        where: { account_id: accountId },
        _sum: { total_tokens: true, estimated_cost: true },
      }),
      prisma.action_usage_logs.count({ where: { account_id: accountId } }),
      prisma.action_usage_logs.groupBy({
        by: ['action_type'],
        where: { account_id: accountId },
        _sum: { quantity: true, tokens_consumed: true, estimated_cost: true },
      }),
    ]);

    const days = 14;
    const usageRows = await prisma.llm_token_usage.findMany({
      where: { account_id: accountId, used_at: { gte: windowStartDate(days) } },
      select: { used_at: true, total_tokens: true },
    });

    const topActions = actionGroups
      .slice()
      .sort((a, b) => (b._sum.tokens_consumed || 0) - (a._sum.tokens_consumed || 0))
      .slice(0, 5)
      .map((g) => ({
        action_type: g.action_type.toLowerCase(),
        quantity: g._sum.quantity || 0,
        tokens_consumed: g._sum.tokens_consumed || 0,
        estimated_cost: String(g._sum.estimated_cost || 0),
      }));

    return res.json({
      total_tokens_consumed: llmAgg._sum.total_tokens || 0,
      total_estimated_cost: String(llmAgg._sum.estimated_cost || 0),
      total_action_count: actionCount,
      top_actions: topActions,
      daily_usage: bucketDailyTokens(usageRows, days),
    });
  } catch (err) {
    next(err);
  }
});

// 3. GET /reports/billing-summary
reportsRouter.get('/billing-summary', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);

    const [account, subscription, wallet, llmAgg, actionAgg, modelGroups] = await Promise.all([
      prisma.account.findUnique({ where: { id: accountId } }),
      prisma.account_subscriptions.findFirst({
        where: { account_id: accountId },
        orderBy: { created_at: 'desc' },
        include: { billing_plans: true },
      }),
      prisma.token_wallets.findUnique({ where: { account_id: accountId } }),
      prisma.llm_token_usage.aggregate({
        where: { account_id: accountId },
        _sum: { estimated_cost: true },
      }),
      prisma.action_usage_logs.aggregate({
        where: { account_id: accountId },
        _sum: { estimated_cost: true },
      }),
      prisma.llm_token_usage.groupBy({
        by: ['model_name'],
        where: { account_id: accountId },
        _sum: { total_tokens: true, estimated_cost: true },
      }),
    ]);

    if (!account) {
      throw new NotFoundError('Account not found.');
    }

    const llmCost = Number(llmAgg._sum.estimated_cost || 0);
    const actionCost = Number(actionAgg._sum.estimated_cost || 0);

    return res.json({
      current_token_balance: account.tokenBalance,
      monthly_token_credit: account.monthlyTokenCredit,
      active_plan_code: subscription?.billing_plans?.code ?? null,
      active_plan_name: subscription?.billing_plans?.name ?? null,
      subscription_status: subscription ? subscription.status.toLowerCase() : null,
      billed_tokens: wallet ? wallet.lifetime_debited_tokens : 0,
      estimated_llm_cost: String(llmAgg._sum.estimated_cost || 0),
      estimated_action_cost: String(actionAgg._sum.estimated_cost || 0),
      total_estimated_cost: String(llmCost + actionCost),
      llm_usage_by_model: modelGroups.map((g) => ({
        model_name: g.model_name,
        total_tokens: g._sum.total_tokens || 0,
        estimated_cost: String(g._sum.estimated_cost || 0),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// 4. GET /reports/conversation-stats
reportsRouter.get('/conversation-stats', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);

    const [total, open, resolved, assigned, paused, recent] = await Promise.all([
      prisma.conversations.count({ where: { account_id: accountId } }),
      prisma.conversations.count({ where: { account_id: accountId, status: { in: ['OPEN', 'ASSIGNED'] } } }),
      prisma.conversations.count({ where: { account_id: accountId, status: 'RESOLVED' } }),
      prisma.conversations.count({ where: { account_id: accountId, status: 'ASSIGNED' } }),
      prisma.conversations.count({ where: { account_id: accountId, status: 'PAUSED' } }),
      prisma.conversations.findMany({
        where: { account_id: accountId, created_at: { gte: windowStartDate(7) } },
        select: { created_at: true },
      }),
    ]);

    return res.json({
      total_conversations: total,
      open_conversations: open,
      resolved_conversations: resolved,
      assigned_conversations: assigned,
      paused_conversations: paused,
      recent_daily_counts: bucketDailyCounts(recent, 7),
    });
  } catch (err) {
    next(err);
  }
});

// 5. GET /reports/comment-stats
reportsRouter.get('/comment-stats', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);

    const [total, pending, replied, flagged, needReview, recent] = await Promise.all([
      prisma.facebook_comments.count({ where: { account_id: accountId } }),
      prisma.facebook_comments.count({ where: { account_id: accountId, status: 'PENDING' } }),
      prisma.facebook_comments.count({ where: { account_id: accountId, status: 'REPLIED' } }),
      prisma.facebook_comments.count({ where: { account_id: accountId, status: 'FLAGGED' } }),
      prisma.facebook_comments.count({ where: { account_id: accountId, status: 'NEED_REVIEW' } }),
      prisma.facebook_comments.findMany({
        where: { account_id: accountId, created_at: { gte: windowStartDate(7) } },
        select: { created_at: true },
      }),
    ]);

    return res.json({
      total_comments: total,
      pending_comments: pending,
      replied_comments: replied,
      flagged_comments: flagged,
      need_review_comments: needReview,
      recent_daily_counts: bucketDailyCounts(recent, 7),
    });
  } catch (err) {
    next(err);
  }
});

// 6. GET /reports/post-stats
reportsRouter.get('/post-stats', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);

    const [total, draft, scheduled, published, failed, recent] = await Promise.all([
      prisma.social_posts.count({ where: { account_id: accountId } }),
      prisma.social_posts.count({ where: { account_id: accountId, status: 'DRAFT' } }),
      prisma.social_posts.count({ where: { account_id: accountId, status: 'SCHEDULED' } }),
      prisma.social_posts.count({ where: { account_id: accountId, status: 'PUBLISHED' } }),
      prisma.social_posts.count({ where: { account_id: accountId, status: 'FAILED' } }),
      prisma.social_posts.findMany({
        where: { account_id: accountId, created_at: { gte: windowStartDate(7) } },
        select: { created_at: true },
      }),
    ]);

    return res.json({
      total_posts: total,
      draft_posts: draft,
      scheduled_posts: scheduled,
      published_posts: published,
      failed_posts: failed,
      recent_daily_counts: bucketDailyCounts(recent, 7),
    });
  } catch (err) {
    next(err);
  }
});

export default reportsRouter;
