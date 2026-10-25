# WACRM adaptation: changes and rollout

This change adapts useful behavior from WACRM `34bce1a` to the existing BODHINOX Railway/PostgreSQL application. It does not merge upstream Supabase infrastructure or replace the cream-and-copper interface.

## Product changes

- Inbox adds Waiting for reply, Unassigned, and Expiring soon queues. Existing status, tag, company and 24h Active/Expired filters remain. Expiring soon means a waiting conversation with up to two hours left in its customer messaging window.
- Conversation history loads 50 messages at a time, with older-message loading. Resync preserves failed local messages and reconciles persisted sends. Touch keyboards use Enter for a newline; desktop Enter-to-send preserves composition/IME safety.
- Template conversation bubbles display stored headers/media, footers and button previews. Historical parameter snapshots cannot be reconstructed if an old message never stored them; template metadata is used as a fallback.
- Settings → Inbox adds a workspace reply target of 1–1,440 whole minutes. Members can read it; admins/owners can change it.
- Dashboard keeps the existing charts and adds operational queues, failed-message details, human/automated response statistics, pipeline results, campaign health, setup checklist and a WhatsApp quality/limit indicator. Automated replies include both AI and other bots. Unknown Meta limits are shown as unknown rather than inferred.
- Contact lookup prefers exact normalized phone identity and limits tolerated matches to generated trunk-prefix variants.
- Flow and automation fixes cover paused/stale runs, safe reply claims, inline deadlines, automatic cycles, live-flow save validation, stable parked-step identity, explicit condition timezones, blank-value guards and automation template headers.
- The WhatsApp media proxy uses private caching, MIME validation, attachment fallback, nosniff and a sandbox CSP.

## Data semantics

`last_customer_message_at` and `last_reply_at` are read-only, tenant-scoped conversation projections. A real reply is a successful sent/delivered/read agent or bot message excluding templates/system messages. Failed sends and templates do not clear a waiting customer. First-response medians use the first qualifying reply to the latest preceding customer message, checking prior history even outside the selected reporting period.

Dashboard attention counts are current state. Response and campaign metrics use a rolling 7/30/90-day period. Pipeline time-to-win uses the available `updated_at` timestamp as a proxy; the application does not have historical immutable close timestamps. This is not a new audit/event history system.

## Required migrations

Apply these additive migrations before starting the updated web and worker processes:

1. `20261024100000_automation_parked_step_identity`: nullable parked-step identity. Existing pending rows retain legacy resume behavior; new parked runs preserve step identity through edits.
2. `20261024120000_flow_reply_transition_claim`: flow transition revision and cancelled run status.
3. `20261024130000_reply_target`: default five-minute account target, database bounds check, and successful-reply index.

No new environment variables, provider credentials or frontend secrets are required. Keep the existing constrained application/auth/worker database URLs and migration-owner configuration. Production migrations must use `MIGRATION_DATABASE_URL` through the existing deployment process.

Typical existing pipeline steps:

```powershell
npm.cmd ci
npm.cmd exec prisma generate
npm.cmd run db:migrate
npm.cmd run build -- --webpack
```

Deploy/restart both the web service and the durable worker after migrations, using the same revision. Do not deploy a web revision requiring the new columns ahead of its migrations. An application rollback can leave the additive columns in place, but its flow-run UI must retain support for the new `cancelled` status; the old status map cannot display those rows safely. Do not drop columns to roll back an application release.

## Verification record

- The three migrations applied successfully to the isolated `bodhinox_test` database; production was not migrated.
- Flow-focused verification initially passed 159 tests; review added timeout snapshot and lost-claim regressions, with 20 targeted timeout/run-integrity tests passing afterward.
- Automation-focused verification passed 124 tests across eight files.
- Media/contact/data-contract verification passed 68 tests across eight files.
- Inbox/template-focused verification passed 63 tests across ten files.
- New account/dashboard API, dashboard rendering and phone-health parsing verification passed 23 tests across four files.
- The isolated CRM integration suite passed all 15 tests after fixing an untyped SQL parameter and making the fake WhatsApp identifier unique per tenant/run.
- Additional filled-data tests verified tenant isolation, waiting/expiring queues, successful vs failed/template replies, read-only projections and handoff badges. A further historical-median regression exposed a reporting-window edge case and its SQL correction is included.
- Final post-review unit run: **1,529 tests passed across 168 suites**.
- Final sequential database integration run: **74 tests passed across eight suites**. The combined parallel run previously hit one database workflow timeout; separating the runs removed cross-suite database contention.
- Final TypeScript check and production webpack build passed. ESLint reported zero errors and 32 remaining warnings. The independent reviewer rechecked the fixes and reported no further material findings.

Reproduce verification without parallel remote-database contention:

```powershell
npm.cmd test -- --exclude '**/*.integration.test.ts'
npm.cmd test -- integration.test.ts --no-file-parallelism --maxWorkers=1
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build -- --webpack
```

No external customer messages or real provider calls were used for verification. The browser had no running authenticated local application; component rendering and PostgreSQL/API tests are the verification evidence, not an authenticated browser acceptance test.

## Remaining limits

Graph/automation saves retain the existing multi-statement persistence model. They return errors on failed writes but are not a published-version or all-or-nothing graph replacement system. Do not treat this port as the complete AiSensy-style flow builder proposed in the separate blueprint.

Separate optional work remains for canonical business-reaction handling, browser-timezone AI usage reporting and unrelated upstream dependency/API maintenance. These were not silently merged into the product.
