import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../../core/db.js';
import { requireUser, AuthenticatedRequest } from '../../../middlewares/auth.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../../core/errors.js';

export const automationRouter = Router();

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

// Helper: format response (lowercase enum columns)
const toResponse = (workflow: any) => ({
  ...workflow,
  status: workflow.status.toLowerCase(),
  trigger_type: workflow.trigger_type.toLowerCase(),
  action_type: workflow.action_type.toLowerCase(),
});

// Helper: parse 'HH:MM' local time
const parseLocalTime = (time: string | null | undefined): { hours: number; minutes: number } => {
  const parts = (time || '09:00').split(':');
  const hours = parseInt(parts[0], 10);
  const minutes = parts[1] !== undefined ? parseInt(parts[1], 10) : 0;
  return {
    hours: isNaN(hours) ? 9 : hours,
    minutes: isNaN(minutes) ? 0 : minutes,
  };
};

// Helper: naive "tomorrow at schedule_local_time" (default '09:00'); timezone intentionally ignored
const computeNextRunAt = (scheduleLocalTime: string | null | undefined): Date => {
  const { hours, minutes } = parseLocalTime(scheduleLocalTime);
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hours, minutes, 0, 0);
};

const triggerTypes = ['inbox_message_received', 'facebook_comment_created', 'scheduled_daily'] as const;
const actionTypes = ['generate_inbox_reply', 'generate_comment_reply', 'generate_post_draft'] as const;
const workflowStatuses = ['draft', 'active', 'paused', 'archived'] as const;

const triggerFiltersSchema = z.object({
  include_keywords: z.array(z.string()).default([]),
  exclude_keywords: z.array(z.string()).default([]),
  customer_contains: z.string().nullable().default(null),
});

const actionConfigSchema = z.object({
  instructions: z.string().nullable().default(null),
  send_now: z.boolean().default(false),
  title_hint: z.string().nullable().default(null),
});

// 1. GET /automation/workflows
automationRouter.get('/', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const pageSize = req.query.page_size ? parseInt(req.query.page_size as string, 10) : 20;

    const where: any = { account_id: accountId };

    const items = await prisma.automation_workflows.findMany({
      where,
      orderBy: { created_at: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    const total = await prisma.automation_workflows.count({ where });

    return res.json({
      items: items.map(toResponse),
      total,
      page,
      page_size: pageSize,
    });
  } catch (err) {
    next(err);
  }
});

// 2. POST /automation/workflows
const createWorkflowSchema = z.object({
  name: z.string().min(1),
  trigger_type: z.enum(triggerTypes),
  action_type: z.enum(actionTypes),
  description: z.string().nullable().optional(),
  status: z.enum(workflowStatuses).optional(),
  platform_connection_id: z.number().nullable().optional(),
  ai_agent_id: z.number().nullable().optional(),
  delay_seconds: z.number().int().nonnegative().optional(),
  trigger_filters_json: triggerFiltersSchema.default({
    include_keywords: [],
    exclude_keywords: [],
    customer_contains: null,
  }),
  action_config_json: actionConfigSchema.default({
    instructions: null,
    send_now: false,
    title_hint: null,
  }),
  schedule_timezone: z.string().nullable().optional(),
  schedule_local_time: z.string().nullable().optional(),
});

automationRouter.post('/', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const payload = createWorkflowSchema.parse(req.body);

    const workflow = await prisma.automation_workflows.create({
      data: {
        account_id: accountId,
        name: payload.name,
        trigger_type: payload.trigger_type.toUpperCase() as any,
        action_type: payload.action_type.toUpperCase() as any,
        description: payload.description ?? null,
        status: (payload.status ?? 'draft').toUpperCase() as any,
        platform_connection_id: payload.platform_connection_id ?? null,
        ai_agent_id: payload.ai_agent_id ?? null,
        delay_seconds: payload.delay_seconds ?? 0,
        trigger_filters_json: payload.trigger_filters_json,
        action_config_json: payload.action_config_json,
        schedule_timezone: payload.schedule_timezone ?? null,
        schedule_local_time: payload.schedule_local_time ?? null,
        next_run_at: payload.trigger_type === 'scheduled_daily' ? computeNextRunAt(payload.schedule_local_time) : null,
        last_result_json: {},
      },
    });

    return res.status(201).json(toResponse(workflow));
  } catch (err) {
    next(err);
  }
});

// 3. PUT /automation/workflows/:workflowId
const updateWorkflowSchema = z.object({
  name: z.string().min(1).optional(),
  trigger_type: z.enum(triggerTypes).optional(),
  action_type: z.enum(actionTypes).optional(),
  description: z.string().nullable().optional(),
  status: z.enum(workflowStatuses).optional(),
  platform_connection_id: z.number().nullable().optional(),
  ai_agent_id: z.number().nullable().optional(),
  delay_seconds: z.number().int().nonnegative().optional(),
  trigger_filters_json: triggerFiltersSchema.optional(),
  action_config_json: actionConfigSchema.optional(),
  schedule_timezone: z.string().nullable().optional(),
  schedule_local_time: z.string().nullable().optional(),
});

automationRouter.put('/:workflowId', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const workflowId = parseInt(req.params.workflowId, 10);
    const payload = updateWorkflowSchema.parse(req.body);

    if (isNaN(workflowId)) {
      throw new BadRequestError('Invalid ID');
    }

    const workflow = await prisma.automation_workflows.findFirst({
      where: { id: workflowId, account_id: accountId },
    });

    if (!workflow) {
      throw new NotFoundError('Automation workflow not found.');
    }

    // If status set to 'active' and trigger is scheduled_daily, recompute next_run_at if null or past
    const triggerType = payload.trigger_type ?? workflow.trigger_type.toLowerCase();
    const status = payload.status ?? workflow.status.toLowerCase();
    let nextRunAt: Date | null = workflow.next_run_at;
    if (triggerType === 'scheduled_daily' && status === 'active') {
      if (!nextRunAt || nextRunAt.getTime() <= Date.now()) {
        nextRunAt = computeNextRunAt(payload.schedule_local_time ?? workflow.schedule_local_time);
      }
    }

    const updated = await prisma.automation_workflows.update({
      where: { id: workflowId },
      data: {
        name: payload.name !== undefined ? payload.name : workflow.name,
        trigger_type: payload.trigger_type !== undefined ? (payload.trigger_type.toUpperCase() as any) : workflow.trigger_type,
        action_type: payload.action_type !== undefined ? (payload.action_type.toUpperCase() as any) : workflow.action_type,
        description: payload.description !== undefined ? payload.description : workflow.description,
        status: payload.status !== undefined ? (payload.status.toUpperCase() as any) : workflow.status,
        platform_connection_id: payload.platform_connection_id !== undefined ? payload.platform_connection_id : workflow.platform_connection_id,
        ai_agent_id: payload.ai_agent_id !== undefined ? payload.ai_agent_id : workflow.ai_agent_id,
        delay_seconds: payload.delay_seconds !== undefined ? payload.delay_seconds : workflow.delay_seconds,
        trigger_filters_json: payload.trigger_filters_json !== undefined ? payload.trigger_filters_json : (workflow.trigger_filters_json as any),
        action_config_json: payload.action_config_json !== undefined ? payload.action_config_json : (workflow.action_config_json as any),
        schedule_timezone: payload.schedule_timezone !== undefined ? payload.schedule_timezone : workflow.schedule_timezone,
        schedule_local_time: payload.schedule_local_time !== undefined ? payload.schedule_local_time : workflow.schedule_local_time,
        next_run_at: nextRunAt,
      },
    });

    return res.json(toResponse(updated));
  } catch (err) {
    next(err);
  }
});

// 4. DELETE /automation/workflows/:workflowId
automationRouter.delete('/:workflowId', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const workflowId = parseInt(req.params.workflowId, 10);

    if (isNaN(workflowId)) {
      throw new BadRequestError('Invalid ID');
    }

    const workflow = await prisma.automation_workflows.findFirst({
      where: { id: workflowId, account_id: accountId },
    });

    if (!workflow) {
      throw new NotFoundError('Automation workflow not found.');
    }

    await prisma.automation_workflows.delete({
      where: { id: workflowId },
    });

    return res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// 5. POST /automation/workflows/:workflowId/run
automationRouter.post('/:workflowId/run', requireUser, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const accountId = getAccountId(req);
    const workflowId = parseInt(req.params.workflowId, 10);

    if (isNaN(workflowId)) {
      throw new BadRequestError('Invalid ID');
    }

    const workflow = await prisma.automation_workflows.findFirst({
      where: { id: workflowId, account_id: accountId },
    });

    if (!workflow) {
      throw new NotFoundError('Automation workflow not found.');
    }

    const job = await prisma.sync_jobs.create({
      data: {
        account_id: accountId,
        platform_connection_id: workflow.platform_connection_id,
        status: 'PENDING',
        job_type: 'AUTOMATION_RULE_EXECUTION',
        scheduled_for: new Date(),
        payload_json: {
          workflow_id: workflow.id,
          trigger_type: workflow.trigger_type,
          action_type: workflow.action_type,
          action_config_json: workflow.action_config_json,
        },
        result_json: {},
      },
    });

    // For scheduled_daily triggers, recompute next_run_at to the next occurrence
    const nextRunAt = workflow.trigger_type === 'SCHEDULED_DAILY'
      ? computeNextRunAt(workflow.schedule_local_time)
      : workflow.next_run_at;

    const updated = await prisma.automation_workflows.update({
      where: { id: workflowId },
      data: {
        last_triggered_at: new Date(),
        last_result_json: { status: 'queued' },
        next_run_at: nextRunAt,
      },
    });

    return res.json({
      workflow: toResponse(updated),
      sync_job_id: job.id,
    });
  } catch (err) {
    next(err);
  }
});

export default automationRouter;
