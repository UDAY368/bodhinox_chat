# Release checklist (Phase 15)

Date: 2026-11-05. Code state: `main` at `3d7926f` plus the uncommitted Phase 15 changes. **Merging is a production deploy** (CI applies migrations to production, then Railway deploys web and worker). Nothing below was observed in production; no item is described as live.

Result words: `pass`, `fail`, `blocked` (external approval or keys), `owner-pending` (an owner action), `not run`. The checklist cannot be marked complete while any Tests line is `fail` or any gated item is described as live.

## Tests

| Item | Evidence | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit -p .`: no errors | pass |
| Lint | `npm run lint`: 0 errors, 23 warnings (all pre-existing, none in Phase 15 files) | pass |
| Unit tests | `npm run test:unit` after the review fixes: 660 files; 5937 passed, 0 failed, 0 skipped | pass |
| Real-database integration and load tests | Before the review fixes: `node scripts/test-db-local.cjs run` (local Docker, all files): 150 files; 1022 passed, 0 failed, 1 skipped (`queue-burst.load.test.ts`, opt-in). After them (new migrations, fresh container): the 11 touched files, 65 passed, 0 failed. The full run must be repeated before merge, then `npm run release:requirements` regenerated | pass (touched files); full rerun not run |
| Queue burst load test (opt-in) | `RUN_QUEUE_LOAD_TEST=1` run by T1 on local Docker: p95 8 ms, 132.41 jobs/s (`docs/testing/queue-burst-result.json`) | pass |
| Tenant boundaries (contracts, 47 routes, v1, worker-DB routes, delivery/realtime/audit/dashboard, RLS sweep) | [tenancy-route-coverage.md](../testing/tenancy-route-coverage.md); all cases 403/404 with B unchanged after the integration fixes; no `it.fails` left | pass |
| Route coverage gap | 64 dynamic routes without a per-route cross-tenant case, pinned (`KNOWN_UNMAPPED`, can only shrink) | open gap (visible) |
| Duplicate/reordered events (WhatsApp, Razorpay commerce, Razorpay billing, Shopify, WooCommerce, Meta leads) | [phase15-evidence.md](../testing/phase15-evidence.md) | pass |
| Ordering suites for Zoom and Instagram (P3) | not built; provider-gated in production | not run (gap) |
| Provider contracts (WhatsApp, Razorpay, Razorpay billing, Google, Shopify) | docs-derived fixtures replayed through the real clients; scrub test | pass (simulated) |
| Provider contracts for Shiprocket, Zoom, Instagram, Meta Ads (P3) | not built | not run (gap) |
| Concurrency (broadcast dispatch, flow resume, forms, SLA, payment links, billing checkout) | [phase15-evidence.md](../testing/phase15-evidence.md) | pass |
| Worker recovery (SIGTERM drain, lease reclaim, fencing) | `src/lib/jobs/worker-recovery.integration.test.ts` | pass |
| Migration lint and checksums | `src/lib/db/migrations-lint.test.ts` (destructive and lock-heavy DDL, lock_timeout first), `prisma/migration-checksums.json` (125 migrations, append-only script) | pass |
| Test database guard | `src/lib/db/test-db-guard.test.ts`; a non-local URL is refused at setup | pass |
| E2E journeys (5 new specs) | T4 ran `signup-invite`, `second-tenant`, `whatsapp-inbound`, `payment-journey`, `privacy`: 13/13, twice, on local Docker | pass (task run) |
| Full Playwright suite (`npm run test:e2e:local`) | not run in the integration pass; it must confirm the e2e SMTP capture change does not affect the existing specs | not run |
| Production build (`npm run build`) | not run in the integration pass | not run |

## Performance

| Item | Evidence | Result |
|---|---|---|
| Pilot profile (2 tenants × 5k contacts, 5k conversations, 100k messages, plus a noise tenant) | `npm run perf:seed` + `npm run perf:measure` on local Docker, 20 warm-ups + 200 runs ([perf-2026-11-05.md](../testing/perf-2026-11-05.md)). p95: inbox load 1110 ms (target 1500), contact search 20 ms (300), CRM contacts page 19 ms (2000, aim 500), booking schedule week 79 ms (2000, aim 500), analytics 30-day overview 199 ms (1500), inbound webhook to visible 87 ms (4000 + 1 s polling = 5 s, 100 runs). Laptop, database on the same machine: Railway network latency not included | pass |
| Reminder scheduling lag (due to enqueued ≤ 60 s) | not measured in this pass | not run |
| Stress profile (informational: 2 tenants × 50k contacts and conversations, 500k messages) | [perf-2026-11-05-stress.md](../testing/perf-2026-11-05-stress.md), 3 runs: inbox load about 62 s (scale limit: the inbox loads every conversation; server-side paging is the first full-release item); search 47 ms, CRM page 39 ms, schedule 682 ms, analytics 1012 ms, inbound 88 ms | recorded (scale limit) |
| Indexes | Pilot measurement met every target, so no conversation, contact or analytics index was added. Three partial indexes were added for `crm_ops_health()` (failed jobs, unknown intents, unprocessed receipts), which otherwise scans never-pruned tables every minute | n/a (ops indexes added) |
| Job claim/finish and drain | queue burst above | pass |

## Operations

| Item | Evidence | Result |
|---|---|---|
| Deep health (`/api/health?deep=1` + `HEALTH_TOKEN`) | `src/app/api/health/route.test.ts`, `src/lib/ops/health.integration.test.ts` | pass (local) |
| Worker heartbeat | `src/lib/jobs/heartbeat.integration.test.ts` | pass (local) |
| Alert hook (`OPS_ALERT_WEBHOOK_URL`) | `src/lib/ops/alerts.test.ts` with stubbed fetch | pass (simulated) |
| `HEALTH_TOKEN` and `PLATFORM_DATABASE_URL` on web | owner | owner-pending |
| External uptime monitor and Railway deploy notifications | [alerts.md](../runbooks/alerts.md) | owner-pending |
| Restore drill script | local rehearsal 2026-11-05: restore 10.1 s, total 25 s, migrate status up to date, preflight and tenant read pass | pass (local) |
| Production restore drill into staging (RPO ≤ 24 h, RTO ≤ 4 h) | [backup-restore.md](../runbooks/backup-restore.md) | owner-pending |
| Rollback rehearsal | [release-rollback.md](../runbooks/release-rollback.md) | owner-pending |
| Railway worker draining time ≥ `WORKER_DRAIN_MS` | owner | owner-pending |
| Feature-flag inventory | [feature-flags.md](feature-flags.md), enforced by `src/lib/ops/flags-inventory.test.ts` | pass |
| Runbooks | [docs/runbooks/README.md](../runbooks/README.md) | pass |
| Staging environment before merge | [pilot-plan.md](pilot-plan.md) §1 | owner-pending |

## Security

| Item | Evidence | Result |
|---|---|---|
| Tenancy suites and RLS sweep | Tests above | pass |
| Route coverage gap list | [tenancy-route-coverage.md](../testing/tenancy-route-coverage.md) | open gap (visible) |
| Secrets scrub of provider fixtures | `src/test/fixtures/providers/scrub.test.ts` | pass |
| CSRF/origin on mutations | fixture `signedRequest` sends real session, origin and CSRF headers; route suite and existing auth tests | pass |
| App role sensitive columns | RLS sweep pins the 12 reviewed token/secret columns the server needs; any new one or any password column fails | pass |
| Deep health leaks nothing | route test: no secret-looking strings, no hint of deep mode without the token | pass |

## Policy

| Item | Evidence | Result |
|---|---|---|
| Meta/WhatsApp Business policy review | owner, with date and reviewer | owner-pending |
| Razorpay policy review | owner | owner-pending |
| Product policy and legal text (`content/legal/*.md` is DRAFT; `TERMS_VERSION` unset) | owner | owner-pending |

## Privacy

| Item | Evidence | Result |
|---|---|---|
| Free-form sends outside the 24-hour window | resolved: `409 window_closed` before Meta (`send-message.test.ts`, `send-message.window.integration.test.ts`, `v1/messages/route.test.ts`) | pass |
| Opt-in evidence record (SEC-05) | not built | blocked (decide before live onboarding) |
| Opt-out keywords in local languages | English only | blocked (decide before live onboarding) |
| Per-contact erasure and closed-workspace purge | not built; manual procedure in [data-requests.md](../runbooks/data-requests.md) | blocked (decide before live onboarding) |
| Workspace export and deletion | unit and integration tests; privacy e2e (export needs storage) | pass (local) |

## Provider blockers (none of these is live)

| Capability | Status | Needs |
|---|---|---|
| WhatsApp Embedded Signup | approval-blocked | Meta Tech Provider approval |
| WhatsApp sends, templates, health | simulated (docs-derived contracts) | a pilot number on Cloud API |
| Token revoked on send (Meta 190) | resolved for detection: a send refused with 190 / 401 marks the number `health_error='token'` at once and alerts owners and admins once (`health-sync.integration.test.ts`, `meta-api.token-health.test.ts`). Remaining: a running broadcast cannot be paused or stopped on the first token error | owner decision on broadcast pause/stop ([token-revocation.md](../runbooks/token-revocation.md)) |
| Instagram (IG-01, IG-02) | approval-blocked | Meta App Review |
| Meta Ads sync, insights, leads (ADS-01, 02, 04) | approval-blocked | Meta App Review |
| Conversions API (ADS-06) | provider-gated | per-tenant dataset and token |
| Zoom (APT-05) | provider-gated | `ZOOM_ENABLED`, app keys |
| Shiprocket (FUL-02) | provider-gated | tenant credentials |
| SaaS billing (BIL-02) | provider-gated | `BILLING_RAZORPAY_*` |
| Tenant payments (PAY-01..03, COM-05) | simulated | first pilot transactions reconciled |
| AI (AI-01, AI-02) | provider-gated | provider keys, policy review |

## Bugs found and fixed in Phase 15

| Bug | Fix | Guard |
|---|---|---|
| Refund delivered before its payment settled was lost | `settle.ts` syncs provider refunds after settling | payments ordering suite |
| Paid subscription charge on a cancelled/older subscription vanished | `charge_unapplied` reconciliation item | billing ordering suite |
| Paid charge on a superseded checkout vanished (cancelled at the provider, no item) | same `charge_unapplied` item in the stray branch | `subscriptions.integration.test.ts` |
| One unapplied charge opened two reconciliation items (`subscription.charged` and `invoice.paid`) | item keyed `charge:<payment id>` with payment id, invoice id and amount in its detail | `subscriptions.integration.test.ts` |
| `crm_ops_health()` scanned never-pruned tables every minute under a 2 s timeout | three partial `CREATE INDEX CONCURRENTLY` migrations | `rls-sweep.integration.test.ts` (function), deploy note in railway.md |
| Ops policy migration locked `jobs` and `outbound_intents` together (deadlock / P3009 risk) | split into one guarded migration per table; nothing runs for a superuser or BYPASSRLS owner | migration lint (now flags lock-heavy DDL, incl. inside `DO`) |
| Worker held the process past the drain bound while a job kept a pooled connection | exit before `$disconnect()` on a timed-out drain | none automated (`worker.ts` main is not under test; the drain bound itself is in `worker-recovery.integration.test.ts`) |
| Alert hook flapped at the threshold | non-down changes sent after two consecutive checks | `alerts.test.ts` |
| Inbound receipts exhausted to `failed` left health `ok` | `unprocessed15m` > 0 is `degraded` and a failing check | `health.test.ts`, `alerts.test.ts` |
| Remote test runner passed shell database URLs through | `remote-test-db.cjs` drops every `*DATABASE_URL*` | `test-db-guard.test.ts` |
| Checksum script re-recorded edited deployed migrations | append-only, `--rewrite <name>` needed | manual run (exit 1 on a changed file) |
| Route list test passed when every list refused; mutation refusals had no positive control; media fixture was not in the library | list status 200 + own-id control; per-case fresh-pair mutation control; fixture fixed | `cross-tenant.routes.integration.test.ts` |
| RLS sweep missed a permissive bypass policy | app/PUBLIC permissive policies must start with the tenant clause in a top-level AND | `rls-sweep.integration.test.ts` (with probe policies) |
| Restore drill passed a partly loaded dump or one with no accounts | every counted table and a passing tenant read required | `restore-drill-args.test.ts` |
| Broadcast recipient marked `sent` could be overwritten to `failed` | `deliverBroadcast` never downgrades a sent row | broadcast dispatch concurrency suite |
| Member/ownership changes for a non-member answered 400 | `P0002` → 404 | memberships and contract suites |
| Foreign storage key answered 400 | `ForbiddenError` → 403 | storage policy and media route tests |
| Ten routes answered foreign ids with 200/400/409 | 404 (quick replies, automations, AI knowledge, broadcast schedule, segment contacts, contact identities, order returns and shipment) | route suite; unit tests updated |
| Malformed provider id in a WhatsApp webhook retried to the attempt limit | skipped as unroutable | `process-webhook.status-retry.test.ts` |
| `queue-burst.load.test.ts` used the remote test database | local-only, opt-in | test database guard |

## Sign-off

| Role | Name | Date | Decision |
|---|---|---|---|
| Owner (merge / deploy) | | | |
| Owner (pilot go / no-go) | | | |
