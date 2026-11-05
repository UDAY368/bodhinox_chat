# Phase 15 test evidence: ordering, contracts, concurrency, recovery and journeys

All results are from the local Docker test database (`pgvector/pgvector:pg18`, 127.0.0.1:55432) on 2026-11-05. Nothing ran against production or the remote test database. Provider contracts are docs-derived (status `simulated`), never "verified against provider". The requirement-level view is in [requirement-to-test.md](../release/requirement-to-test.md).

## Inbound ordering, duplicates and provider contracts (T3)

### 1. What was built

#### Ordering and duplicate suites (design 1.3)

All of these are `*.integration.test.ts` and ran on local Docker. Each uses `fixtureDatabaseUrls()` from `src/test/tenancy/fixtures.ts` for `describe.skipIf`, so it never loads `.env.test`.

| P | Provider | File | Cases | Result |
|---|---|---|---|---|
| 1 | WhatsApp | `src/lib/whatsapp/ingest.integration.test.ts` (extended) | 5 concurrent statuses race the outbound row's commit, then early ones are retried → ends `read`, one read job | pass |
| 1 | Razorpay commerce | `src/lib/payments/payments-webhook.ordering.integration.test.ts` | all 6 orders of `payment_link.paid` / `refund.processed` / `payment.failed` (ignored) equal the in-order state; 5 identical + 5 redelivered copies of paid and refund, jobs run concurrently → one payment, one refund, one receipt, one credit note | pass (after fix B1) |
| 1 | Razorpay billing | `src/lib/billing/billing-webhook.ordering.integration.test.ts` | all 6 orders of activated / charged / stale pending → active, one invoice; all 6 orders of activated / charged / cancelled (provider already cancelled) → never a silent paid charge; 5 + 5 concurrent `subscription.charged` → one invoice; 5 concurrent checkout starts → one intent, one provider subscription | pass (after fix B2) |
| 2 | Shopify | `src/lib/integrations/shopify/webhooks.ordering.integration.test.ts` | replays the corpus payloads through the signed route; all 6 orders of create / paid / fulfilled; 5 concurrent copies of one `X-Shopify-Webhook-Id` → one recorded, four duplicates; 5 concurrent redeliveries → one event; forged signature → 401 | pass |
| 2 | WooCommerce | `src/lib/integrations/woocommerce/webhooks.ordering.integration.test.ts` | replays the corpus payloads through the signed route; all 6 orders of created / paid / completed; 5 concurrent copies of one delivery id and 5 redeliveries → one event | pass |
| 3 | Meta Ads leads | `src/lib/meta-ads/leads.ordering.integration.test.ts` | 5 concurrent Page deliveries naming one `leadgen_id`, jobs run concurrently → one lead, one fetch, one Graph call, one contact | pass |
| 3 | Zoom | not built (gap) | ended before started; concurrent duplicate | deferred: provider-gated (`ZOOM_ENABLED`). `zoom-webhook.integration.test.ts` already covers sequential duplicates and "latest ended wins". |
| 3 | Instagram | not built (gap) | edit, unsend or read before message; concurrent duplicate | deferred: provider-gated (`INSTAGRAM_ENABLED`). `instagram/ingest.integration.test.ts` covers sequential duplicates. |

Jobs are drained with `drainJobs()` in `src/test/fixtures/providers/drain.ts`. It deletes only the suite's own jobs (by tenant id, or by a payload id for tenantless jobs) and runs them through the real `handleJob`. A global `claimJob()` would take the jobs of other suites sharing the test database.

#### Concurrency (design 1.5, T3 rows)

- `src/lib/payments/links.concurrency.integration.test.ts` [PAY-01]:
  - 6 agents create a link for one order at once → one live link and one Razorpay create; the other 5 get `link_exists`.
  - 5 replays of one request → one link and one create; a replay that overlaps the create in flight may get `busy`, never a second link.
- Billing checkout race: in the billing ordering file above (5 concurrent `startCheckout` → one `billing_intents` row, one provider subscription, 4 × `pending`).

#### Provider contract corpus and tests (design 1.4)

- Corpus: `src/test/fixtures/providers/<provider>/<case>.json` for `whatsapp` (11), `razorpay` (11), `razorpay-billing` (5), `google` (4), `shopify` (9), `woocommerce` (3).
  - Every fixture is `docs-derived` and synthetic.
  - Emails are at `example.com`.
  - Mobiles are in the reserved test range `98000 00000` to `98000 99999`.
  - No token appears anywhere. The Google `id_token` is signed at test time.
- `src/test/fixtures/providers/README.md` covers the file shape, capture and scrubbing.
- `src/test/fixtures/providers/scrub.test.ts` [SEC-01] checks provenance fields on every fixture and refuses:
  - token-like strings: `EAA…`, `rzp_live_`, `shpat_`, JWTs, bearer or basic credentials;
  - emails outside `example.com`;
  - Indian mobiles outside the reserved range.

  It also checks that every P1 and P2 provider has fixtures.
- Outbound contract tests (unit stage) replay the fixture responses through the real clients with a recording fetch stub:

  | Test | Requirements | What it pins |
  |---|---|---|
  | `src/lib/whatsapp/meta-api.contract.test.ts` | [WA-01] [WA-04] | send text, template and media; template create; errors 190, 131047, 132001, 368 and 429/80007 read into a classified `MetaApiError`; 190 classed as `token` by `categorizeHealthError`; 80007 is in `THROTTLE_CODES` |
  | `src/lib/payments/razorpay.contract.test.ts` | [PAY-01] [PAY-02] [COM-05] | link create, fetch and payments; refund create and list; duplicate reference, 400, 401 and 5xx = `unknown`; webhook verification and parsing without customer details |
  | `src/lib/billing/razorpay-billing.contract.test.ts` | [BIL-02] | customer, subscription create, fetch and cancel; 400, 401 and 5xx; `subscription.charged` parse |
  | `src/lib/auth/google-oidc.contract.test.ts` | [TEN-03] | discovery, PKCE authorization URL, token exchange form, ID token verification, `invalid_grant` vs 5xx |
  | `src/lib/integrations/shopify/admin-api.contract.test.ts` | [CAP-01] | OAuth code exchange, webhook registration with 422 "already taken" counted as done, 401, revoke |
- Inbound fixture replays, signed with a test secret:
  - `src/app/api/whatsapp/webhook/receipt.test.ts` [WA-01]
  - `src/app/api/payments/razorpay/webhook/[accountId]/route.test.ts` [PAY-02]
  - `src/app/api/billing/webhook/route.test.ts` [BIL-02]
  - Shopify and WooCommerce are replayed through their real routes in their ordering suites.
- Not built (P3, provider-gated, listed as gaps): contract tests for `fulfilment/shiprocket-client.ts`, `meetings/zoom-client.ts`, `instagram/graph.ts` + `graph-limits.ts`, `meta-ads/graph.ts`, `capi.ts` and `leads-http.ts`.

Evidence wording: "docs-derived contract", never "verified against provider".

### 2. Bugs found and fixed (root cause, with regression test)

- **B1 (`src/lib/payments/settle.ts`): a refund delivered before its payment settled was lost.**
  - **How it happened.** `refund.processed` ran `syncProviderRefunds`, which found no `customer_payments` row yet and returned. The receipt was then marked processed. When the delayed `payment_link.paid` settled the payment, nothing re-read the refunds, so the order kept `amount_refunded_minor = 0` and `refund_state = none`. No credit note was issued, and the reconcile sweep only revisits refunds we already know about.
  - **Fix.** After settling a newly recorded payment, `verifyAndSettle` calls `syncProviderRefunds` when Razorpay reports `amount_refunded > 0`. This is idempotent per provider refund id.
  - **Guard.** `payments-webhook.ordering.integration.test.ts`: the reorder matrix and the concurrent case.
- **B2 (`src/lib/billing/subscriptions.ts`): a paid subscription charge could vanish without an invoice or a reconciliation item.**
  - **How it happened.** This hit a subscription that was cancelled before its events were processed, and a charge on an older subscription than the workspace's current one. `applyProviderState` changed nothing, issued no invoice and marked the event processed with no error.
  - **Fix.** Such a charge now marks the event with a reconcile message and opens an `event_error` reconciliation item with reason `charge_unapplied`. This uses the existing kind, so no migration is needed, and the item shows in the platform reconciliation console. Nothing is invoiced or refunded automatically.
  - **Guard.** `billing-webhook.ordering.integration.test.ts`, "never leaves a paid charge silent".
  - **Follow-up, fixed during integration.** A paid charge on a stray subscription (a superseded checkout) is still cancelled at the provider, and now also opens the same `charge_unapplied` item (`handleBillingEventJob`; guard in `subscriptions.integration.test.ts`, "cancels a superseded checkout…").

### 3. Deviations from the design

- **Razorpay commerce event set.** The design named `refund.processed` before `payment.captured`, `payment.failed` after capture, and concurrent `payment.captured`. The webhook route ignores every `payment.*` event by design (E16): it acknowledges them and records nothing. The matrix therefore uses `payment_link.paid` (the event that triggers settlement), `refund.processed`, and `payment.failed`, which is checked to have no effect in any position.
- **Billing.** The design's "one usage-ledger entry" per charge does not apply: a subscription charge writes an invoice, not a `usage_ledger` row. The suite checks one invoice.
- **Draining jobs.** It uses `drainJobs()` (the suite's own jobs plus the real `handleJob`) instead of `claimJob()` + `finishJob()`, because `claimJob()` takes any pending job in the shared test database. Nothing else differs.
- **P3.** The Zoom and Instagram ordering suites and the P3 contract tests are deferred (section 1).
- **Shopify and WooCommerce inbound replay.** Their route folders belong to T2, so the replay lives in my ordering suites, which import the routes read-only.

## Concurrency, worker recovery, 24-hour window and journeys (T4)

### 2. Bug found and fixed (root cause)

**A broadcast recipient already marked `sent` could be overwritten to `failed`.** Two dispatch passes on one campaign (possible after a stale 30-minute delivery lock is taken over while the first pass is still running) race on one recipient: the losing pass finds the send intent still `dispatching`, gets `UncertainDispatchError`, and its `failed` update could land after the winning pass wrote `sent`. Meta had delivered the message, but the campaign showed it as failed with "Send outcome uncertain", and the trigger-maintained counts moved the wrong way.
- Fix: `src/lib/whatsapp/broadcast-core.ts`, `deliverBroadcast`: the `failed` update is now `.neq('status', 'sent')`, so a row another pass marked sent is never downgraded.
- Regression test: "a pass that finds another pass mid-send leaves that pass's sent row alone" in `broadcast-dispatch.concurrency.integration.test.ts` (fails without the fix, passes with it).
- Sends were never duplicated: the outbound intent (`dispatchOnce`) already allowed one send per recipient under 2 and 3 concurrent passes.

### 3. Behaviour change: 24-hour window guard for free-form sends (release-checklist privacy/policy item)

`sendMessageToConversation` (`src/lib/whatsapp/send-message.ts`), used by `POST /api/whatsapp/send` (inbox) and `POST /api/v1/messages` (public API), now refuses any non-template send (text, media, interactive) when the conversation has no customer message in the last 24 hours:
- error `SendMessageError('window_closed', 'The 24-hour customer service window is closed. Send an approved template instead.', 409)`;
- checked after the conversation, channel and number checks, before the bot is paused, before any form session or intent, and before Meta is called;
- templates are unaffected (no window read at all);
- the rule is the same one catalogue, form and payment-link sends already apply (last `sender_type='customer'` message, 24 hours), reusing `getSessionWindow` from `src/lib/inbox/session.ts`. Business and bot messages do not open the window.

Before this change, such a send reached Meta, which rejects it (error 131047), and the caller got `502 meta_error`. The inbox composer already disables free-form input when the session is expired, so dashboard users see no difference; public API clients now get `409 window_closed` instead of `502 meta_error`.

Docs to update (T1):
- `docs/public-api.md`, `POST /api/v1/messages` errors: add `409 window_closed` (free-form message outside the 24-hour customer service window; send a template).
- Feature inventory (`docs/architecture/bodhinox-functionality.md`), WhatsApp sending: "free-form sends are refused outside the 24-hour window before calling Meta (409 window_closed)".
- Release checklist, Privacy/Policy: the "free-form send path has no 24-hour window check" blocker is resolved (evidence: the two tests above). Opt-in evidence, localized opt-out keywords and per-contact erasure remain open.

### 4. Recorded behaviour and gaps (worker recovery, 1.6)

- SIGTERM drain (`runWorkerLoop`, T5): verified. After abort no new job is claimed (the next due job stays `pending`, 0 attempts); the in-flight job finishes and is marked `done`. When the job outlives `drainMs`, the loop returns `drained: false`, the job stays `running` until its lease expires, another worker reclaims it (attempt 2, new lease token), and the old run's late `finishJob` is fenced by the lease token. No job is lost.
- WhatsApp token revoked (Meta 190, HTTP 401) during a broadcast pass: each recipient is tried once (no phone-variant retry), marked `failed` with Meta's message, its intent is `failed` (never `unknown`, so nothing waits on reconciliation), the campaign settles to `failed`, the job completes, and no follow-up dispatch job is queued. No tight retry loop.
- **Gap (not built, owner decision; listed in the release checklist and pilot plan):** a 190 on a send does not mark the number's health. Only the six-hourly health sync records `health_error='token'` (verified by the same test file: the number stays `connected`, `health_error='token'`). So until the next sync, every send in a revoked-token workspace fails per message, and a 1,000-recipient campaign makes 1,000 failing calls (paced at ~6/s). Smaller option: in `dispatchOnce` (T5, `src/lib/jobs/dispatch.ts`) or the WhatsApp send helpers, record `health_error='token'` on the sending number when Meta answers 190/401, and in `deliverBroadcast` stop the pass on the first token error leaving the rest `pending` (held like a disconnected number). Listed for the token-revocation runbook.
- Instagram 190/401 -> `token_invalid` and Zoom revoked grant: existing tests, see section 1.

### 5. Concurrency results (1.5)

- Broadcast: two `broadcast.dispatch` jobs on one campaign: one pass sends, the other re-queues a `wait` job; 4 recipients -> 4 sends, 4 accepted intents, lock released. A redelivered job after the pass sends nothing. Three passes on the same plan (stolen stale lock): one send per recipient, every row `sent` (after the fix above).
- Flow resume: reply x2 + timeout timer x2 on one waiting run: exactly one path moves it (transition_seq 1 -> 2), one `completed` event, at most one `timeout` event. Payment `paid` x3 + `expired` x2: one outcome wins, one `payment_*` event, one completion. Timer redelivered x5: fires once.
- WhatsApp Forms: the same delivery x5 at once -> one message, one response row, one inbound job. Five different submissions of one `flow_token` at once -> all five stored (the existing "second submission is kept but not trusted" rule), exactly one trusted, session completed once.
- Inbox SLA: five agents replying and claiming at once -> exactly one assignee, first reply stamped; five overlapping SLA sweeps -> one breach notification per member per cycle; close + customer message + reply + claim + sweep racing -> consistent state (closed is resolved; an open conversation is answered or has exactly one due time; no duplicate alerts). The SLA "timer" is the `first_response_due_at` column on the conversation, so a second timer cannot exist; `first_responded_at` stops it (the due time is kept).
- Payment links and billing checkout concurrency are T3's.

### 6. End-to-end journeys (1.9) and harness changes

What each spec proves is in its header comment. Statuses for the evidence doc:
- `signup-invite.spec.ts`: real sign-up form, verification mail read from a local SMTP capture, sign-in reaches `/dashboard` without an MFA step (owner); invited sign-up joins the inviting workspace as `agent` with no workspace of its own (regression for cc6dbcb); a used invitation is refused. `verified`.
- `second-tenant.spec.ts`: two workspaces in two browser contexts; contacts and inbox show only their own rows; the other workspace's order id shows "doesn't exist or isn't in this workspace", its conversation id in `/inbox?c=` shows nothing of it, and `GET /api/commerce/orders/<other id>` answers 404 with no data. `verified`.
- `whatsapp-inbound.spec.ts`: unsigned and wrongly signed deliveries -> 401, nothing stored; a signed text is stored and queued before the 200, a redelivery shares the receipt; the in-spec drain (`e2e/drain-whatsapp.ts`, only that receipt's `whatsapp.webhook` job) stores the message, the receipt becomes `processed`, and the message shows in the inbox; signed status webhooks delivered out of order (`read` then `delivered`) leave the tick at `read`. Agent replies are not sent in e2e (no provider mock; a reply would call graph.facebook.com); outbound is covered by contract tests. Inbound: `verified`; outbound reply: `simulated` elsewhere.
- `payment-journey.spec.ts`: tenant Razorpay webhook verified with the workspace's own secret, recorded and queued once (ids and amounts only), redelivery adds nothing; wrong signature, another workspace's secret, unknown or malformed account -> 401 and nothing stored; `payment.captured` acknowledged and ignored. Settlement (order paid) and refunds need Razorpay (the job re-reads the link with the workspace's keys) and are **not** exercised in e2e: `simulated` (T3's integration tests with a stubbed provider).
- `privacy.spec.ts`: export card says exports are unavailable without file storage (no request button); owner requests deletion with the type-the-name confirmation, the workspace goes `closing` with `purge_after` 30 days out, and the request is cancelled; an admin sees "Only the workspace owner can request deletion." Export itself: unit-tested only (`src/lib/jobs/workspace-export.test.ts`), so `partial` for e2e.

Harness changes (e2e only, never production):
- `scripts/e2e-server.cjs` now always sets `SMTP_URL=smtp://127.0.0.1:${E2E_SMTP_PORT:-3125}`, `AUTH_EMAIL_FROM=e2e@example.invalid` and a test-only `META_APP_SECRET` for the dev server it starts, and removes `META_APP_SECRET_PRIMARY`. With SMTP set, the notification preferences page offers email digests during e2e runs; no existing spec depends on SMTP being unset (checked by grep), but the first full `test:e2e:local` run should confirm.
- `e2e/global-setup.ts` starts the SMTP capture (`e2e/smtp-capture.ts`, 127.0.0.1 only, writes to `%TEMP%/bodhinox-e2e/mail`), `e2e/global-teardown.ts` closes it.
- `e2e/journeys.ts`: `seedWorkspace`/`removeWorkspaces` (throwaway workspaces, so the shared fixture workspace A never gets a WhatsApp number or payment keys), `mailTo`/`linkIn`, `metaSignature`/`razorpaySignature`, `whatsappDelivery`, `drainWhatsAppReceipts`.
- New specs create and delete their own workspaces and users; none changes workspace A.

## Observation fixed during integration

A signed WhatsApp delivery with a non-numeric `phone_number_id` (or WABA id on a template event) used to throw in `resolveWhatsAppAccount`, so its job retried to the attempt limit. `processWebhook` now treats such an id as unroutable and skips it (`process-webhook.status-retry.test.ts`, "unroutable provider ids"). The routing functions still refuse a malformed id for their other callers.
