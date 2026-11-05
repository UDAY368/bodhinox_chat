# Runbooks

Operational procedures for the pilot and the release. Each runbook names its detection signal (deep health field, platform console page or alert), impact, immediate steps, verification, customer communication and follow-up. They use env var names only.

| Runbook | Use when | Detection | Requirement ids |
|---|---|---|---|
| [incident-response.md](incident-response.md) | Anything SEV1–SEV3; start here | any alert | OPS-01, SEC-03 |
| [alerts.md](alerts.md) | Setting up or reading monitors | `/api/health`, deep check, `OPS_ALERT_WEBHOOK_URL` | OPS-01 |
| [delayed-jobs.md](delayed-jobs.md) | Worker not beating, backlog, stuck leases, reminder lag | deep `worker.ok`, `queue.*`, `webhooks.unprocessed15m`; console Health | OPS-01, OPS-02 |
| [provider-outage.md](provider-outage.md) | Meta, Razorpay, Zoom, Shiprocket, SMTP or S3 is down | deep `webhooks.unprocessed15m`, `intents.unknown`; console Integration health | OPS-01, WA-01, PAY-02 |
| [template-rejected.md](template-rejected.md) | A WhatsApp template is rejected | template status webhook, template list | WA-04 |
| [token-revocation.md](token-revocation.md) | A provider token is revoked or a secret rotates | number health `token`, Instagram `token_invalid` | WA-01, IG-01, ADS-01, APT-05, TEN-03 |
| [delayed-payments.md](delayed-payments.md) | Paid but unsettled orders, `unknown` intents, billing items | Payments → Exceptions, deep `intents.unknown`, console reconciliation | PAY-01..03, BIL-02 |
| [refunds.md](refunds.md) | Refund questions, partial refunds, chargebacks | Payments → Exceptions | PAY-03, COM-05 |
| [oversell.md](oversell.md) | A paid order has no stock | `late_payment_no_stock` exception | COM-02, PAY-02 |
| [data-requests.md](data-requests.md) | Export, deletion or end-customer privacy requests | owner or customer request | SEC-01, SEC-04 |
| [backup-restore.md](backup-restore.md) | Backups, restore drills, restore to production | owner schedule | OPS-01 |
| [release-rollback.md](release-rollback.md) | A release must be rolled back | SEV1/SEV2 after deploy | OPS-01, OPS-03 |

Related: [release checklist](../release/release-checklist.md), [pilot plan](../release/pilot-plan.md), [feature flags](../release/feature-flags.md), [Railway deployment](../deployment/railway.md).
