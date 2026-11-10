# Feature flags and operational switches

Every `*_ENABLED`, `*_DISABLED` and `*_DRY_RUN` variable the application reads must be listed here; `src/lib/ops/flags-inventory.test.ts` fails otherwise. "Production today" is what the owner must confirm in Railway; agents have no production access. Per-tenant pilot gating uses plan entitlements, not new flags.

| Variable | Read in | Default (unset) | Meaning | Production today | Decision owner | Gates |
|---|---|---|---|---|---|---|
| `AI_ENABLED` | `src/lib/ai/gate.ts` | AI allowed | `false`/`0`/`off` (any case) blocks every outbound AI call. Assistant features are also off per workspace until an admin enables them. | owner to confirm | owner | AI features |
| `ZOOM_ENABLED` | `src/lib/meetings/config.ts` | off | `true` enables Zoom meetings (also needs Zoom app keys). | owner to confirm (expected unset) | owner | APT-05 |
| `META_ADS_ENABLED` | `src/lib/meta-ads/config.ts` | off | `true` enables Meta Ads insights/leads (needs app review). | owner to confirm (expected unset) | owner | ADS-01..04, ADS-06 |
| `SHIPROCKET_DISABLED` | `src/lib/fulfilment/shiprocket-client.ts` | Shiprocket allowed where a tenant connects it | `true` is a kill switch for all Shiprocket calls. | owner to confirm | owner | FUL-02 |
| `WHATSAPP_TEMPLATES_DRY_RUN` | `src/app/api/whatsapp/templates/submit/route.ts`, `.../templates/[id]/route.ts` | off (real submission to Meta) | `true`/`1` stores templates without submitting to Meta. Must be unset in production. | owner to confirm (expected unset) | owner | WA templates |
| `INSTAGRAM_ENABLED` | `src/lib/instagram/config.ts` | off | `true` enables Instagram messaging (needs Meta app review). | owner to confirm (expected unset) | owner | IG-* |
| `INSTAGRAM_HUMAN_AGENT_ENABLED` | `src/lib/instagram/config.ts` | off | `true` only after Meta approves Human Agent. | owner to confirm (expected unset) | owner | IG-* |
| `WORKSPACE_PURGE_ENABLED` | `src/lib/privacy/workspace-purge.ts` (worker) | off (dry run) | `true` lets the daily `workspace.purge` job permanently delete closing workspaces past their 30-day grace. Off: it only logs the row counts it would delete. | not set (new) | owner | BIL-03, SEC-01 |
| `NEW_WORKSPACE_PLAN` | `src/lib/billing/new-workspace-plan.ts` | the lowest plan in the catalogue (`free`); never enterprise (audit finding 41) | Plan id for new workspaces. Existing workspaces are never changed. | owner to confirm | owner | BIL-* |
| `TERMS_VERSION` | `src/lib/auth/*` | no terms checkbox/banner | Published terms version. | owner to confirm | owner | SEC-04 |
| `BILLING_RAZORPAY_KEY_ID` / `_KEY_SECRET` / `_WEBHOOK_SECRET` | `src/lib/billing/**` | SaaS billing off | Implicit "configured" gate. | owner to confirm | owner | BIL-02 (provider-gated) |
| Tenant Razorpay settings | `payments/razorpay/settings` | per workspace | Implicit gate per tenant. | per tenant | tenant admin | PAY-* |
| Google sign-in keys | `src/lib/auth/google-oidc.ts` | off | Implicit gate. | owner to confirm | owner | TEN-03 |
| Shopify app keys | `src/lib/integrations/shopify/**` | off | Implicit gate. | owner to confirm | owner | commerce integrations |
| `HEALTH_TOKEN` | `src/lib/ops/health.ts` | deep health off | ≥ 32 chars enables `/api/health?deep=1` with a bearer header. | not set (new) | owner | OPS-01 |
| `HEALTH_WORKER_DOWN_S` / `HEALTH_OLDEST_DUE_DEGRADED_S` / `HEALTH_UNKNOWN_INTENTS_DEGRADED` | `src/lib/ops/health.ts` | 90 / 300 / 0 | Deep-health thresholds. | not set (defaults) | owner | OPS-01 |
| `OPS_ALERT_WEBHOOK_URL` | `src/lib/ops/alerts.ts` (worker) | off | https URL for status-change alerts. | not set (new) | owner | OPS-01 |
| `WORKER_DRAIN_MS` | `src/lib/jobs/worker-loop.ts` | 25 000 | Upper bound for the in-flight job after SIGTERM. Railway draining time for the worker must be at least this. | not set (default) | owner | OPS-01 |
| `WORKER_CONCURRENCY` | `src/lib/jobs/worker-loop.ts` | 3 | Job slots in the worker: one main slot for short jobs in queue order, the rest for long-running jobs (campaign passes, crawls, reports, exports). 1 is the old single lane. Keep below `DB_POOL_SIZE`. | not set (default) | owner | audit 10/37 |
