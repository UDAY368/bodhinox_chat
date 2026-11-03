# Database foundation

`schema.prisma` maps the final 36 upstream CRM entities and 13 identity/reliability tables. The baseline is a new PostgreSQL migration; it does not replay platform schemas. `schema-inventory.json` records all retained fields, references and the 46 source migration names.

SQL migrations own tenant composite foreign keys, RLS/grants, checks, generated phone/full-text fields, pgvector, partial indexes and concurrency functions. Prisma maps scalar columns for repository access. Review any future migration diff against these SQL invariants: a generated diff must not remove those constraints. Do not use `prisma db push` against staging or production.

The PostgreSQL image must have pgvector binaries available. Preflight checks this capability before deployment. The chosen Railway PostgreSQL 18 image was verified by the coordinator to provide vector, pgcrypto and uuid-ossp; this baseline uses pgcrypto and vector.

## Setup sequence

1. Put the identified migration owner's reachable URL in ignored `.env.local` as `MIGRATION_DATABASE_URL`. Local commands cannot use Railway-only internal DNS.
2. Run `npx tsx scripts/db-preflight.ts --expect-empty` before a **first installation**. Later deployments use migration status; do not require an existing application database to be empty.
3. Run `npx prisma validate`, `npx prisma generate`, then `npx prisma migrate deploy` as a controlled migration job. Run `npx prisma migrate status` to inspect committed migration state. Reapplying `migrate deploy` is safe because Prisma tracks the applied migration; the baseline SQL itself is not an ad hoc idempotent schema script.
4. Configure distinct runtime URLs for `bodhinox_app`, `bodhinox_auth` and `bodhinox_worker`, each with an operator-generated password of at least 32 characters. Run `npx tsx scripts/db-bootstrap-roles.ts` using the migration owner. It gives existing constrained NOLOGIN roles their configured passwords and LOGIN privilege; it never prints passwords or creates a default admin.
5. Start the application and create the first identity/organization through the supported signup flow. Optionally initialize defaults with `npx tsx scripts/db-seed-defaults.ts ACCOUNT_UUID EXISTING_OWNER_UUID`; this creates an idempotent empty Sales pipeline, never users, passwords or invented business records.

Production runtime requires explicit `DATABASE_URL`, `AUTH_DATABASE_URL` and `WORKER_DATABASE_URL` naming the corresponding constrained roles. `MIGRATION_DATABASE_URL` belongs only to the release/operations environment and must be absent from deployed application and worker runtime variables. Migrations and role bootstrap are operations commands, not application startup code. Deployed services should use Railway's private endpoint; the migration CLI/local operator uses a separately reachable endpoint.

PostgreSQL role passwords are cluster-wide. If test and production databases share the dedicated PostgreSQL service, preserve the same configured role passwords across their environment URLs; intentional rotation must update both environments together.

The selected SSL image uses a project CA and a server certificate whose name differs from the external proxy hostname. Local external URLs configure `sslrootcert` with the operator's ignored project CA file and explicit `sslmode=verify-ca&uselibpqcompat=true` for node-pg. This verifies the trusted certificate chain without pretending the proxy hostname matches the internal certificate. Prisma CLI URLs retain `sslmode=require` with the same root CA. Deployed Linux URLs use `/app/deploy/railway-postgres-ca.crt`; the coordinator pins the public CA certificate in the container build. Environment credentials and private keys remain ignored. Do not disable TLS verification globally or copy a Windows certificate path into a container URL.

## Isolation and identity

`withTenant({accountId,userId,role}, callback, optionalPrismaClient)` opens an interactive transaction and sets `app.account_id`, `app.user_id` and `app.account_role` with `set_config(..., true)`. Every setting expires with that transaction. The default client is `getPrisma()`; durable domain work passes `getWorkerPrisma()`. Missing tenant scope yields no CRM rows. A tenant ID is trusted only after the application verifier checks its live membership or machine credential authority.

Application roles never own tables or bypass RLS. The auth role can operate only identity tables and their organization/profile/membership/invitation projections. It has no CRM access. The worker may enumerate jobs/receipts globally; all domain tables still require tenant scope. `resolve_whatsapp_routing(phone_number_id)` is its fixed, narrow routing projection and returns only account/user identity plus the encrypted verification token.

Profile rows are compatibility records, while `account_memberships` owns membership. A profile can appear in multiple accounts through membership; RLS checks those memberships rather than assuming its home `profiles.account_id` is its only workspace. Presence now keys `(account_id,user_id)` for the same reason.

Notifications and targeted outbox events are readable only by their recipient in the active tenant. Domain outbox triggers cover the approved nine non-secret live tables. No credentials or auth tables publish events.

## Verification

`npm test -- src/lib/db/baseline.test.ts` checks baseline platform removal and security/concurrency invariants. `npm test -- src/lib/db/postgres.integration.test.ts` exercises the real PostgreSQL behavior. Without `TEST_DATABASE_URL`, the integration suite is explicitly skipped. Configure it in ignored `.env.test` to a separately named **test** database already migrated with this baseline. Its owner must be able to `SET LOCAL ROLE` to the constrained roles. Fixtures use random UUIDs and `.invalid` emails and never touch production. The test database is disposable; fixture records are intentionally retained for debugging.

Real integration evidence includes runtime role flags, denied cross-tenant reads and associations, denied CRM access by the auth role, pool scope reset, phone/provider deduplication, concurrent unread increments, active-run uniqueness and constrained full-text retrieval. Follow-up checks cover lease/result columns and a worker-only WABA resolver that rejects ambiguous mappings. Auth lifecycle and worker restart/provider acceptance tests live with their respective modules and are separate checks.

The baseline SQL is immutable after first application. `build-baseline.py` refuses a changed baseline; later additions belong in a new versioned migration and the latest schema/inventory mapping. The `20261014010000_worker_lease_fencing` migration adds `jobs.lease_token`, `outbound_intents.result` and `crm_resolve_waba_account(text)`. The `20261014020000_scheduling_resolution` migration grants the worker only `crm_accounts_for_scheduling()`, returning IDs of accounts with active/pending work.

`20261014030000_email_change_verification` adds `auth_verifications.metadata` and the `change_email` purpose. Request/confirmation behavior is implemented and verified by the auth module; schema application alone does not prove that user flow.

`20261014040000_durable_inbound_actions` adds tenant-scoped action-stage checkpoints. Ingest commits the message, unread/reopening state and `inbound.actions` job together; provider status updates are monotonic and commit their status fanout jobs together. An interrupted stage requires reconciliation and cannot automatically resend. `20261014050000_conversation_bot_pause` adds the durable `conversations.bot_paused` human-takeover flag. The root responder guards and explicit resume UI own its product behavior.

`20261014060000_inbound_creation_markers` preserves the originating inbound provider ID on newly created contacts/conversations. Retries recover creation-specific fanout flags from that marker; later messages do not report old entities as newly created. Browser resources must exclude these internal fields; the data-access module owns that projection. Unmatched early outbound status callbacks throw a retryable persistence error so the durable receipt is retained until a local provider-ID row exists or the job attempt budget is exhausted. Since the cross-phase hardening round, a callback older than 20 seconds (`STATUS_PERSISTENCE_GRACE_MS` in `src/lib/whatsapp/ingest.ts`) whose wamid has no local row, such as a campaign test send, is dropped as a no-op instead of failing the webhook job and its sibling statuses.

`20261105110000_waba_resolve_skip_disconnected` replaces `crm_resolve_waba_account(text)` (signature, SECURITY DEFINER, search_path, owner and grants unchanged) so it ignores admin-removed numbers (`status='disconnected' AND access_token=''`), matching `crm_resolve_whatsapp_account` and `resolve_whatsapp_routing` since `20261102102000`; a WABA connected in more than one workspace still resolves to none. `20261105114500_flow_run_wait_until` adds nullable `flow_runs.wait_until` (a payment link's expiry; the stale sweep counts a run's age from the latest of `last_advanced_at`, `delay_until` and `wait_until`). Both are additive with no backfill. `src/lib/repositories/waba-resolve.integration.test.ts` checks that a number removed in one workspace and connected in another resolves to the new workspace.
