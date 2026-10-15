# Bodhinox foundation execution ledger — 15 October 2026

User-authorized scope: fully remove Supabase, preserve upstream Next/React CRM functionality, use Prisma/Railway PostgreSQL and JWT, install and deploy through the specified GitHub/Railway destinations. Email provider is deliberately deferred. The repeated proceed instructions authorize completion without another plan approval.

Imported 527 upstream tracked files at 27c6bdf43633d1746410168431a8b0e22b4f2ba6; MIT attribution retained. Immutable reference and old Supabase migrations are archived in ignored .reference. Local foundation branch: codex/bodhinox-foundation. GitHub source not yet pushed at this checkpoint.

Runtime: Node24.20.0/npm12.0.2, Next16.3.8/React19.2.4/TypeScript6/Tailwind4. Prisma7.10 and constrained app/auth/worker roles replace Supabase completely. JWT/Argon2id/rotating refresh/CSRF/MFA, private S3 media, scoped SSE and PostgreSQL durable jobs are implemented. Existing components and engines retained. Registry extraction damage was repaired; runtime npm audit now reports zero vulnerabilities. Development tool chain has unresolved advisories; lint has33 upstream warnings and zero errors.

Production: railway database was freshly preflighted empty with pgvector available. All seven immutable migrations applied successfully; role login bootstrap completed. Repeated production and isolated test migration deploys both report no pending migrations. Production now has50 mapped tables plus Prisma migration history. No customer data or production owner account has been added.

Railway web, worker and private media resources/variables/domain prepared as recorded in docs/deployment/railway.md. GitHub production migration environment and secret configured without exposing values. Source connection and application deployment remain pending at this checkpoint. Runtime services never receive the migration-owner credential.

Validation: final full suite1267tests/136files passed in480.06seconds. Latest production build passed, typecheck passed, ESLint exited0 with33 warnings, runtime audit0 vulnerabilities, MCP build previously passed. Isolated real DB suites include ingestion+processor43/43, campaign9/9, data76/76, jobs8/8, scheduled fan-out3/3; scheduled/unit validation47/47, automation boundary15/15.

Important review findings fixed with observed RED then GREEN: atomic message/unread/action fan-out, monotonic provider status with deferred ID persistence, worker lease fencing, uncertain dispatch reconciliation, scoped legacy routes, broadcast recipient/count persistence and requeue, persistent human takeover, internal creation-marker privacy, void-RPC presence decoding, legacy browser timestamps with server stamps, scoped mark-read and media-retention actions, atomic authenticated campaign creation, and scheduled contact audiences/activation guards. Browser generic automation writes are read-only so dedicated validators cannot be bypassed. Shared interactive constants no longer import server-only provider code into browser bundles.

Local requested preview: Next development server on http://localhost:3001 uses isolated bodhinox_test configuration and synthetic owner fixture. Dashboard loads; contact create/edit persisted and scoped presence heartbeat verified online. Production data remains separate. Do not run the worker against the test database concurrently with integration suites.

Ruling: scheduled contact actions require explicit all/tag/custom-field recipients with bounded scans; account-only webhook schedules remain supported. Ruling: worker membership recheck uses SELECT without FOR SHARE, preserving narrow grants rather than granting membership mutation rights. Unknown external actions remain reconciliation-required; no exactly-once provider claim.

Remaining: observe final suite, secret-scan/stage current source, initial commit/push and CI, connect and verify Railway web/worker builds and health, then record deployment evidence. SMTP/Meta/AI credentials and live-provider acceptance remain explicitly outstanding. Future commercial multi-tenant provisioning/billing and shared horizontal rate limits are separate work.

Release verification: full suite1267/1267,136files; typecheck exit0; build exit0; lint exit0/33warnings; runtime audit0. Local worker started ready against production then stopped. Configured-secret scan of627 staged files passed. Existing whitespace warnings in imported source/docs are deferred; no runtime claim depends on formatting checks.
