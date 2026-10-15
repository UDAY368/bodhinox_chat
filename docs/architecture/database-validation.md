# PostgreSQL foundation validation

Dates: 14–15 October 2026. Target: the dedicated Bodhinox Railway PostgreSQL 18 service and its isolated `bodhinox_test` database. This report contains no credentials. The coordinating agent controls production migrations; database installation and application deployment are separate release checks.

## Implemented foundation

The reviewed baseline represents all 36 upstream application tables and their final columns across 46 reference migrations, plus 13 identity/reliability tables. It replaces platform-managed auth references with `auth_users`, preserves the existing `account_id` naming, and adds tenant keys to child records. Prisma 7.10 maps scalar columns; committed SQL owns composite foreign keys, tenant RLS, generated phone/full-text columns, pgvector, partial uniqueness, triggers and retained domain functions.

The baseline creates three constrained NOLOGIN database roles. Safe role bootstrap reads operator-generated passwords from ignored environment URLs and grants LOGIN without printing them. Application/worker roles are non-owner, non-superuser and non-BYPASSRLS. The auth role is narrowly granted identity, membership and compatibility records; it cannot query CRM data. Domain transactions set tenant/user/role context with transaction-local settings. Missing scope produces no domain rows.

`profiles` remains a compatibility projection; `account_memberships` is authority. Profile visibility is based on current-account membership, allowing a user to belong to more than one account. Presence keys `(account_id,user_id)`. Template uniqueness now uses `(account_id,name,language)`, and the old one-account-per-owner restriction is removed.

The outbox publishes committed events from only messages, conversations, reactions, notifications, presence, contacts, deals, broadcast recipients and broadcasts. Notifications/targeted events require their recipient identity. No credential/auth table publishes live events. Worker-only, fixed routing functions resolve phone IDs, API-key hashes and webhook verification hashes; ordinary CRM operations remain scoped.

The follow-up `20261014010000_worker_lease_fencing` migration adds job lease UUID fencing, replayable JSON outbound results and a worker-only WABA resolver that returns NULL for ambiguous account mappings. It preserves the already-applied baseline. The baseline generation script now refuses changes to its existing SQL and evolves only the latest ORM/inventory through follow-up mapping.

`20261014020000_scheduling_resolution` adds the worker-only scheduling account ID enumerator. Its fixed definer function can return only distinct account UUIDs with active automations/flows/runs or pending executions; domain queries still require tenant transactions. Migration-owner read policies cover only its four scheduling source tables.

`20261014030000_email_change_verification` adds non-null JSON verification metadata and the `change_email` purpose. The auth implementation proves the new email through an expiring token before atomically changing the identity/profile email and revoking sessions.

`20261014040000_durable_inbound_actions` adds the 50th mapped table, `inbound_action_steps`. A tenant transaction serializes ingestion on the conversation, commits one provider-identified message with its unread increment/reopening and a durable `inbound.actions` job, and suppresses duplicate inserts. Conditional provider-status SQL prevents success-state downgrade and persists status fanout jobs in the same transaction. Flow/reply/automation/AI/webhook actions run from the worker; completed stage results replay, while an interrupted/uncertain stage blocks another external action pending reconciliation. Database failures in contact/conversation/message ingestion propagate instead of marking the receipt processed.

`20261014050000_conversation_bot_pause` adds `conversations.bot_paused` with a non-null false default and existing tenant role policies. The coordinating agent owns last-moment responder checks, manual takeover and explicit resume UI.

`20261014060000_inbound_creation_markers` adds internal nullable contact/conversation provider-message markers. Creation helpers persist the originating inbound ID and recover creation flags from that ID on a retry, including insert races. Message/job deduplication still prevents repeated fanout; later message IDs do not claim the entities were newly created.

## Observed verification

| Check | Observed result |
|---|---|
| Source inventory | 46 migrations, 36 retained upstream tables; 49 baseline tables and 50 latest mapped tables after the durable inbound checkpoint migration |
| Prisma schema validation | Passed |
| Prisma client generation | Coordinator reported successful regeneration through migration 6 |
| Baseline contract tests | 2 passed |
| Fresh real PostgreSQL baseline migration | Applied successfully to `bodhinox_test` |
| Constrained role password bootstrap | Completed; no passwords printed |
| Initial real database suite | 6 passed; 31.50 seconds including network round trips |
| Follow-up tests before implementation | Correctly failed: lease/result columns absent; WABA function absent; scheduling function absent (SQL 42883) |
| Lease fencing migration and intermediate DB run | Coordinator reported 10 tests across 2 files passed in 36.97 seconds after migration 2 |
| Migration 3 and full 11-case DB run | Coordinator reported 13/13 tests across 2 files passed in 49 seconds, including the 2 baseline contracts |
| Migration 4 and latest Prisma client generation | Coordinator reported both succeeded against the isolated test database |
| Real auth integration suite | Coordinator reported 12/12 cases passed against PostgreSQL; auth module owns lifecycle details |
| Migration 5 and durable inbound integration | Coordinator reported applied/generated successfully and 8/8 cases passed in 45.27 seconds |
| Reviewed CRM/repository/processor suites | Data-access agent relayed coordinator output: 46/46 tests across 4 files passed in 58.25 seconds, including processor cases against the extracted persistence boundary |
| Migration 6 and bot-pause role integration | Coordinator reported applied/generated successfully and 1/1 targeted role case passed in 11.81 seconds; missing-column RED observed first |
| Early unmatched status and migration 7 creation-flag recovery | Both RED cases were observed first; coordinator reported latest ingest 10 and processor 33 cases passed, 43/43 across 2 files in 63.87 seconds |
| Production database installation | Coordinator reported verified-empty preflight, migrations 1–7 and constrained-role bootstrap all passed; this does not assert application source deployment |
| Atomic campaign creation and route suite | Coordinator reported 9/9 tests across 2 files passed in 35.18 seconds after removing the unsupported membership row lock |
| Repeated migration deploy | Pending coordinator execution; update only from returned output |
| Whole-application lint/typecheck/build and complete test suite | Coordinated separately; no database-only result implies they passed |

The six passing real database cases verified role flags; isolation with overlapping phone identities; denied cross-tenant reads, tenant-ID inserts and contact/tag associations; normalized-phone uniqueness; no domain rows without scope; pooled transaction settings clearing; the auth role denied CRM reads; provider message uniqueness; eight concurrent unread increments without loss; one active flow run per tenant/contact; and tenant-scoped generated full-text retrieval.

Initial connection attempts failed because node-pg rejected the image's self-signed certificate chain. The coordinator retrieved the project CA and configured an ignored root-certificate file with explicit certificate-chain verification. The external proxy hostname differs from the internal certificate name, so node-pg external URLs use `verify-ca` and explicit libpq compatibility rather than disabling TLS globally. The subsequent connection succeeded. The first test run then failed at the expected missing-role check on the empty test database before migration.

The first migrated run hit Vitest's five-second per-case default on sequential cloud round trips. Individual cases use a bounded 60-second timeout; rerunning produced the six passing cases above. This timeout is test configuration, not a measured application-capacity claim.

## Commands and remaining evidence

The coordinator runs schema commands with `DATABASE_ENV_FILE=.env.test`, selecting the ignored isolated test configuration. The commands are `npm exec prisma migrate deploy`, `npm exec prisma generate` and `npm test -- src/lib/db/baseline.test.ts src/lib/db/postgres.integration.test.ts`. A second `migrate deploy` must report no pending migrations. The production database remains a separate release target; no database tests use it.

The full eleven-case DB suite additionally verifies actual scoped pgvector retrieval, transaction-backed broadcast/counter/contact-history behavior, lease/result columns, WABA ambiguity and worker-only scheduling resolution. Auth lifecycle/session/MFA/email-change tests and CRM repository tests use their own integration suites and must be reported separately. Load measurements, backup/restore recovery and live-provider staging verification remain distinct checks. This report does not establish production readiness from a schema migration.

## Durable queue and dispatch integration

`src/lib/jobs/jobs.integration.test.ts` uses the same separately named test database, checks owner/worker database identities match, creates random isolated fixtures and removes only its own records. Provider callbacks are simulations; no real Meta request is made. The coordinator observed the initial six-case run with three passing and three failing cases: an expired final-attempt lease remained `running`, and both dispatch cases failed the committed status constraint before any provider callback.

The fixes atomically reap exhausted expired leases as `failed`, bound every claim by its attempt limit and align dispatch state with the committed `dispatching`/`accepted` vocabulary. A seventh case covers an explicit manual retry of a provider-rejected send. Its atomic conflict update can reclaim only `failed` intents when `retryRejected` is explicitly true. `accepted` results are replayed, while `dispatching` and `unknown` intents cannot be resent by this option.

The original seven-case queue suite checks atomic receipt/job deduplication, distinct concurrent SKIP LOCKED claims, expired-lease reclaim with stale heartbeat/completion rejection, final-attempt reaping, concurrent single-provider dispatch and saved result reuse, unknown outcomes with no blind retry, and serialized explicit rejected-send retry. The coordinator reported all 7 passed in 28.05 seconds after the fixes. An eighth case was added for explicit rearming of done/failed jobs without resetting pending/running leases; its expected done-versus-pending RED was observed. `requeueCompleted` defaults false, updates only matching type/tenant terminal jobs and preserves the stable job UUID. The coordinator reported all 8 passed in 34.81 seconds after this fix. The command is `npm exec vitest run src/lib/jobs/jobs.integration.test.ts -- --maxWorkers=1 --reporter=dot`.

The eight-case inbound suite exercises concurrent duplicate message/unread/job deduplication, rollback of message/unread/outbox on a simulated job-insert failure, serialization of distinct first inbounds, concurrent/reordered status preservation and aggregate counters, completed-stage replay, blocked interrupted/uncertain stages, and cross-tenant rejection. Simulated failure triggers are scoped to the test tenant and always dropped; fixtures are removed. No real Meta/AI send occurs. The coordinator reported all 8 passed in 45.27 seconds after migration 5. Command: `npm exec vitest run src/lib/whatsapp/ingest.integration.test.ts -- --maxWorkers=1 --reporter=dot`.

The checkpoint design does not establish exactly-once external actions. A worker crash during a started stage leaves explicit uncertain progress requiring reconciliation. Lower-level engine failure/attempt logs and live-provider reconciliation remain separate validation boundaries.

An outbound status arriving before its local message or broadcast-recipient provider ID exists now throws a definite `StatusAwaitingPersistenceError`. The stored receipt job retries with backoff, then advances the row and creates its status fanout job. Existing stale statuses remain successful no-ops; an unknown provider ID eventually leaves an observable retained failed job rather than being silently acknowledged. The regression first reproduced the dropped callback; the coordinator's latest 10-case ingest run passed after this fix and migration 7.

## Server campaign creation

`POST /api/broadcasts/create` requires a live JWT agent identity and mutation proof. The server validates a bounded audience configuration and owned approved template, verifies every supplied tag/custom-field reference, rechecks live membership in the worker tenant transaction, resolves CSV numbers and audience exclusions, and freezes per-contact template parameters. Broadcast, recipients, outbox events, imported CSV contacts and the initial durable dispatch job commit together. The job carries only campaign identity, scope and optional media URL; provider credentials are resolved by the worker. Template header fallback is preserved for worker signing.

Campaign tests first failed on the missing operation. The first implemented run then exposed a PostgreSQL permission failure because worker SELECT permission on memberships does not permit `FOR SHARE`. The query now reads live membership without that lock and retains the narrow role grants. The coordinator reported all six real database cases and three route cases passed in 35.18 seconds. They cover frozen counts/parameters/job, CSV deduplication/reuse, viewer and foreign reference rejection, rollback on job insertion failure, bounds/unapproved templates, header fallback and foreign media, JWT/mutation scope and streamed body bounds. Command: `npm exec vitest run src/lib/broadcasts/create-campaign.integration.test.ts src/app/api/broadcasts/create/route.test.ts -- --maxWorkers=1 --reporter=dot`.

Coordinator follow-up,15 October: production preflight verified zero public tables and pgvector; migrations1–7 and constrained role login bootstrap passed. Repeated migration deploys against both railway and bodhinox_test report no pending migrations. Production preflight now reports51 tables, including Prisma migration history. Application deployment is tracked separately.
