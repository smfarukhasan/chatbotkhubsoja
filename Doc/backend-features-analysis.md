# Backend Features Analysis

> Repo: `chatbotkhubsoja`
> Analyzed: `backend_js/` (live backend)
> Date: 2026-08-04

## Overview

The repo README describes a larger Python/FastAPI backend (packed as `backend.zip`), but the live code is an **Express.js + TypeScript + Prisma rewrite** (`backend_js/`) that implements a subset of those features.

### Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js, Express 4, TypeScript |
| ORM | Prisma (MySQL) |
| Queues | BullMQ + Redis |
| Auth | JWT (jsonwebtoken) + bcryptjs, server-side refresh-token revocation |
| Validation | Zod |
| Security | Helmet, CORS, compression, HMAC webhook signature check |
| Logging | Winston, request IDs, process-time headers |

## What's Implemented (Mounted Routes)

### Auth (`/auth`)
- `POST /login`, `POST /register` (with onboarding-key validation: revoked / expired / exhausted / email-bound), `POST /refresh` (rotation with server-side revocation), `POST /logout` (single or all devices), `POST /change-password`, `GET /me`
- Auto-bootstraps the owner user from settings
- Hierarchical permission resolution: owner → superAdmin → admin (admin inherits `feature:*` permissions from its managing superAdmin)

### User Management (`/users`)
- `GET /` (role-scoped listing)
- `POST/PATCH /super-admins` — SuperAdmin creation also provisions an account, owner membership, and token wallet in one transaction
- `POST/PATCH /admins`, `DELETE /admins/:id`
- `POST /:id/reset-password`
- Disabling a superAdmin cascades to managed admins and revokes their sessions

### Accounts (`/accounts`)
- `GET /current/members` (team list)
- `PATCH /current` (profile image)
- Multi-tenant isolation via `X-Account-ID` header + membership check (shared by every module)

### Platform Connections (`/platform-connections`)
- CRUD + `PATCH /:id/status`, `POST /:id/disconnect`, `DELETE /:id`
- **Facebook**: OAuth start/complete/connect, manual connect, `facebook/sync`, `subscribe-webhooks` — real Graph API calls (list pages, page profile, subscribed apps, token exchange)
- **WhatsApp**: manual connect + sync — real Cloud API calls (phone-number profile)
- Encrypted token storage (`utils/crypto.ts`), webhook config fields, status tracking (pending / connected / action_required / disconnected / error)

### Webhooks (`/webhooks`) — real provider ingestion
- `GET/POST /facebook-page` and `GET/POST /whatsapp`
- Verify-token challenge for GET, `X-Hub-Signature-256` HMAC validation (timing-safe) for POST
- Durable storage to `webhook_events`, dedup via SHA-256 event key, respond `202` and enqueue to BullMQ `webhooks` queue
- Event types detected: `inbound_message`, `inbound_comment`, generic events

### Inbox (`/inbox`)
- **Live Facebook inbox**: `GET /facebook/live/conversations`, `GET /facebook/live/conversations/:id/messages`, `POST /facebook/live/reply` — real Graph API reads/send
- **Local DB inbox**: `GET /conversations` (filter by status/search, paginated), `GET /conversations/:id`, `GET /conversations/:id/messages`, `POST /conversations/:id/reply`
- **AI-chat per conversation**: `PATCH /facebook/live/conversations/:id/ai-chat` and `PATCH /conversations/:id/ai-chat` — modes `auto` / `manual` (with `manual_minutes` pause) / `off`, stored in `metadata_json`; a manual reply auto-pauses AI for 15 minutes

### Facebook Comment Moderation (`/comments`)
- List with filters (status, connection, post, search)
- Group by post: `GET /comments/posts`, `GET /comments/posts/:postExternalId`
- Detail with reply history: `GET /comments/:id`
- `PATCH /:id/status` (pending / replied / ignored / flagged / need_review)
- `POST /:id/replies` — real Graph API comment reply when `send_now`; records reply status and updates the comment to `replied`

### Posts (`/posts`)
- CRUD with status transitions, media URLs, AI-agent/prompt linkage fields, scheduling timestamp
- `POST /:id/publish-now` — **real** Graph API publish to the Page feed; marks `published` / `failed`
- `PATCH /:id/ai-auto-reply` toggle

### Health (`/health`)
- API + database status (`200` ok / `500` degraded)

## Infrastructure

- BullMQ queues defined for `default`, `webhooks`, `sync`, `maintenance`, `messages`, `comments`, `posts` (3 attempts, exponential backoff)
- Request-ID + process-time logging middleware
- Centralized error handler with a standardized error envelope
- Express app: Helmet (CSP in production), CORS, gzip compression, 10 MB JSON body limit with raw-body capture (for webhook signature verification)

## Gaps vs. README / Python Version (not implemented in `backend_js`)

- **No AI endpoints** — agents, prompts, knowledge sources, FAQ, or AI generation (the README's `/ai/*` are absent here)
- **No billing / subscription / token-wallet endpoints** (`/billing/*`, token ledger, plans)
- **No automation workflow endpoints** (`/automation/workflows`)
- **No observability / reports / audit endpoints** (`/observability/*`, `/reports/*`)
- **No worker process** — only queue definitions exist; nothing consumes them, so queued webhook events are stored but never processed (no AI reply generation, no scheduled publishing, no delivery retries)

> Note: the frontend already has API layers for all of the above (`aiApi`, `billingApi`, `automationApi`, `observabilityApi`, `reportApi`) — those frontend features will 404 against this backend until the routes are added.
