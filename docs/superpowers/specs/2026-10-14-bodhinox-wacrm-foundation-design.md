# Bodhinox Chat: WACRM foundation and Railway PostgreSQL migration

Date: 14 October 2026 (Asia/Kolkata).

Status: **Approved for implementation by the user on 14 October 2026. Implementation in progress.**

## 1. Intent and authority

The user requests importing and setting up `ArnasDon/wacrm`, preserving its technology and functionality, replacing Supabase with Railway PostgreSQL and an appropriate ORM, and preparing a production-quality Bodhinox Chat foundation for subsequent WhatsApp automation and multi-tenant CRM development.

The user has explicitly clarified: **remove Supabase completely, including authentication, storage and live updates; use Prisma and replacement services.**

The user subsequently specified **JWT token authentication**. This supersedes the earlier Better Auth proposal. Use signed JWT access tokens with a PostgreSQL-backed refresh/session lifecycle and application-owned organization memberships.

The existing [Bodhinox PRD v1.0](2026-10-13-bodhinox-chat-product-requirements.md) controls product scope and defaults. The [repository review](../../architecture/2026-10-14-wacrm-repository-review.md) establishes what upstream actually contains. The earlier roadmap's suggested separate API/Redis stack is not binding for this import: the latest instruction to preserve the repository's stack controls this foundation.

This deliverable is the source import, platform replacement and production foundation for the upstream CRM features. It does not complete the PRD's booking, commerce, payment, advertising, Instagram or SaaS billing journeys. Security and tenant-safe data design start now; later SaaS product controls are separate features.

## 2. Options and decision proposed

1. **Recommended: keep Next.js/React/TypeScript and replace Supabase explicitly.** Railway PostgreSQL, Prisma, JWT authentication, private object storage, tenant-authorized live events and a TypeScript worker preserve the app's basic architecture while removing platform coupling. This requires migrating browser database operations and all server integrations, not a connection-string substitution.
2. **Self-host the Supabase platform on Railway.** Potentially reduces application rewrites but retains Supabase and its operational dependencies; it contradicts the user's complete-removal choice.
3. **Rewrite into a separate API framework immediately.** Provides an independent API deployment but adds framework changes and another broad rewrite. Defer until a concrete need justifies it; retain Route Handlers for this phase.

Proceed with option 1 after the design and implementation-plan review gates.

## 3. Technology and repository layout

Preserve upstream Next.js 16, React 19, TypeScript, Tailwind v4, component library, charts, visual editor, drag/drop utilities, next-intl and Vitest. Start from the inspected commit and verify compatible patched releases before locking dependencies. Preserve npm lockfiles for both the main application and `mcp-server`.

Use Node 24 LTS for new build/container/CI configuration, with an exact supported patch verified at installation. Retain Prisma 7 as the proposed ORM target for the version-matched schema and reviewed SQL migration workflow researched for this foundation; lock CLI/client/adapter to matching supported versions after registry and advisory checks. Authentication no longer depends on a Better Auth adapter. Do not follow unversioned Prisma 8 commands for a Prisma 7 project. A move to Prisma 8 requires a separate compatibility decision, not an implicit `latest` install.

Retain the upstream application at the workspace root so paths, tooling and App Router structure remain familiar. Preserve existing `docs/` and the reference snapshot; do not overwrite existing Bodhinox documents. Exclude `.reference` from build/typecheck/package/docker/git tracking. Preserve upstream MIT attribution and record upstream commit in an attribution document.

Proposed responsibility boundaries:

| Location | Responsibility |
|---|---|
| `src/app`, `src/components`, `src/hooks` | Existing screens/components adapted to server-owned data/auth/live-event clients |
| `src/lib/db` | Prisma lifecycle, constrained clients and tenant transactions |
| `src/lib/auth` | JWT signing/verification, refresh sessions, password/MFA lifecycle, organizations, roles and permission checks |
| `src/lib/repositories` | Explicit module queries and transactional mutations; no generic browser SQL proxy |
| `src/lib/storage` | Private object storage, media records and signed-access operations |
| `src/lib/realtime` | Tenant/user event delivery and reconnect/resync contracts |
| `src/lib/jobs`, `worker` | Persistent job queue, retries, scheduler, broadcasts, automation and webhook work |
| `src/lib/whatsapp`, `src/lib/ai` | Retained provider logic adapted to repositories and jobs |
| `prisma` | Versioned schema, migrations, reviewed SQL and safe seed/onboarding scripts |
| `tests/integration`, `tests/e2e` | Real database/provider-simulator/UI acceptance tests |
| `mcp-server` | Separate existing MCP client package preserving public API contracts |
| `docs` | Feature inventory, setup/runbooks, architecture, operator and validation evidence |

Do not copy the upstream `.git` directory into the application root. Initialize Bodhinox's own version history after import. Keep the reference checkout unchanged for provenance.

## 4. Database and ORM

Provision a dedicated Railway PostgreSQL service with pgvector support verified on the chosen image. Keep application/worker access on the private network when deployed. Local development requires a separately configured reachable URL; do not mistake a Railway internal hostname for a public address.

Build a new clean migration baseline representing the final upstream schema plus the new identity/membership/reliability records. Do not replay Supabase migrations directly on bare Railway PostgreSQL: they depend on Supabase-managed schemas, roles and functions. Keep the 46 upstream migrations as migration-reference evidence and map their final behavior into the new baseline.

Carry forward all 36 upstream application entities and relevant constraints. Retain UUIDs, timestamptz, JSONB config, decimal money values and normalized contact identities. Use Prisma field/table mapping where useful to preserve existing payloads and minimize unrelated renaming. Tenant-aware composite references prevent associating a contact, tag, stage, conversation or deal with another organization's record.

Preserve database-level behavior where it protects concurrent operations: partial uniqueness for active flow runs, unique provider message identity, normalized phone/BSUID deduplication, transactional broadcast creation and counters, claim operations and relevant notification triggers. Keep full-text generated columns/indexes and pgvector retrieval in reviewed SQL if not represented by the chosen Prisma schema/API.

Separate migration-owner credentials from normal runtime credentials. Use a non-owner, non-BYPASSRLS application role for CRM queries. Enforce and test tenant RLS with transaction-local context; no connection-level tenant setting may survive a pooled transaction. Tenant-owned tables require scope even when queried by ID. Apply FORCE RLS where appropriate and verify actual role privileges, not merely policy definitions.

Authentication tables are a separate identity boundary, accessed through a narrowly granted authentication client/role. Membership and active-organization checks resolve an authenticated identity into a permitted tenant. The auth role must not be a backdoor into arbitrary CRM tables. The worker needs narrowly granted queue enumeration and tenant resolution, then tenant-constrained transactions for domain data.

New records include identity users, auth sessions, hashed rotating refresh tokens/token families, verification/reset tokens, MFA/recovery records, organizations/memberships, media objects, durable webhook receipts, jobs/leases/attempts, dispatch intents, outbox events and audit entries. Separate membership from user profile; one identity may belong to several organizations. Refresh/verification/reset tokens are high-entropy random secrets stored only as hashes; password hashes use a separate slow password-hashing algorithm.

Development schema changes use reviewed migrations. Production applies committed migrations with `prisma migrate deploy` for the proposed Prisma 7 toolchain, through a deployment job. Never use `db push`, reset or a demo seed against production. Seed/onboarding is idempotent and creates only explicitly requested tenant defaults; no default admin password or fabricated business credentials.

## 5. Authentication, membership and authorization

Use JWT access-token authentication implemented with the maintained `jose` library and Prisma-backed identity/session records. Preserve signup/login, verified email, password reset/change, profile/avatar, sign-out and global sign-out behavior through first-party auth endpoints. Replace the Supabase callback with first-party verification/reset processing; do not leave a code-exchange endpoint that depends on Supabase. Email verification/reset require a real configured email adapter; local capture can be labeled development-only. MFA uses a maintained TOTP implementation, encrypted enrollment secrets and hashed single-use recovery codes; privileged accounts must complete MFA before production access.

### Token contract

- **Access token:** signed JWT, 15-minute lifetime, RS256 with an explicit algorithm allow-list. Claims include `sub` (user), `sid` (server session), `jti`, `iss`, `aud`, `iat`, `exp` and the authorized active `tenant_id`. Require expected issuer/audience, valid times and an active session. Use `jose` verification and claims validation rather than treating decoded JSON as authenticated identity. Signing keys stay server-side; a configured `kid` selects trusted keys from an operator-controlled keyring, never a token-supplied arbitrary URL.
- **Refresh token:** 256-bit opaque cryptographically random secret, not a long-lived JWT. Store its SHA-256 hash, session/family identity, expiry, consumed time and replacement relationship in PostgreSQL. Maximum refresh-family lifetime is seven days from login; rotation does not extend it indefinitely. Refresh is an atomic transaction that consumes exactly one valid token, records its replacement and issues a new access JWT.
- **Reuse and revocation:** reuse of a consumed refresh token revokes its family/session and produces an audited auth failure. Logout revokes the current session; global logout and password reset revoke all user sessions. Password changes, account suspension and security recovery revoke the applicable sessions. Every authenticated request checks session revocation/expiry, so an already issued JWT does not bypass logout until its own expiration.
- **Key rotation:** issue with the active signing key, accept configured retiring verification keys only during the bounded access-token overlap, then remove them. Unknown key IDs, unsigned tokens and algorithm substitutions fail closed. Include key rotation and emergency session revocation in the operator runbook.

### Browser and API transport

The dashboard uses JWT access and refresh tokens in `HttpOnly`, production `Secure`, host-only cookies with explicit `SameSite=Lax` and no `Domain`. Both cookies use `Path=/` and `__Host-` names in production; only the refresh endpoint consumes the refresh token. Local HTTP development has a clearly separate cookie configuration. Do not persist bearer credentials in localStorage/sessionStorage, put them in URLs, or return browser tokens in ordinary response JSON. Authentication responses use `Cache-Control: no-store`.

Mutating cookie-authenticated requests, including refresh and logout, require allowed Origin checks and a session-bound CSRF token. SameSite is defense in depth rather than the only CSRF control. Login/signup/verification/reset endpoints have explicit origin, validation and shared rate-limit controls, with generic credential/reset responses to prevent account enumeration. Serialize refresh operations across browser tabs to avoid accidental reuse; test concurrent refresh requests against the database constraint/transaction rather than relying on client coordination alone.

First-party non-browser REST clients may send an access JWT with `Authorization: Bearer <access-token>` through the explicit token-client flow. Return token material only to that declared client mode over HTTPS; clients must protect their refresh secret. Reject conflicting cookie and bearer identities instead of silently combining them. Protected API, server-rendered pages, media and live-event endpoints share the same verifier and authorization context.

Hash passwords with Argon2id using a maintained implementation. The initial floor is 19 MiB memory, two iterations and parallelism one, with unique salts and workload benchmarking before increasing cost. SHA-256 hashing is suitable for random refresh/reset token lookup, not for passwords. Bound password input length and apply shared abuse controls before expensive hashing.

Keep owner/admin/agent/viewer semantics during upstream migration and define them explicitly in the organization permission configuration. Do not silently inherit broader library default roles. Later granular PRD roles extend permissions through a separate change. Ownership transfer and member removal must be transactional, audited, and protect the last owner.

Every Route Handler and mutation authorizes the request server-side. UI gates are convenience only. `getCurrentAccount` becomes a compatibility facade over verified JWT + active server session + current organization membership. Tenant and role claims never replace the current database membership/permission check. Switching organizations verifies membership and issues a new tenant-bound access token; a browser-supplied tenant ID does not grant access. Revoked sessions/memberships must lose access to reads, writes, API keys as configured, private media and live streams. Long-lived SSE connections recheck authorization and terminate on access-token expiry or revocation; reconnect only after authorized refresh/resync.

Public REST API keys remain scoped, hashed, revocable and organization-bound for machine integrations and upstream MCP compatibility. They are separate from the JWT login flow: first-party app authentication uses JWT, while existing `/api/v1` API-key contracts remain supported. JWT-enabled REST paths use explicit user permission checks and must not treat an arbitrary bearer string as an API key. Preserve the existing response envelope and documented scopes. Brand-visible labels become Bodhinox Chat; changes to machine-readable prefixes/header names require a documented compatibility policy rather than accidental breakage.

## 6. Application query migration

Replace direct Supabase browser queries with explicit authenticated endpoints or appropriate server-rendered queries. Cover contacts/tags/custom fields/notes/import, inbox messages/conversations/assignment, deals/pipelines/stages, broadcasts/audiences/templates, automations/flows/logs, notifications/presence, AI knowledge/config/usage and settings.

Preserve pagination, nested related data, sorting and error shapes the UI expects. Validate request payloads with explicit schemas. Reject invalid IDs, oversized bodies, unexpected fields and tenant-crossing references. Never expose a generic endpoint that accepts arbitrary table names, predicates, operations or SQL from the browser.

Replace all `.rpc()` behavior with transaction-backed services or deliberately retained PostgreSQL functions. Remove runtime imports, variables and dependencies for `@supabase/*`. Archived reference files may contain Supabase text; active source/configuration must not require its endpoints or credentials.

## 7. Storage and live updates

Use a private S3-compatible Railway bucket. Persist object keys and metadata rather than expiring URLs. Authenticate upload/download operations; check organization membership, allowed type and size; authorize access to the associated conversation/knowledge/profile record. File cleanup follows record deletion/retention rules and is retryable.

Supabase's public media URLs cannot be carried over unchanged. Generate short-lived presigned links when displaying/downloading permitted content, or proxy protected content through an authorized route. Prefer server-side Meta media upload and provider media IDs for outgoing messages; if Meta fetches a URL, its signed URL must be valid for the dispatch interval. No permanent public customer-media bucket.

Use SSE for same-origin live events and HTTP heartbeats for presence initially. Publish events from committed outbox records; tenant and user-recipient checks run on every stream. Reconnects resynchronize from authoritative database state or a bounded event cursor. Display degraded/live connection status honestly. Revocation must terminate or invalidate streams promptly. No process-local emitter as the only shared event source across replicas.

## 8. Durable work and WhatsApp integration

Keep the existing official Meta adapter. Preserve raw-body HMAC validation, webhook verification, encrypted credentials, template state handling, identity resolution, inbound media and monotonic message status updates. A WasenderAPI provider is outside this setup request and would require a separate integration contract.

Before acknowledging a valid webhook, commit a durable receipt and its processing work. Return success only after persistence. Deduplicate provider event/message identities. A TypeScript worker processes receipts, dispatches automations/flows/AI, and sends outbound event hooks from an outbox.

Use a PostgreSQL-backed durable queue (pg-boss or an equivalent library verified during dependency selection) so a Redis service is not required for this foundation. PostgreSQL remains the source of truth for delayed work and dispatch state. Jobs carry tenant scope, retries with bounded backoff, lease/heartbeat expiry, attempts and terminal failure state; crashing a worker must not strand work forever.

Move broadcast orchestration into jobs. Closing the browser must not stop a campaign. The UI displays persisted progress and controls permitted pause/resume actions. Enforce per-number and provider-response pacing server-side. Apply send-window/template/consent policies across manual messages, broadcasts, automations, flows and AI; do not treat the transport as permission to send.

Persist outbound intents and stable internal IDs. Provider timeouts after acceptance create an unknown outcome: do not blindly retry potentially delivered messages or claim exactly-once delivery. Reconcile using provider identifiers/status evidence where available and surface unresolved outcomes for review.

Implement and verify recurring `time_based` trigger scheduling and flow input validators before advertising them as functional. Preserve existing wait-for-reply and flow timeout behavior through durable jobs. Human takeover prevents bot conversation replies until explicitly resumed; future transactional reminders follow the PRD's separate policy.

## 9. Production standards

- Validate configuration at startup with useful missing-variable names and no secret disclosure; fail closed for required production services.
- Encryption keys, database URLs, auth secrets, email credentials, object-storage keys and Meta secrets remain server-side and are excluded from logs/client bundles.
- Use shared atomic rate limiting, request size limits, safe error envelopes, cookie/origin/CSRF controls and tested security headers. Preserve microphone permission for voice notes.
- Structured logs carry request/event/job correlation identifiers, redact customer content and credentials, and distinguish provider/configuration/retryable failures.
- Readiness checks verify necessary dependencies; liveness does not require live Meta calls. Workers stop gracefully and release or expire leases.
- Audit membership/permission changes, exports, credential changes, ownership transfer and support operations. Define retention and object cleanup; no indefinite raw webhook payload retention by default.
- Build non-root containers, commit reproducible lockfiles, use separate staging/production configuration and apply migrations through a single controlled step.
- Backups, database restore, object-storage recovery, migration failure recovery and encryption-key handling have runbooks and tested evidence before production claims.

## 10. Setup experience and acceptance

The setup deliverable must include working commands for dependency installation, ORM generation, database migration/status, safe seed/onboarding, app start, worker start and checks. An environment example documents all required values and private/public URL differences without real credentials. An operator can onboard the first tenant through the supported auth flow without manual Supabase SQL.

Verification must cover:

1. Both application and MCP package install from committed lockfiles; lint, typecheck, relevant existing domain tests, MCP build and Next production build pass with recorded output.
2. A fresh real PostgreSQL database accepts the migration baseline and rerunning the deployment migration is safe; schema constraints, RLS/grants, FTS and optional vector queries are verified.
3. Signup/login/verification/reset/logout, membership/invitation/ownership flows and privileged MFA work with test email delivery. Tests reject JWTs with a bad signature, wrong issuer/audience, missing/invalid claims, unknown `kid`, expired time, unacceptable algorithm or revoked session. Refresh rotation is atomic; concurrent refresh cannot issue two successors, replay revokes its session/family, and global logout/password reset invalidate already-issued access tokens. Cookie attributes, CSRF checks, tenant switching and signing-key rollover have integration coverage.
4. Two organizations contain overlapping names/phones and users; attempts to access another tenant through IDs, references, lists, searches, keys, files, SSE or jobs are rejected. A user belonging to both sees only the selected authorized workspace.
5. Contacts/import/tags/custom fields/notes, pipelines/deals, inbox/assignment/unread/notifications, quick replies and media function through the replacement backend.
6. Invalid webhook signatures fail; duplicate and reordered events do not duplicate contacts/messages/sends or downgrade delivered/read states. Persisted accepted events survive an immediate process restart.
7. Broadcasts continue after closing the initiating browser. Concurrent workers do not process a recipient twice; uncertain provider outcomes do not produce blind duplicate retries.
8. Automations/flows execute supported nodes; invalid email/phone/regex input reprompts; delay/schedule/timeout/reply waits survive restart and can be recovered. Human handoff pauses bot replies.
9. AI draft/auto-reply/knowledge/usage are scoped and keys encrypted; tests use a provider simulator unless real credentials are configured. No paid live AI request is part of routine tests.
10. Public API scopes/revocation, webhook signing/retry and MCP read/explicit-write behavior remain correct.
11. Worker health, distributed limits, database connection pooling and restore recovery are checked. Use the PRD staging profile of two tenants, 10 concurrent staff and 10,000 contacts per tenant, with 100 accepted webhook events/minute across both; report measurements rather than asserting capacity from a build.
12. Real Meta staging/test-sender verification and production provider eligibility are recorded separately from simulation. If credentials/assets are missing, mark live validation pending and do not label the integration production-ready.

Successful installation/build alone is insufficient to call this production-ready. The delivered report records implemented/tested/simulated/live-verified states per feature and any external prerequisites.

## 11. External provisioning and release boundary

No Railway project named Bodhinox Chat appeared in the read-only project inventory. Propose a dedicated project with a staging environment, PostgreSQL, application, worker and private bucket. Do not reuse or modify unrelated existing databases.

Source/configuration/build/tests are completed locally before asking for any live deploy action. Cloud creation/deployment and use of real business WhatsApp assets are separate concrete external steps with their applicable authorization. Keep staging and production credentials/data separate. Do not perform destructive migrations against an existing database.

SMTP/provider credentials, selected Railway region and Meta test/business assets are external setup inputs. Development work can proceed against local/test services once this spec and its implementation plan are approved; missing external assets must not be replaced with fake live claims.

## 12. Review status

The proposal reflects the user's complete-Supabase-removal and JWT-authentication decisions and preserves the latest requested frontend/application stack. This auth revision changes the design only; JWT authentication has not been implemented or tested. No implementation plan, source import into the application root, dependency installation, migration application or cloud provisioning has occurred.

Review this written specification before the detailed implementation plan is prepared. This review gate is explicitly required by the architectural path in `superpowers:brainstorming`, which says: "Architectural: the human partner reviews and approves the written spec, then reviews the written implementation plan and selects its execution method."

The workspace currently has no root Git repository, so this proposal is saved but not committed. Commit the approved design when the Bodhinox source import establishes its own repository, rather than modifying the upstream reference repository.

Primary technical references and source-review limits are recorded in [the repository review](../../architecture/2026-10-14-wacrm-repository-review.md). This specification is a proposed acceptance contract, not evidence that any of its planned services or tests have already passed.

JWT-specific primary references: [`jose` signing/verification and claims validation](https://github.com/panva/jose), [OWASP session/cookie guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), and [OWASP password hashing guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html). Token lifetimes and the refresh/session contracts above are Bodhinox design choices, not defaults claimed from these sources.
