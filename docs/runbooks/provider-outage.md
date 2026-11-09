# Provider outage

Requirement ids: OPS-01, WA-01, PAY-02. Env var names only; no secrets, tenant ids or customer content belong in this file or in incident notes.

- **Detection:**
  - deep health `webhooks.unprocessed15m` above 0 or `queue.oldestDueS` rising: both make the deep check `degraded` and fire the worker alert hook (docs/runbooks/alerts.md);
  - Platform console → Integration health (`crm_platform_integration_health`) and Job backlog (`crm_platform_job_backlog`);
  - worker logs with error names only;
  - the provider's status page.
- **Impact:**
  - **Meta:** sends fail or are throttled. Inbound webhooks are stored first (`webhook_receipts`) and processed later, so inbound is delayed, not lost.
  - **Razorpay:** link creation returns `unknown`, and settlement and refunds wait.
  - **Zoom or Shiprocket:** sync pauses.
  - **SMTP:** sign-up verification, email change and password reset emails are sent inline, not queued: those requests answer 503 `email_delivery_failed` and users must retry after recovery. Notification digests (`inbox.notification_digest` job) retry on their next run.
  - **S3:** media mirroring falls back to the Meta proxy URL.
- **Immediate steps:**
  1. Confirm on the provider status page.
  2. Cancel (or reschedule) scheduled campaigns that have not started (Broadcasts, `DELETE /api/broadcasts/[id]/schedule`), because throttled passes back off but still use quota. A campaign already sending cannot be paused or stopped today; it backs off on throttling and ends on its own.
  3. Let job retries back off. Do not requeue by hand while the provider is down.
  4. Never clear `outbound_intents` rows. An `unknown` intent stays until it is reconciled, because a blind re-send can duplicate a customer message or a charge.
  5. Payment links created during the outage stay `unknown`. The reconcile sweep (`payments.reconcile_sweep`, every 10 minutes) looks them up by reference before it creates anything.
- **Verification after recovery:**
  - the backlog drains (Job backlog page);
  - `outbound_intents` with `status='unknown'` are reviewed in the conversation one by one;
  - campaign recipients whose send outcome is uncertain are listed on the campaign page ("sends need checking"); after checking WhatsApp Manager or the customer, an admin marks each as sent or not sent (`POST /api/whatsapp/broadcast/[id]/reconcile`, audited as `campaigns.recipients_reconciled`). "Retry failed" skips them until then, and sends a not-sent one once;
  - Payments → Exceptions is empty or reviewed;
  - the billing reconciliation console has no new `event_error` items.
- **Customer communication:** for a Meta outage, post a status note in the app; for a payments outage, tell affected customers their link will work once Razorpay recovers, or offer offline payment.
- **Follow-up:** write an incident timeline (incident-response.md) and record the outage window for reconciliation.
