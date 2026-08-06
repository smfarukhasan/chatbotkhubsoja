# SaaS Chat Automation Platform

Multi-tenant SaaS chat automation platform for Facebook Page and WhatsApp — built with Express, TypeScript, Prisma, React, MySQL, Redis, BullMQ, and Docker.

> **Note on backend:** The platform originally shipped as a Python/FastAPI backend (archived at `backend.zip`). The active backend is the Express.js + TypeScript rewrite in `backend_js/`, which implements the core platform modules. See [Implemented Features](#implemented-features) and [Not Yet Implemented](#not-yet-implemented).

## দ্রুত চালানোর নিয়ম

ফ্রন্টেন্ড, বেকেন্ড এবং ডেমো লগইন দ্রুত চালানোর জন্য নিচের ধাপগুলো অনুসরণ করুন।

### অপশন 1: Docker দিয়ে রান করা

সবচেয়ে সহজ উপায়:

```bash
cp backend_js/.env.example backend_js/.env
cp frontend/.env.example frontend/.env
docker compose up --build -d
docker compose exec backend npx prisma db push
```

তারপর ব্রাউজারে খুলুন:

- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:8000`
- Health check: `http://localhost:8000/api/v1/health`

### অপশন 2: লোকাল মেশিনে আলাদা করে রান করা

এই অপশনে `MySQL` এবং `Redis` আগে থেকে চালু থাকতে হবে।

Backend:

```bash
cd backend_js
npm install
npx prisma generate
npx prisma db push
npm run dev
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

### লোকাল কনফিগ নোট

- `frontend/.env` এ `VITE_API_BASE_URL=http://localhost:8000/api/v1`
- `backend_js/.env` এ `DATABASE_URL=mysql://app:app@127.0.0.1:3306/automation`
- `backend_js/.env` এ `REDIS_URL=redis://127.0.0.1:6379/0`
- Owner ইউজার (নিচের ডেমো লগইন) প্রথম login-এ `owner_email` / `owner_password` সেটিংস থেকে স্বয়ংক্রিয়ভাবে তৈরি হয়ে যায় — আলাদা seed script দরকার নেই।

### ডেমো লগইন

- Email: `admin@khubsoja.com`
- Password: `12331233`

`backend_js/.env` এ `OWNER_EMAIL` / `OWNER_PASSWORD` বদলে কাস্টম owner credential সেট করা যায়।

## Architecture

### Backend (`backend_js/`)

Express 4 + TypeScript API with Prisma ORM (MySQL), BullMQ + Redis queues, JWT auth, and Zod validation.

- `src/api/v1/endpoints`: versioned route handlers (auth, users, accounts, platform-connections, webhooks, inbox, comments, posts, AI, billing, automation, observability, reports, health)
- `src/config/settings.ts`: Zod-validated environment settings with production guardrails
- `src/core`: Prisma client, error envelope + centralized error handler, Winston logging
- `src/core/security.ts`: JWT access/refresh tokens, bcryptjs password hashing
- `src/middlewares/auth.ts`: JWT auth middleware (`requireUser`)
- `src/services/platform_connection_service.ts`: platform connection lifecycle
- `src/services/llm_service.ts`: LLM completion service (provider chain: OpenAI → Groq → Gemini → internal deterministic fallback; FAQ matching, style-example retrieval, product-catalog RAG, customer-intent classification, token/cost accounting, Gemini 429 retry)
- `src/integrations/facebook`: Graph API client (OAuth, messaging, comments, posts, typing indicators, webhook subscription), OAuth session storage, connection service
- `src/integrations/whatsapp`: Cloud API client + connection service
- `src/workers/queues.ts`: BullMQ queue definitions (webhooks, sync, messages, comments, posts, maintenance, default)
- `src/workers/processor.ts` + `src/workers/start.ts`: **webhook event processor worker** — consumes webhook events, persists conversations/messages/comments, debounced auto-reply generation and Graph API sends (`npm run worker`)
- `prisma/schema.prisma`: data model (users, accounts, memberships, refresh tokens, onboarding keys, platform connections, webhook events, conversations/messages, Facebook comments/replies, social posts, AI config tables, billing/RBAC tables)

### Frontend (`frontend/`)

React 18 + TypeScript + Vite SPA with Zustand state and react-router.

- `src/pages`: auth, dashboard, setup wizard, connections, AI management, inbox, comments moderation, posts, product catalog (`/products`), team, billing, usage reports, audit logs, AI style examples (`/ai/style`)
- `src/features/*/api`: feature-oriented API client layers
- `src/shared/types`: shared typed contracts
- `src/lib/api/client.ts`: axios API client with token handling

## Implemented Features

### Auth and RBAC Foundation

- `POST /api/v1/auth/login`
- `POST /api/v1/auth/register`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `POST /api/v1/auth/change-password`
- `GET /api/v1/auth/me`

Implemented business rules:

- JWT access tokens + server-side refresh tokens with rotation and revocation (single token or all devices)
- Password hashing with bcryptjs
- Onboarding-key registration with validation for revoked, expired, exhausted, and email-bound keys
- Hierarchical user roles: `owner` → `superAdmin` → `admin` (admin feature permissions inherit from the managing superAdmin)
- Owner user auto-bootstrapped from settings on first login
- Active account resolution through `X-Account-ID` header + membership check

### User and Team Management

- `GET /api/v1/users`
- `POST /api/v1/users/super-admins`
- `PATCH /api/v1/users/super-admins/:userId`
- `POST /api/v1/users/admins`
- `PATCH /api/v1/users/admins/:userId`
- `DELETE /api/v1/users/admins/:userId`
- `POST /api/v1/users/:userId/reset-password`
- `GET /api/v1/accounts/current/members`
- `PATCH /api/v1/accounts/current`

Implemented business rules:

- Owner can create/manage super admins; super admins create/manage admins within their workspace
- Super admin creation provisions a new account, owner membership, and token wallet in one transaction
- Disabling a super admin cascades to managed admins and revokes all sessions
- Password reset revokes the target user's sessions

### Platform Connections

- `GET /api/v1/platform-connections`
- `POST /api/v1/platform-connections`
- `POST /api/v1/platform-connections/facebook/oauth/start`
- `POST /api/v1/platform-connections/facebook/oauth/complete`
- `POST /api/v1/platform-connections/facebook/oauth/connect`
- `POST /api/v1/platform-connections/facebook/manual-connect`
- `POST /api/v1/platform-connections/whatsapp/manual-connect`
- `GET /api/v1/platform-connections/:id`
- `PUT /api/v1/platform-connections/:id`
- `PATCH /api/v1/platform-connections/:id/status`
- `POST /api/v1/platform-connections/:id/facebook/sync`
- `POST /api/v1/platform-connections/:id/whatsapp/sync`
- `POST /api/v1/platform-connections/:id/facebook/subscribe-webhooks`
- `POST /api/v1/platform-connections/:id/disconnect`
- `DELETE /api/v1/platform-connections/:id`

Implemented business rules:

- Account-scoped connections for `facebook_page` and `whatsapp`
- **Facebook**: full OAuth flow (start → complete → connect Page), manual Page-token connect, Page sync (profile refresh), and webhook subscription via the Graph API
- **WhatsApp**: manual connect with `phone_number_id` + Cloud API token, and profile sync
- Encrypted token storage via `src/utils/crypto.ts` (swap for KMS/secrets service in production)
- Webhook URL/secret/verify-token config and activation state
- Status tracking: `pending`, `connected`, `action_required`, `disconnected`, `error`

### Webhook Ingestion (Facebook + WhatsApp)

- `GET /api/v1/webhooks/facebook-page`
- `POST /api/v1/webhooks/facebook-page`
- `GET /api/v1/webhooks/whatsapp`
- `POST /api/v1/webhooks/whatsapp`

Implemented business rules:

- GET challenge verification against account-scoped verify tokens
- POST payloads validated with `X-Hub-Signature-256` HMAC (timing-safe) when the app secret is configured
- Events stored durably in `webhook_events` and acknowledged with `202 Accepted`
- Deduplication via a SHA-256 event key (source + connection + signature + payload)
- Inbound events are enqueued to the BullMQ `webhooks` queue for processing
- Event classification: `inbound_message`, `inbound_comment`, generic events
- **Processing**: the worker (`npm run worker`) consumes events — persists conversations/messages/comments, then auto-replies (see [AI Auto-Reply Worker](#ai-auto-reply-worker))
- Page webhook subscription uses valid `subscribed_fields` (`messages`, `conversations`, `feed`, `mention`, `message_deliveries`, `message_reads`, `message_echoes`, `messaging_postbacks`, `messaging_optins`); sync reports the subscription state correctly (app ID + subscribed fields, not a non-existent `active` field)

### Inbox and Conversation Management

- `GET /api/v1/inbox/facebook/live/conversations`
- `GET /api/v1/inbox/facebook/live/conversations/:conversationId/messages`
- `POST /api/v1/inbox/facebook/live/reply`
- `PATCH /api/v1/inbox/facebook/live/conversations/:conversationId/ai-chat`
- `GET /api/v1/inbox/conversations`
- `GET /api/v1/inbox/conversations/:id`
- `GET /api/v1/inbox/conversations/:id/messages`
- `POST /api/v1/inbox/conversations/:id/reply`
- `PATCH /api/v1/inbox/conversations/:conversationId/ai-chat`

Implemented business rules:

- **Live Facebook inbox**: reads real Messenger conversations/messages from the Graph API and sends live replies
- **Local inbox**: account-scoped conversations with status/search filters and pagination
- Per-conversation AI-chat mode: `auto` / `manual` (with `manual_minutes` pause) / `off`, stored in conversation metadata
- A manual reply auto-pauses AI for 15 minutes so the bot does not interfere mid-conversation
- Outbound replies recorded with sender type (`human_admin` / `llm_bot`)

### Facebook Comment Moderation

- `GET /api/v1/comments`
- `GET /api/v1/comments/posts`
- `GET /api/v1/comments/posts/:postExternalId`
- `GET /api/v1/comments/:id`
- `PATCH /api/v1/comments/:id/status`
- `POST /api/v1/comments/:id/replies`

Implemented business rules:

- Account-scoped comment records with status, assignment, moderation notes, and flags
- Comment lifecycle: `pending`, `replied`, `ignored`, `flagged`, `need_review`
- Post-level grouping for the moderation queue
- Reply creation with `send_now` — publishes real replies to the Graph API when enabled, storing reply status (`draft` / `sent` / `failed`) and error messages

### Facebook Post Automation

- `GET /api/v1/posts`
- `POST /api/v1/posts`
- `GET /api/v1/posts/:id`
- `PUT /api/v1/posts/:id`
- `DELETE /api/v1/posts/:id`
- `POST /api/v1/posts/:id/publish-now`
- `PATCH /api/v1/posts/:id/ai-auto-reply`

Implemented business rules:

- Account-scoped posts with status flow: `draft` → `approved` → `scheduled` → `published` / `failed` / `rejected`
- Scheduling timestamps, media URLs, and AI agent/prompt linkage fields
- **Publish-now** posts real feed content to the Page via the Graph API and updates status/error state
- Per-post AI auto-reply toggle

### Product Catalog

- `POST /api/v1/products/upload-image`
- `GET /api/v1/products`
- `POST /api/v1/products`
- `PUT /api/v1/products/:productId`
- `DELETE /api/v1/products/:productId`
- `PATCH /api/v1/products/:productId/availability`

Implemented business rules:

- Products belong to a connected Facebook Page (`platform_connection_id`), so each page has its own catalog
- **Multiple images per product**: upload files via `POST /upload-image` (JPEG/PNG/WEBP/GIF, ≤ 5 MB, stored under `backend_js/uploads/products/` and served at `/uploads`) or paste any image URL — both feed the `images[]` array
- Price stored as `Decimal` (serialized as a string in responses) with an optional `currency` code and a free-form `price_text` override; availability toggle (`is_available`) for in-stock / out-of-stock
- At AI reply time the top-3 products matching the customer message are injected into the generation context (keyword-overlap RAG, same mechanism as FAQ and style examples) with a "never invent prices or products" instruction; retrieval is skipped when the customer intent is `not_permitted`

### Health

- `GET /api/v1/health` — API + database status (`200 ok` / `500 degraded`)

### AI Configuration and Generation

- `GET /api/v1/ai/agents`
- `GET /api/v1/ai/agents/:agentId`
- `POST /api/v1/ai/agents`
- `PUT /api/v1/ai/agents/:agentId`
- `GET /api/v1/ai/prompts`
- `POST /api/v1/ai/prompts`
- `GET /api/v1/ai/prompts/resolve/current`
- `PUT /api/v1/ai/prompts/:promptId`
- `GET /api/v1/ai/knowledge-sources` (supports `?kind=conversation_style`)
- `POST /api/v1/ai/knowledge-sources`
- `PUT /api/v1/ai/knowledge-sources/:sourceId`
- `DELETE /api/v1/ai/knowledge-sources/:sourceId`
- `POST /api/v1/ai/knowledge-sources/from-conversations`
- `GET /api/v1/ai/faq`
- `POST /api/v1/ai/faq`
- `PUT /api/v1/ai/faq/:faqId`
- `POST /api/v1/ai/generation/inbox-reply`
- `POST /api/v1/ai/generation/evaluate-intent`
- `POST /api/v1/ai/generation/comment-reply`
- `POST /api/v1/ai/generation/post`

Implemented business rules:

- Account-scoped AI agents, prompts (typed: `system_instruction` / `inbox_reply` / `comment_reply` / `post_generation` / `intent_policy`), knowledge sources, and FAQ entries
- Prompt resolution precedence: `agent+connection` → `connection` → `agent` → account-global (per prompt type)
- **Generation endpoints** compose context (resolved prompt, conversation history / comment / title hint, FAQ knowledge base, and matching product-catalog entries) and call the LLM service; responses carry token usage, prompt scope, and draft references
- **Customer intent evaluation**: inbox-reply generation first classifies the conversation tail (last ~20 messages / ~2000 chars) as `purchase` / `casual` / `not_permitted` (`evaluateCustomerIntent` — OpenAI strict-JSON, with a deterministic Bangla/English keyword-heuristic fallback) against the owner's `INTENT_POLICY` prompt (resolved with the standard precedence; a safe default applies until configured). Replies then route by intent: `purchase` → sales steering; `casual` → concise steering; `not_permitted` at confidence ≥ 0.8 → fixed refusal template with the LLM skipped (zero token cost, cannot be talked around); below 0.8 → LLM-phrased polite decline with the policy. The evaluation is cached in `conversations.metadata_json` (`intent_eval`) and returned on the reply; `POST /api/v1/ai/generation/evaluate-intent` runs the classifier standalone without replying
- **Conversation style training**: `POST /ai/knowledge-sources/from-conversations` lets users select real inbox conversations (frontend `/ai/style` page); the backend extracts `Customer → Owner` reply pairs (a `CUSTOMER`/`INBOUND` message followed by the next `HUMAN_ADMIN`/`OUTBOUND` reply; `LLM_BOT`/`SYSTEM` excluded), max 5 pairs per conversation, and stores them as `conversation_style` knowledge rows (no schema change — reuses `ai_knowledge_sources` with `metadata_json.kind`); re-training a conversation is idempotent (updates the existing row)
- At generation time the top-3 style examples are retrieved by keyword overlap (Bengali-aware tokenizer) and injected with a "match this tone of voice" instruction — RAG retrieval, so token cost stays flat regardless of trained-conversation count (style imitation, not fine-tuning)
- Generation can persist drafts and, when `send_now` is set, publish real replies to Messenger / comment threads via the Graph API (recording `SENT` / `FAILED` states)
- **LLM provider chain** — `src/services/llm_service.ts` resolves providers in order: `openai` (`OPENAI_API_KEY`) → `groq` (`GROQ_API_KEY`, default model `llama-3.3-70b-versatile`) → `gemini` (`GEMINI_API_KEY`, default model `gemini-2.5-flash`, with retry-on-429 for free-tier quota) → deterministic internal fallback (`internal-reply-model-v1`). Select with `LLM_DEFAULT_PROVIDER` + `LLM_DEFAULT_MODEL`. Every completion is logged to `llm_token_usage` and `action_usage_logs`, and provider failures are logged (never silent)

### AI Auto-Reply Worker

The background worker (`backend_js/src/workers/processor.ts`, run with `npm run worker`) turns ingested webhook events into automated replies:

- **Consumes** the `webhooks` queue (`process_webhook_event`): persists the customer message, upserts the conversation, then schedules a debounced reply job on the `messages` queue
- **Debounced burst handling** — consecutive customer messages wait **6 seconds** (AUTO_REPLY_DEBOUNCE_MS) after the last message; stale jobs (a newer inbound message exists) are skipped, so a burst gets **one unified reply** built from the full conversation history
- **Regeneration** — if a new customer message arrives while the LLM is generating, the reply is regenerated with the new text included, within a **4-second window** (AUTO_REPLY_REGENERATE_WINDOW_MS, max 3 regenerations), so the reply always covers the latest input
- **Typing indicator** — sends `sender_action: typing_on` while generating and `typing_off` after send (best-effort, failures ignored)
- **Reply flow** — intent classification (purchase/casual/not_permitted) routes the reply; refusal template is used for `not_permitted` at confidence ≥ 0.8; replies are persisted as `LLM_BOT` messages with `SENT`/`FAILED` delivery states and real Graph API message IDs
- **Concurrency safety** — per-conversation Redis lock prevents simultaneous generations; stale-job checks and pre-send re-checks guarantee exactly one reply per burst
- **Echo filtering** — `is_echo` events and page-as-sender payloads are ignored (the bot never replies to its own messages)
- **AI chat modes** — `auto` (default, worker replies), `manual` (paused, replies to the frontend pause button only), `off` (never auto-replies); **no automatic 15-minute pause after sends** — the pause is controlled exclusively from the frontend
- **Comment auto-reply** — inbound comments are stored and auto-replied (with `send_now`-style Graph API publish) when the post has `ai_auto_reply_enabled`

### Billing

- `GET /api/v1/billing/plans`
- `GET /api/v1/billing/features`
- `GET /api/v1/billing/subscription`
- `POST /api/v1/billing/subscription`
- `PUT /api/v1/billing/subscription`
- `GET /api/v1/billing/wallet`
- `GET /api/v1/billing/transactions`
- `GET /api/v1/billing/token-ledger`
- `GET /api/v1/billing/token-packages`
- `POST /api/v1/billing/token-packages`
- `POST /api/v1/billing/token-purchases`

Implemented business rules:

- Account-scoped plans, feature catalog, and subscription management (subscription tracks plan code + status, snapshots plan features)
- Token wallet balance, ledger entries, transactions, and purchasable token packages
- Token-package purchase credits the account wallet and records a billing transaction

### Automation Workflows

- `GET /api/v1/automation/workflows`
- `POST /api/v1/automation/workflows`
- `PUT /api/v1/automation/workflows/:workflowId`
- `DELETE /api/v1/automation/workflows/:workflowId`
- `POST /api/v1/automation/workflows/:workflowId/run`

Implemented business rules:

- Account-scoped workflows with trigger/action config, schedule, and status lifecycle
- Manual run creates a `sync_job` (`AUTOMATION_RULE_EXECUTION`, `PENDING`) and returns `{ workflow, sync_job_id }`; `scheduled_daily` triggers recompute `next_run_at` to the next occurrence

### Observability and Reports

- `GET /api/v1/observability/action-usage-logs`
- `GET /api/v1/observability/llm-token-usage`
- `GET /api/v1/observability/audit-logs`
- `GET /api/v1/reports/dashboard-summary`
- `GET /api/v1/reports/token-usage-summary`
- `GET /api/v1/reports/billing-summary`
- `GET /api/v1/reports/conversation-stats`
- `GET /api/v1/reports/comment-stats`
- `GET /api/v1/reports/post-stats`

Implemented business rules:

- Paginated observability logs (`{ items, total, page, page_size }`) with lowercased enum fields
- Report summaries aggregate LLM token usage, action costs, wallet/subscription state, and conversation/comment/post stats with zero-filled 7/14-day daily buckets

## Not Yet Implemented

- **WhatsApp auto-reply worker** — WhatsApp webhook events are ingested and stored, but the worker only persists them; message/comment auto-reply for WhatsApp is not wired to the Cloud API send path yet
- **Scheduled publishing & automation workflows** — `sync` / `posts` / `maintenance` queues are defined but only the `webhooks` and `messages` queues are consumed; scheduled post publishing and workflow runs are stored but not executed
- **Delivery-status reconciliation** — outbound sends record `SENT`/`FAILED` but are not reconciled against provider delivery callbacks

## Database and Queue Notes

- Prisma schema at `backend_js/prisma/schema.prisma` targets MySQL
- Schema sync: `npx prisma db push` (no migration history committed yet)
- BullMQ uses Redis as the queue broker (7 queues defined, 3 attempts, exponential backoff)
- **Consumed queues**: `webhooks` (event ingestion) and `messages` (debounced auto-reply) — run `npm run worker` in `backend_js/`
- Multi-tenant through `accounts` + `memberships`, with `X-Account-ID` request context
- Schema includes tables for AI config, billing/subscriptions, token wallets/ledger, RBAC (`roles`/`permissions`), and observability — used by the AI, billing, automation, observability, and reports routes

## Facebook Page Integration Setup

### Required backend settings (`backend_js/.env`)

- `FACEBOOK_APP_ID`
- `FACEBOOK_APP_SECRET`
- `FACEBOOK_OAUTH_REDIRECT_URI` (default `http://localhost:5173/connections/facebook/callback`)

Optional:

- `FACEBOOK_GRAPH_API_VERSION` (default `v23.0`)
- `FACEBOOK_GRAPH_API_BASE_URL` (default `https://graph.facebook.com`)

LLM provider (for AI auto-reply):

- `GROQ_API_KEY` (recommended) or `GEMINI_API_KEY` / `OPENAI_API_KEY`
- `LLM_DEFAULT_PROVIDER=groq|gemini|openai|internal`
- `LLM_DEFAULT_MODEL` (defaults per provider: `llama-3.3-70b-versatile`, `gemini-2.5-flash`, `gpt-4o-mini`)

Frontend flag:

- `VITE_FACEBOOK_OAUTH_ENABLED=true`

### Meta app setup

1. Add the Facebook Login product to your Meta app.
2. Add the redirect URI from `FACEBOOK_OAUTH_REDIRECT_URI`.
3. Configure the Page webhook callback URL as `http://localhost:8000/api/v1/webhooks/facebook-page` for local development (public tunnel required for Meta to reach it — e.g. ngrok).
4. Use the connection verify token when setting up the webhook challenge.
5. Subscribe the app to the Page fields needed for Messenger and comment/feed automation (`messages`, `conversations`, `feed`, `mention`, `message_deliveries`, `message_reads`, `message_echoes`, `messaging_postbacks`, `messaging_optins`).

### Requested Facebook permissions

- `pages_show_list`
- `pages_manage_metadata`
- `pages_messaging`
- `pages_read_engagement`
- `pages_manage_posts`
- `pages_manage_engagement`

### Current provider-backed capabilities

- Connect Facebook Pages through OAuth or manual Page-token flow
- Verify and ingest Messenger + comment/feed webhook events — processed by the worker (auto-reply, comment moderation records)
- Read live Messenger conversations and send replies (with typing indicators)
- **Automated inbox replies** — worker generates one debounced, context-aware reply per message burst via the configured LLM provider
- **Automated comment replies** — for posts with AI auto-reply enabled
- Reply to comments manually and publish Page feed posts

## WhatsApp Integration Setup

### Required backend settings (`backend_js/.env`)

- `WHATSAPP_GRAPH_API_BASE_URL` (default `https://graph.facebook.com`)
- `WHATSAPP_GRAPH_API_VERSION` (default `v23.0`)
- `WHATSAPP_VERIFY_SIGNATURE` (default `true`)
- `FACEBOOK_APP_SECRET` (used for Meta webhook signature validation)

### Meta app setup

1. Add WhatsApp to your Meta app and create a Cloud API access token.
2. Capture the `phone_number_id` and optional `business_account_id`.
3. In platform connections, use WhatsApp manual connect.
4. Configure the webhook callback URL as `http://localhost:8000/api/v1/webhooks/whatsapp`.
5. Use the connection verify token for Meta webhook challenge verification.

### Current provider-backed capabilities

- Connect WhatsApp phone numbers with account-scoped credentials
- Verify and ingest WhatsApp webhook events (stored; processing queue needs a worker — WhatsApp auto-reply not yet wired)
- Sync connection metadata and expose troubleshooting-friendly connection summary
- Cloud API client supports profile lookup and text-message sending (not yet exposed via inbox routes)

## Local Setup (Without Docker)

### 1. Create environment files

```bash
cp backend_js/.env.example backend_js/.env
cp frontend/.env.example frontend/.env
```

### 2. Run with Docker Compose

```bash
docker compose up --build
```

Services:

- Backend API: `http://localhost:8000`
- Frontend: `http://localhost:5173`
- MySQL: `localhost:3306` (db `automation`, user `app` / password `app`)
- Redis: `localhost:6379`

The worker service in `docker-compose.yml` is commented out — uncomment it (or run `cd backend_js && npm run worker` locally) to enable automated replies. Without the worker, webhook events are still ingested and stored but never processed.

### 3. Sync the database schema

```bash
docker compose exec backend npx prisma db push
```

Or locally: `cd backend_js && npx prisma db push`

### 4. Health check

```bash
curl http://localhost:8000/api/v1/health
```

### 5. Try the auth flow

1. Open the frontend at `http://localhost:5173` and sign in with `admin@khubsoja.com / 12331233` (owner auto-created on first login).
2. Open the Users page and create a `superAdmin` (this also creates a new account workspace).
3. Sign in as that superAdmin and create one or more `admin` users.

### 6. Try the connection setup flow

1. Open `http://localhost:5173/connections` to add a Facebook Page or WhatsApp connection.
2. For Facebook, either start OAuth or manually connect with a Page token.
3. Use the `Sync` and `Subscribe` actions to refresh Page state and subscribe the Page to app webhooks.
4. Use disconnect/edit actions to confirm account-scoped channel management.

### 7. Try the inbox flow

1. `http://localhost:5173/inbox` — review threads for the active account (Facebook Live inbox requires a connected Facebook Page).
2. Filter by status, view messages, set the AI-chat mode, and send replies.
3. **Auto-reply**: with the worker running and the conversation in `auto` mode, message the page from Messenger — the bot answers one debounced, context-aware reply per burst (~6s after the last message). Use the frontend pause button to stop auto-replies (manual mode) or set `off` to disable per conversation.

### 8. Try the comments moderation flow

1. `http://localhost:5173/comments` — review the moderation queue (requires comment records, e.g. ingested via Facebook webhooks).
2. Filter by status, change comment status, and send replies (`send_now` publishes to Facebook).

### 9. Try the post automation flow

1. `http://localhost:5173/posts` — create posts with status flow.
2. Use `publish-now` to publish immediately to the connected Page.

## Running Without Docker

Backend:

```bash
cd backend_js
npm install
npx prisma generate
npx prisma db push
npm run dev        # tsx watch
npm run worker     # separate process: webhook ingestion + debounced AI auto-reply
```

Production-style run:

```bash
npm run build      # tsc
npm start          # node dist/server.js
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Useful commands:

```bash
make backend-run   # cd backend_js && npm run dev
make frontend-build
make migrate       # npx prisma db push
make docker-up
make docker-down
```

## Verification

- Backend typecheck: `cd backend_js && npx tsc --noEmit`
- Backend build: `cd backend_js && npm run build`
- Frontend checks: `cd frontend && npm run check` (typecheck + build)

## Deployment Notes

- The backend Dockerfile provides `development` and `production` targets (Node 20, Prisma compatible)
- The frontend Dockerfile provides a Vite development target and an Nginx-based production target
- Set `ENVIRONMENT=production`, `DEBUG=false`, a strong `SECRET_KEY` (≥ 32 chars), and custom `OWNER_PASSWORD` before production
- Production settings validation rejects: debug enabled, placeholder `SECRET_KEY`, wildcard `ALLOWED_HOSTS`/`CORS_ORIGINS`, and the default owner password
- `DATABASE_URL` and `REDIS_URL` can override composed connection settings for hosted environments
- Rate limiting is not enforced yet, but settings and CORS/response structure are in place
- Secrets to rotate before production: `SECRET_KEY`, `MYSQL_PASSWORD`, `FACEBOOK_APP_SECRET`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`

## Next Milestones

- Wire WhatsApp auto-reply into the worker (Cloud API send path)
- Consume `sync` / `posts` / `maintenance` queues for scheduled publishing, automation workflow runs, and delivery retries
- Real provider-backed LLM pricing and token reconciliation
- Delivery status reconciliation and retry policies for Facebook/WhatsApp outbound sends
- Media attachment support for Messenger and Page publishing
- Richer report filters and export support
- Multi-step workflow templates and richer branching conditions

## External Dependency TODOs

- LLM providers require real API keys in `.env` (`GROQ_API_KEY` / `GEMINI_API_KEY` / `OPENAI_API_KEY`) and the `LLM_DEFAULT_PROVIDER` choice; without them the deterministic internal fallback replies
- Production secret/key management should replace the local token encryption helper
- Live Meta app configuration and approved permissions are required for real production Facebook/WhatsApp traffic
