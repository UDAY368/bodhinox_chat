# WACRM source review for Bodhinox Chat

Date: 14 October 2026 (Asia/Kolkata).

Historical assessment at import time. Installation and migration work has since proceeded; see [current functionality and acceptance](bodhinox-functionality.md), validation ledgers and the deployment runbook for current status. This document preserves the upstream inventory and original assessment.

## Provenance and review scope

- Upstream: [ArnasDon/wacrm](https://github.com/ArnasDon/wacrm).
- Reference checkout: `.reference/wacrm`, upstream `main` at `27c6bdf43633d1746410168431a8b0e22b4f2ba6`.
- Upstream package version: `0.8.0`.
- License: MIT, copyright 2026 Arnas Donauskas. Preserve the license and attribution in the derived application.
- All 527 tracked files were inventoried and hashed. 523 recognized text files were structurally scanned. The `src` tree contains 412 TypeScript/TSX files, including tests, totaling approximately 84,282 lines.
- Inventory: 23 page files, 56 route handlers, 96 test files, 46 SQL migrations, 36 application tables introduced by migrations, and 28 distinct SQL function names. These counts exclude Supabase's own auth/storage system tables.
- 182 source files mention Supabase, including test mocks. This count measures references, not 182 independently sized rewrite tasks.
- Manual review focused on manifests, documentation, authentication/context/roles, route boundaries, source types, storage and realtime hooks, database migrations, WhatsApp ingress, broadcast dispatch, automation/flow engines, AI integration, public API/MCP, and build/deployment/CI configuration.
- This is an architecture and feature assessment with a complete structural inventory. It is not an exhaustive line-by-line security audit or proof that the application works. No tests, dependency audit, builds, live-provider calls, or database migration executions have been run.

Reproduce the inventory with `./docs/architecture/collect-wacrm-inventory.ps1` from the workspace. Results are in [wacrm-inventory](wacrm-inventory/summary.json): [files](wacrm-inventory/files.csv), [routes](wacrm-inventory/routes.csv), [tables](wacrm-inventory/tables.csv), [SQL functions](wacrm-inventory/sql-functions.csv), and [Supabase dependencies](wacrm-inventory/supabase-dependencies.csv).

## Existing technology

| Area | Upstream implementation |
|---|---|
| Application | Next.js `16.3.8`, App Router and Route Handlers, standalone build |
| UI | React/React DOM `19.2.4`, TypeScript `^6`, Tailwind CSS v4 |
| Components | shadcn/Base UI, Lucide, Sonner; Recharts for charts |
| Editors | XYFlow/React Flow and Dagre for visual flows; dnd-kit for pipelines |
| Localization | next-intl; English, Korean, Portuguese, Spanish catalogues |
| Database and identity | Supabase PostgreSQL, Supabase Auth, PostgREST client queries, SQL RPCs and RLS |
| Storage/live updates | Supabase Storage and Realtime |
| WhatsApp | Official Meta Cloud API; this is not a QR-linked WasenderAPI integration |
| Testing | Vitest, ESLint, TypeScript checks, Prettier, GitHub CI |
| Distribution | Dockerfile, Compose, Next standalone; separate Node MCP package |
| Runtime | Manifest requires Node >=20; local host currently has Node `24.20.0`, npm `12.0.2`; manifest package manager is npm `10.9.9` |

Versions above are the downloaded manifest declarations, not proof of registry availability or security. Installation must verify the lockfile, engines, registry versions, and advisories. The repository's [AGENTS.md](../../.reference/wacrm/AGENTS.md) requires consulting the installed Next.js guides before changing application code.

## Functionality present in source

"Present" means code and/or schema exist. All runtime and production acceptance checks remain pending.

| Module | Existing functionality | Primary source |
|---|---|---|
| Login and profile | Email/password signup/login, auth callback, password reset/change, email change, avatar, global sign-out | `src/app/(auth)`, `src/app/auth/callback`, `src/hooks/use-auth.tsx`, `src/components/settings` |
| Shared accounts | Account rename, invitation links, members, owner/admin/agent/viewer roles, removal and ownership transfer | `src/lib/auth`, `src/app/api/account`, migrations 017-020 |
| Shared inbox | Conversation list/search/filtering, open/pending/closed status, assignment, contact sidebar, unread counts, realtime messages | `src/app/(dashboard)/inbox`, `src/components/inbox`, `src/hooks/use-realtime.ts` |
| Messaging | Text, image, video, audio/voice recordings, documents, locations, templates, interactive buttons/lists, quoted replies, reactions, delivery/read/failure status | `src/lib/whatsapp`, `src/components/inbox/message-composer.tsx`, `src/app/api/whatsapp` |
| Media | Browser recording/preview/download, file uploads, media gallery, inbound media mirroring | `src/lib/storage`, `src/lib/media`, `src/lib/whatsapp/mirror-inbound-media.ts` |
| Contacts | Contact editing, normalized phone deduplication, business-scoped WhatsApp identity, tags, custom fields/values, notes, CSV import and audience filtering | `src/app/(dashboard)/contacts`, `src/components/contacts`, `src/lib/contacts`, migrations 022/025/040 |
| Pipelines | Kanban boards, configurable pipelines/stages, deals tied to contacts/conversations, status/value/currency, pipeline analytics | `src/components/pipelines`, `src/app/(dashboard)/pipelines` |
| Broadcast campaigns | Template-based campaigns, contact/tag/custom-field audiences, recipient variables, media headers, recipient outcomes, aggregate counts, retry/resume helpers | `src/hooks/use-broadcast-sending.ts`, `src/lib/whatsapp/broadcast-core.ts`, `src/app/api/whatsapp/broadcast`, migrations 003/005/037/038 |
| Template manager | Meta template submission/edit/delete/sync, approval status, category/language/components, media-header upload handling | `src/components/settings/template-manager.tsx`, `src/app/api/whatsapp/templates`, `src/lib/whatsapp/template-*` |
| Quick replies | Saved responses and supported interactive content | `src/components/settings/quick-replies-manager.tsx`, `src/app/api/quick-replies` |
| Rule automations | Builder, activation validation, duplicate/edit, execution logs; inbound/first-message/keyword/new-contact/assignment/tag/interactive trigger types; conditions, waits, tags, assignment, contact update, deal creation, webhook and message actions | `src/lib/automations`, `src/components/automations`, `src/app/api/automations` |
| Reply waits | Interactive send steps can park a run awaiting the next message; reply timeout handling | migration 045, `src/lib/automations/engine.ts`, automation cron |
| Visual chatbot flows | Graph builder, templates, activation validation, execution history, buttons/lists/media, input collection, variables, conditions, tags, handoff, end/fallback/timeout behavior | `src/lib/flows`, `src/components/flows`, `src/app/api/flows` |
| AI assistance | Draft replies, optional automatic replies, reply caps and human handoff, playground, usage reporting, encrypted per-account provider keys; OpenAI, Anthropic and OpenAI-compatible adapters | `src/lib/ai`, `src/app/api/ai`, `src/components/agents` |
| AI knowledge | Documents/chunks, lexical full-text retrieval; optional 1536-dimensional vector retrieval with an embeddings key | migration 030, `src/lib/ai/knowledge.ts` |
| Dashboard | Contact/conversation/message/deal metrics, volume series, pipeline distribution, response-time calculations, activity feed | `src/lib/dashboard`, dashboard page |
| Notifications/presence | Assignment notifications, unread counters, optional browser notifications, member heartbeat/presence | `src/hooks/use-presence.ts`, `src/hooks/use-browser-notifications.ts`, migrations 024/027 |
| Public API | Scoped bearer API keys, expiry/revocation and hashing, `/api/v1/me`, contacts, conversations/messages, outbound messages, broadcasts and event-webhook management | `docs/public-api.md`, `src/lib/api-keys`, `src/lib/api/v1`, `src/app/api/v1` |
| Outbound event hooks | Subscribed event endpoints, HMAC signing, URL/SSRF checks, timeout, failure count and endpoint disablement | `src/lib/webhooks`, migration 028 |
| MCP integration | Separate TypeScript MCP server calling the public REST API; read tools enabled by default, writes explicitly enabled | `mcp-server/README.md`, `mcp-server/src/tools` |
| Settings | Account/members, WhatsApp connection, templates, AI, custom fields/tags, deals, replies, keys, profile/security, themes | `src/app/(dashboard)/settings`, `src/components/settings` |

## Source limits that matter before production

1. **Supabase is a platform dependency, not just a database driver.** Browser pages read/write through Supabase clients. Server paths use Supabase auth and service-role clients. RLS depends on `auth.uid()`, SQL functions reference `auth.users`, uploads depend on bucket policies, and UI hooks subscribe to Supabase Realtime. A Railway URL plus a Prisma schema cannot preserve these behaviors by itself.
2. **Webhook acknowledgment precedes durable storage.** `src/app/api/whatsapp/webhook/route.ts:255` runs processing inside Next `after()` and returns 200. This is better than an untracked promise but is not a persisted queue. A process crash after acknowledgment can lose unpersisted work. Existing message-id deduplication must be retained and extended to durable ingress.
3. **Broadcast dashboard orchestration is browser driven.** `src/hooks/use-broadcast-sending.ts` owns batch iteration and delays. Resume helpers exist, but the browser is not a reliable production dispatch worker. Campaign execution needs server-side jobs independent of an open tab.
4. **Rate limiting is process local.** `src/lib/rate-limit.ts` stores counters in a Map and explicitly documents the multi-instance limitation. A shared limiter is required before horizontally scaled operation.
5. **Event-hook delivery is best effort.** `src/lib/webhooks/deliver.ts` makes one timed attempt. Its header describes at-most-once delivery, while an inline comment mentions at-least-once; a durable contract and stable event IDs are needed. Failed deliveries must be visible and retryable.
6. **Delayed work depends on cron calls.** Automation cron claims due rows and flow cron sweeps abandoned flows. Their current claim status lacks an explicit lease expiry/recovery model. A crashed run must not stay running forever.
7. **Scheduled triggers are not established.** Types, validation and the builder accept `time_based` schedules; the inspected cron drains existing delayed work. The full-source search did not establish an automatic scheduler that dispatches those trigger definitions. Do not advertise recurring scheduling as operational until implemented and tested. Similarly, a broadcast scheduled timestamp in a type is not evidence of a working scheduling feature.
8. **Input validation configuration is not enforced by the flow runtime.** `src/lib/flows/types.ts` documents email/phone/regex modes as reserved; `handleReplyForActiveRun` in `engine.ts` captures nonempty trimmed text without those checks. Invalid input must reprompt without advancing for the Bodhinox journeys.
9. **Teams do not equal the future SaaS model.** Upstream profile rows have one account/role, and membership is derived from profiles. Bodhinox requires distinct memberships so a user can belong to multiple organizations, with tenant scope throughout jobs, storage and events. Subscription billing, entitlements, platform administration and an agency model are separate scope.
10. **Database features must survive the ORM migration.** Triggers, grants, partial unique indexes, generated normalized phone values, counters, notification creation, row policies, FTS and vector functions are implemented in SQL. Mapping only tables to Prisma would discard behavior and authorization.
11. **CSP is report-only.** `next.config.ts` currently permits unsafe inline/eval script sources and Supabase connect/media domains. Enforce an appropriate tested policy after migrating origins; do not silently break hydration or voice/media features.
12. **Dashboard work needs volume checks.** Some metrics aggregate retrieved rows in application code. Validate bounded queries, pagination and SQL aggregates against the documented staging dataset.
13. **Existing tests are not a production certification.** Preserve valuable domain regression coverage and replace Supabase mocks with real PostgreSQL integration tests for tenant scope, permissions, constraints, worker concurrency and restarts.

## What this repository does not deliver from the wider Bodhinox baseline

The earlier product baseline remains in [the PRD](../superpowers/specs/2026-10-13-bodhinox-chat-product-requirements.md). This import/migration establishes CRM and messaging foundations; it does not deliver all later product requirements.

- Appointment availability/capacity, practitioners, Monday-only service rules, booking/rescheduling, attendance, meeting adapters and reminders.
- Product catalogue/variants, carts, stock reservation, orders, verified payments/refunds, returns and fulfilment.
- Instagram integration, Meta lead forms/ad reporting, attribution and reconciled financial reports.
- Complete task/company/consent/opt-out domain, immutable published workflow versions and business-specific journey presets.
- SaaS billing/entitlements, platform operations, support access controls and agency/white-label capabilities.

Upstream flow graphs are the CRM's own chatbot engine; do not assume they are the separate Meta WhatsApp Flows product. There is no WasenderAPI adapter in the inspected source.

## Proposed replacement summary

| Supabase responsibility | Proposed Bodhinox replacement |
|---|---|
| PostgreSQL/PostgREST/browser queries | Railway PostgreSQL, Prisma and authenticated Next API routes/repositories |
| Auth/users/passwords/session refresh | JWT access tokens (`jose`), hashed rotating refresh tokens and revocable sessions in PostgreSQL, Argon2id passwords, organization memberships, MFA and email delivery adapter |
| Storage/public bucket URLs | Private Railway S3-compatible bucket, authorized uploads/downloads, persisted object keys and short-lived signed URLs |
| Realtime/presence | Tenant-authorized SSE events, reconnection/resync and database-backed presence heartbeats |
| SQL RPC and triggers | Prisma transactions and reviewed PostgreSQL functions/triggers/policies where needed |
| Service-role background processing | Dedicated constrained worker role, persisted jobs/outbox/receipt records, authenticated tenant resolution |
| Process-local limits | PostgreSQL-backed atomic rate limits initially; evaluate Redis only if measured throughput warrants it |

The detailed proposal and acceptance boundaries are in [the migration design](../superpowers/specs/2026-10-14-bodhinox-wacrm-foundation-design.md).

Authentication proposal revised at the user's request: JWT replaces the earlier Better Auth recommendation. Dashboard tokens use protected cookies; first-party token clients use bearer access JWTs. Public API keys remain available for existing machine/MCP integrations. Access JWTs are short-lived, refresh tokens rotate, and current session/membership checks enforce revocation and tenant permissions. This revision is documented, not implemented.

## External setup status

Railway access was inspected read-only. Seven existing projects were returned and none was named Bodhinox Chat. No existing project or database was chosen or modified; unrelated applications must not be used as a migration target. A dedicated Bodhinox project/environment is proposed, with staging verified before production.

The current workspace has pre-existing product/integration documents but no application or root Git repository. The reference checkout keeps its own upstream history. Dependencies, database credentials, email delivery, object storage and Meta assets must be configured and verified during implementation. No private credential values were requested or printed.

## Primary references researched

- [Upstream README at the inspected commit](https://github.com/ArnasDon/wacrm/blob/27c6bdf43633d1746410168431a8b0e22b4f2ba6/README.md).
- [`jose` JWT toolkit](https://github.com/panva/jose): provides signed JWT creation, signature verification and claims validation for the revised authentication proposal.
- [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html): documents cookie protection and CSRF considerations; protecting cookie confidentiality does not eliminate request-forgery risk.
- [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html): supports the Argon2id password-hashing floor in the design; random-token hashes and password hashes serve different purposes.
- [Prisma 7 custom migrations](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/customizing-migrations): custom SQL can be reviewed alongside generated migrations. Current unversioned Prisma documentation defaults to Prisma 8; use version-matched instructions.
- [Railway private storage buckets](https://docs.railway.com/storage-buckets): S3-compatible storage supports presigned access or backend proxying. Public-bucket assumptions from upstream cannot be copied unchanged.
- [Railway hybrid search with pgvector](https://docs.railway.com/guides/hybrid-search-postgres-pgvector): choose and verify an image with the required extension; a SQL `CREATE EXTENSION` statement cannot install missing extension binaries.
