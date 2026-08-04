# Backend Features Analysis

> Repo: `chatbotkhubsoja`
> Analyzed: `backend_js/` (live backend)
> Date: 2026-08-04
> Updated: 2026-08-04 — added AI, billing, automation, observability, and reports modules (commit `d7e66fa`); added conversation style training (`POST /knowledge-sources/from-conversations` + `findStyleExamples` RAG retrieval); added customer intent evaluation (`INTENT_POLICY` prompt type + `evaluateCustomerIntent`)

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

### AI Configuration (`/ai`)
- Agents: `GET/POST /agents`, `GET/PUT /agents/:agentId` (status: draft / active / paused / archived)
- Prompts: `GET/POST /prompts`, `PUT /prompts/:promptId` — typed (`system_instruction` / `inbox_reply` / `comment_reply` / `post_generation` / `intent_policy`), version bumped on content change
- Prompt resolution: `GET /prompts/resolve/current` resolves the active prompt per type with precedence `agent+connection` → `connection` → `agent` → account-global
- Knowledge sources: `GET/POST /knowledge-sources`, `PUT /knowledge-sources/:sourceId`, `DELETE /knowledge-sources/:sourceId`; `GET` accepts `?kind=conversation_style`
- **Conversation style training**: `POST /knowledge-sources/from-conversations` — the user selects real inbox conversations; the backend extracts `Customer → Owner` reply pairs (a `CUSTOMER`/`INBOUND` message followed by the next `HUMAN_ADMIN`/`OUTBOUND` reply; `LLM_BOT`/`SYSTEM` replies never qualify), max 5 pairs per conversation, ~300 chars per message, stored as a `conversation_style` knowledge row (reuses `ai_knowledge_sources` with `source_type=TEXT` + `metadata_json.kind` — no schema change); re-running a conversation idempotently re-trains (UPDATE) instead of duplicating
- FAQ: `GET/POST /faq`, `PUT /faq/:faqId` (tags, `is_active`)
- Account-scoped; enum-ish fields lowercased in responses to match the frontend contract

### AI Generation (`/ai/generation`)
- `POST /inbox-reply` — composes resolved prompt + conversation history + FAQ knowledge, calls the LLM service; optional `send_now` publishes a real Messenger reply via Graph API (records `SENT`/`FAILED`, auto-pauses AI chat 15 min), optional `persist_draft` stores an `LLM_BOT` outbound draft; **routes by customer intent** — `purchase` (sales steering), `casual` (concise steering), `not_permitted` at confidence ≥ 0.8 returns a fixed refusal template with the LLM skipped (zero token cost, `routed_by: 'intent_policy'`), below 0.8 an LLM-phrased polite decline with the policy; the response carries `intent_eval: { intent, confidence, reason }` and the evaluation is cached in `conversations.metadata_json`
- `POST /evaluate-intent` — standalone classifier: scores the last-20-message tail (~2000 chars) against the resolved `INTENT_POLICY`, returns `{ intent, confidence, reason, evaluated_at, tail_used }` and caches `intent_eval` on the conversation (no reply generated)
- `POST /comment-reply` — same pattern for comments; `send_now` publishes via Graph API, updates comment to `replied`, stores `facebook_comment_replies` row; `persist_draft` writes `ai_draft_reply` on the comment
- `POST /post` — generates post content (`POST_GENERATION`); `persist_draft` creates/updates a `social_posts` draft (`is_llm_generated`, `requires_approval`)
- Every completion logs to `llm_token_usage` and `action_usage_logs` (tokens + estimated cost)
- Backed by `src/services/llm_service.ts`: OpenAI provider when `LLM_DEFAULT_PROVIDER=openai` + `OPENAI_API_KEY` set, otherwise a deterministic internal fallback (`internal-reply-model-v1`) with FAQ keyword matching; cost estimate recorded per call
- Generation context also injects **top-3 style examples** (`findStyleExamples`, keyword-overlap scoring with the Bengali-aware tokenizer, mirroring FAQ matching) with a "match this tone of voice" instruction — RAG-style retrieval so token cost stays flat regardless of how many conversations were trained
- Intent classification runs before generation: `evaluateCustomerIntent` (OpenAI strict-JSON at temperature 0, validated, with a deterministic Bangla/English keyword-heuristic fallback whose confidence derives from the top-category score margin); the `INTENT_POLICY` prompt resolves with the standard precedence and a safe default policy applies until the owner configures one

### Billing (`/billing`)
- Plans: `GET /plans`, `GET /features` (feature catalog)
- Subscription: `GET/POST/PUT /subscription` (plan code + status; `PUT` switches plans)
- Wallet & ledger: `GET /wallet`, `GET /transactions`, `GET /token-ledger`
- Token packages: `GET/POST /token-packages`, `POST /token-purchases` (credits wallet, records transaction)
- Account-scoped; Decimal columns serialized as strings to match the frontend types

### Automation Workflows (`/automation`)
- `GET/POST /workflows`, `PUT/DELETE /workflows/:workflowId`
- `POST /workflows/:workflowId/run` — creates a `sync_job` (`AUTOMATION_RULE_EXECUTION`, `PENDING`) and returns `{ workflow, sync_job_id }`; `scheduled_daily` triggers recompute `next_run_at` to the next occurrence

### Observability (`/observability`)
- `GET /action-usage-logs`, `GET /llm-token-usage`, `GET /audit-logs` — paginated (`{ items, total, page, page_size }`), enum fields lowercased

### Reports (`/reports`)
- `GET /dashboard-summary` (metric cards + audit/conversation/comment/post/token aggregates)
- `GET /token-usage-summary`, `GET /billing-summary` (aggregate LLM/action costs, top actions, usage by model)
- `GET /conversation-stats`, `GET /comment-stats`, `GET /post-stats` (status counts + zero-filled 7/14-day daily buckets)

### Health (`/health`)
- API + database status (`200` ok / `500` degraded)

## Infrastructure

- BullMQ queues defined for `default`, `webhooks`, `sync`, `maintenance`, `messages`, `comments`, `posts` (3 attempts, exponential backoff)
- Request-ID + process-time logging middleware
- Centralized error handler with a standardized error envelope
- Express app: Helmet (CSP in production), CORS, gzip compression, 10 MB JSON body limit with raw-body capture (for webhook signature verification)

## Gaps vs. README / Python Version (not implemented in `backend_js`)

- **No worker process** — only BullMQ queue definitions exist; nothing consumes them, so queued webhook events and automation `sync_jobs` are stored but never processed (no AI reply generation in background, no scheduled publishing, no delivery retries). AI generation currently runs synchronously inside the `/ai/generation/*` request handlers.

> Note: the AI, billing, automation, observability, and reports routes were added on 2026-08-04 (commit `d7e66fa`) — the frontend API layers (`aiApi`, `billingApi`, `automationApi`, `observabilityApi`, `reportApi`) now map 1:1 onto mounted backend routes. Conversation style training was added the same day (`POST /ai/knowledge-sources/from-conversations`, `findStyleExamples` retrieval, frontend `/ai/style` page), followed by customer intent evaluation (`INTENT_POLICY` prompt type, `evaluateCustomerIntent`, `/ai/generation/evaluate-intent`).
