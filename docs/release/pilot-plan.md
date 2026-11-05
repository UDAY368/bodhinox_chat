# Pilot plan (owner actions)

Phase 15 built the tests, operations code and evidence that can be built inside the repository. Everything below needs the owner: production access, provider accounts, approvals or real tenants. Agents have no production access and must not take these steps.

**Merging is a production deploy.** A green push to `main` runs `prisma migrate deploy` against production and Railway then deploys web and worker. There is no staging environment yet.

## 1. Before merging Phase 15

Choose one and record the decision in the release checklist:

- **Preferred:** create a Railway staging environment first: separate Postgres, separate secrets, Razorpay **test** keys only, `HEALTH_TOKEN`, an alert webhook. Nothing migrates a new staging database for you (the CI migrate job runs only for `main`, against production), so before the first deploy: run `npm run db:migrate` with the staging `MIGRATION_DATABASE_URL`, then `npm run db:roles` with freshly generated staging role passwords and the staging `PLATFORM_DATABASE_URL` (otherwise `/api/health` answers 503 and the deep check has no platform login). Deploy from a `codex/**` branch or an open pull request, so CI has run before Railway's "Wait for CI" lets the branch deploy go. Then run the deep health check and the smoke journeys, then merge.
- **Or:** accept merging straight to production. The migrations are additive and the release is rollback-safe ([release-rollback.md](../runbooks/release-rollback.md)), but nothing will have run on Railway before production.

In either case, take a Railway Postgres backup before the merge (the migrations run on production).

## 2. Operations setup

1. Set `HEALTH_TOKEN` (at least 32 random characters) on the web service and confirm `PLATFORM_DATABASE_URL` is set there. Setting `PLATFORM_DATABASE_URL` on web also turns the platform admin console on (unsetting it is how the console is turned off, docs/deployment/railway.md); record that as an explicit decision. Without it the deep check stays `degraded` (`"ops":"unconfigured"`).
2. Create the external uptime monitors from [alerts.md](../runbooks/alerts.md): plain `/api/health` and the deep check with the bearer header. Turn on Railway deploy-failure notifications for web and worker.
3. Optional: set `OPS_ALERT_WEBHOOK_URL` on the worker.
4. Set the worker's Railway draining time to at least `WORKER_DRAIN_MS` (25 s by default).
5. Run the Railway restore drill into staging or a new service (never over production) and record RPO/RTO in the drill log ([backup-restore.md](../runbooks/backup-restore.md)). Targets: RPO ≤ 24 h, RTO ≤ 4 h.
6. Run the local rollback rehearsal in [release-rollback.md](../runbooks/release-rollback.md) and record it in the checklist.

## 3. Provider keys and approvals, in order

| Order | Provider | What | Unblocks |
|---|---|---|---|
| 1 | Meta | Pilot tenant's WhatsApp Cloud API number connected manually (no approval needed); webhook subscribed; one approved utility template | WA-01, WA-04 for the pilot |
| 2 | Razorpay (tenant) | Pilot tenant's own Razorpay keys in **test mode**; reconcile a test payment and refund end to end; then switch to live keys | PAY-01..03, COM-05 |
| 3 | Google | OAuth client for Google sign-in (optional) | TEN-03 Google part |
| 4 | Meta | Tech Provider approval for Embedded Signup | WA-01 self-serve onboarding |
| 5 | Razorpay (platform) | `BILLING_RAZORPAY_*` on a separate Razorpay account | BIL-02 |
| 6 | Zoom, Shiprocket | App keys / tenant credentials, only if the pilot needs them | APT-05, FUL-02 |
| 7 | Meta App Review | Instagram messaging/comments, Ads (ads_read, leads_retrieval) | IG-01, IG-02, ADS-01, ADS-02, ADS-04 |
| 8 | AI provider | Keys and per-workspace enablement, only after the policy review | AI-01, AI-02 |

## 4. Decide before live onboarding

These are known gaps, not bugs the tests can close:

- **Opt-in evidence:** there is no purpose-specific opt-in record (SEC-05). Decide how consent is captured before broadcasting to real customers.
- **Opt-out keywords** are English only (`src/lib/contacts/consent.ts`). Decide whether the pilot needs local-language keywords.
- **Per-contact erasure** across messages, media and broadcast recipients does not exist; [data-requests.md](../runbooks/data-requests.md) has the manual interim procedure. The closed-workspace purge is not built.
- **Broadcast pause / stop on the first token error:** a send that gets Meta 190 / 401 now marks the number's health and alerts owners and admins at once ([token-revocation.md](../runbooks/token-revocation.md)), but a campaign already sending cannot be paused or stopped, and its pass keeps failing recipient by recipient until it ends. Only campaigns that have not started can be cancelled. Decide whether to build a broadcast pause, or stop the pass on the first token error leaving the rest `pending`, before the pilot.
- **Policy review:** Meta/WhatsApp Business, Razorpay and product policies, with date and reviewer, recorded in the checklist.
- **Performance:** every pilot-profile target passes on local Docker ([perf-2026-11-05.md](../testing/perf-2026-11-05.md): 2 tenants × 5k contacts, 5k conversations, 100k messages; inbox load p95 1.11 s against 1.5 s). The inbox still loads every conversation, so its time grows faster than the conversation count: at the stress profile (50k conversations per tenant) one inbox load took about 62 s ([perf-2026-11-05-stress.md](../testing/perf-2026-11-05-stress.md), informational). The numbers exclude Railway's network latency. Compare the pilot's real volumes with that profile before onboarding a second tenant; reminder scheduling lag was not measured.

## 5. Pilot

- **Tenant:** one small business with a WhatsApp number already on Cloud API, expected volumes well inside the pilot profile.
- **Success criteria:** inbound messages visible within 5 s, no lost or duplicated sends, every payment and refund reconciled against Razorpay daily, no cross-tenant data, no SEV1.
- **Daily for two weeks:** reconcile transactions (Payments → Exceptions, billing reconciliation console), compare reports with the business's own records, read the deep health history.
- **Second tenant:** onboard after one clean week to validate SaaS separation and onboarding; run `e2e/second-tenant.spec.ts`-style checks by hand (each tenant sees only its own data).
- **Go / no-go and rollback:** any SEV1, any cross-tenant exposure, or an unreconciled payment stops the pilot; roll back per [release-rollback.md](../runbooks/release-rollback.md).

## 6. After the pilot

Turn pilot findings into a prioritized full-release backlog. First candidates: server-side inbox paging (the inbox loads every conversation; about 62 s at 50k conversations), per-contact erasure and opt-in evidence, the 64 dynamic routes without a cross-tenant case, the P3 provider contract and ordering tests (Shiprocket, Zoom, Instagram, Meta Ads), a reminder-lag measurement, and a measurement on Railway itself.
