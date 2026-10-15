# Bodhinox Chat foundation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Install the upstream CRM, replace Supabase completely with JWT/Prisma/Railway PostgreSQL services, and deliver a tested GitHub-deployable application and worker with honest feature/setup status.

**Architecture:** Retain the upstream Next application and provider/domain logic. Browser data access goes through authenticated fixed-resource APIs; server repositories use Prisma and PostgreSQL transactions. JWT sessions, tenant scope, private media and durable work replace the corresponding Supabase services.

**Tech Stack:** Next 16, React 19, TypeScript, Tailwind 4, Prisma 7, PostgreSQL, jose, Argon2id, S3-compatible storage, TypeScript worker, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-14-bodhinox-wacrm-foundation-design.md`.

**Authorization:** On 14 October the user accepted the plan/design and explicitly asked to proceed, clarifying Railway cloud PostgreSQL URLs and GitHub-based backend deployment. Execute the authorized foundation work continuously. External destination names are being requested asynchronously; no unrelated live service is a target.

## Global constraints

- Preserve all existing Bodhinox documents and upstream MIT attribution.
- No active Supabase packages, environment requirements or network clients at completion.
- JWT access lifetime 15 minutes; random refresh tokens rotate with a seven-day maximum session lifetime.
- Every domain operation is tenant-scoped and server-authorized; constrained database roles enforce RLS.
- Production database migrations are versioned and non-destructive; use migration credentials separately from application/auth credentials.
- Read installed Next guides before changing its application conventions.
- Secrets are environment-only and never printed, committed, placed in client bundles or hardcoded as deployed defaults.
- No production-ready claims from compile/build alone; record simulated, database-tested and live-provider results separately.

## Review focus

1. A browser changing record IDs/related fields cannot read or associate another tenant's data.
2. JWT logout, password reset and membership revocation invalidate previously issued tokens and active event streams.
3. Accepted webhook/jobs survive restart; retry after an uncertain provider send never blindly duplicates it.
4. Private storage keys cannot produce permanent public customer-media access.
5. Local/public Railway connection configuration never uses an inaccessible private hostname or migrates an unrelated database.

## Shared contracts

- `src/lib/db/prisma.ts`: `getPrisma(): PrismaClient`; lazily initialized from `DATABASE_URL`; `getAuthPrisma()` from `AUTH_DATABASE_URL || DATABASE_URL`; `getMigrationPrisma()` from `MIGRATION_DATABASE_URL || DATABASE_URL` for development only. Production requires explicit constrained credential configuration.
- Auth SQL tables: `auth_users(id uuid, email text unique, full_name text, password_hash text, email_verified_at timestamptz, disabled_at timestamptz, created_at timestamptz)`; `auth_sessions(id uuid, user_id uuid, account_id uuid, csrf_hash text, expires_at timestamptz, revoked_at timestamptz, created_at timestamptz)`; `auth_refresh_tokens(id uuid, session_id uuid, token_hash text unique, expires_at timestamptz, consumed_at timestamptz, replacement_id uuid, created_at timestamptz)`; `auth_verifications(id uuid, user_id uuid, purpose text, token_hash text unique, expires_at timestamptz, consumed_at timestamptz)`.
- Memberships: `account_memberships(id uuid, account_id uuid, user_id uuid, role text, created_at timestamptz, unique(account_id,user_id))`; preserve upstream `accounts` and `profiles` shapes as compatibility projections, not membership authority.
- `src/lib/auth/session.ts`: `resolveSession(request?: Request): Promise<AuthContext|null>` where `AuthContext={userId:string,accountId:string,role:AccountRole,sessionId:string,expiresAt:number,user:{id:string,email:string,user_metadata:{full_name:string}}}`; `requireSession(request?: Request)` throws typed 401; `assertMutation(request,context)` enforces Origin/CSRF.
- `src/lib/data/types.ts`: `DataClient`, `QueryResult<T>={data:T|null,error:{message:string,code?:string}|null,count?:number|null}`; query-builder compatibility stays internal to the source migration, backed by fixed resource contracts. No browser endpoint accepts arbitrary SQL/table names.
- `src/lib/jobs/queue.ts`: `enqueueJob(type:string,payload:Record<string,unknown>,opts?:{tenantId?:string,runAt?:Date,dedupeKey?:string}):Promise<string>`; worker handlers operate only on persisted scoped work.

### Task 1: Import and reproducible tooling

**Files:** root upstream source/config/manifests; `docs/UPSTREAM.md`; `package.json`; `tsconfig.json`; `.gitignore`.

**Produces:** installed source with known baseline tests and recorded package constraints.

- [x] Copy tracked upstream files without `.git`, overwrites or changes to the reference snapshot.
- [ ] Install lockfile dependencies, inspect installed Next guides, run baseline tests and record failures before migration.
- [ ] Add/pin supported ORM/auth/storage/worker/test dependencies after registry checks.
- [ ] Initialize a dedicated local foundation branch; preserve license and upstream provenance.

### Task 2: Database baseline and constraints

**Files:** `prisma/schema.prisma`, `prisma/migrations/*/migration.sql`, `prisma.config.ts`, `src/lib/db/prisma.ts`, `src/lib/db/tenant.ts`, `scripts/db-*`, database integration tests.

**Consumes:** final upstream migrations and shared auth/membership contracts. **Produces:** all upstream entities plus identity/reliability records and safe migration/onboarding commands.

- [ ] Write tests proving tenant-crossing reads/writes fail and required final schema behavior is retained; run to observe failure before implementation.
- [ ] Implement final bare-PostgreSQL schema and reviewed RLS/functions/indexes with Prisma and transaction-local identity context.
- [ ] Replace Supabase-managed auth/storage SQL dependencies with first-party records and constrained roles.
- [ ] Verify fresh migration, reapplication, constraints and pooled tenant transactions against an isolated PostgreSQL test database.

### Task 3: JWT identity and browser auth integration

**Files:** `src/lib/auth/{jwt,password,session,service,csrf,client}.ts`, `src/app/api/auth/*/route.ts`, auth pages/hooks/middleware, auth tests.

**Consumes:** shared auth SQL and lazy Prisma interfaces. **Produces:** `resolveSession`, `requireSession`, `assertMutation`, complete auth lifecycle and existing browser auth facade.

- [ ] Write/run failing JWT claim/signature/expiry tests and refresh-reuse/revocation integration tests.
- [ ] Implement signed access tokens, hashed refresh rotation, protected cookies, CSRF/origin controls, verification/reset/password/session endpoints and tenant membership resolution.
- [ ] Adapt existing signup/login/reset/profile/logout hooks/pages; no tokens in browser storage or routine response JSON.
- [ ] Verify roles, MFA enrollment/recovery, concurrent refresh and immediate revocation with real session records.

### Task 4: Application repositories and fixed-resource APIs

**Files:** `src/lib/data`, `src/lib/repositories`, `src/app/api/crm/*`, existing server routes/UI hooks; corresponding tests.

**Consumes:** lazy Prisma, auth context and tenant transactions. **Produces:** existing CRM query/mutation behavior without Supabase clients.

- [ ] Add failing behavior tests for resource validation, role restrictions and cross-tenant reference rejection.
- [ ] Implement explicit resource schemas/repositories for all upstream tables and replace query/RPC consumers while preserving nested payloads/pagination.
- [ ] Move account context/API-key paths to JWT/membership and Prisma; replace service-role helpers with constrained domain access.
- [ ] Verify contacts/import, inbox, pipelines, campaigns, automations, flows, AI, settings, notifications and public API/MCP contracts.

### Task 5: Storage, live events and durable execution

**Files:** `src/lib/storage`, `src/lib/realtime`, `src/lib/jobs`, `worker`, media/events endpoints, provider hooks and broadcast/cron paths.

**Consumes:** domain repositories/auth and persisted jobs. **Produces:** private media access, recoverable processing, browser-independent dispatch and shared limits.

- [ ] Add failing tests for private object access, durable webhook receipt before ack, worker lease recovery and uncertain-send handling.
- [ ] Implement S3 signed/proxied access, tenant/user-authorized event streams, presence and revocation/resync behavior.
- [ ] Persist ingress/jobs/outbox before acknowledgment, run worker/scheduler with leases/retries and durable broadcasts.
- [ ] Enforce flow input validators and recurring scheduling; preserve domain regression coverage.

### Task 6: Deployment, full verification and feature handoff

**Files:** `.env.example`, `Dockerfile`, `docker-compose.yml`, `railway*.json`, `.github/workflows`, setup/runbook/feature documentation, integration/E2E tests.

**Consumes:** all earlier deliverables. **Produces:** reproducible GitHub-based Railway app/worker deployment configuration and evidence-based setup report.

- [ ] Configure distinct web/worker services, runtime secrets, migration predeploy step, healthchecks and staging/production boundaries.
- [ ] Install/build MCP; run lint/typecheck/domain/integration/E2E/build/security dependency checks and document results.
- [ ] Use the selected Railway cloud URL via ignored environment files; verify database identity before applying migrations.
- [ ] Review the integrated implementation independently and fix material findings before completion.
- [ ] Record the full module inventory, setup commands, required external assets and actual deployment/live-provider status; do not claim missing live checks passed.

## Preflight and execution rulings

- Schema/auth/data/job contracts above are shared; ownership of individual files must be assigned before parallel edits.
- An independent database/auth/worker implementation can proceed with fixed shared contracts while the coordinator owns broad source migration and integration.
- Destination/secret configuration can arrive asynchronously; local code/test preparation must continue meanwhile.
- The user's explicit instruction to proceed is preserved. This plan records the accepted design's execution details rather than requesting the same authorization again.
