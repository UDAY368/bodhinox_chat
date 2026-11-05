# Delayed payments and billing reconciliation

Requirement ids: PAY-01, PAY-02, PAY-03, BIL-02. Env var names only; no secrets, tenant ids or customer content belong in this file or in incident notes.

- **Detection:**
  - Payments → Exceptions;
  - orders stuck in `awaiting_payment` with a paid link;
  - `payment_links` with status `unknown`;
  - deep health `intents.unknown`;
  - billing: the platform reconciliation console (`crm_platform_reconciliation_list` / `_resolve`) and workspaces in `past_due` or `grace`.
- **Captured but unpaid order:**
  - Settlement re-fetches from Razorpay with the workspace's keys, and the sweep retries paid links without a settled payment every 10 minutes.
  - If it stays stuck, use "Check with Razorpay" (reconcile) on the link. Do not mark the order paid by hand; there is no such action.
- **Exception kinds and what to do:**
  - `late_payment_no_stock`: restock, then accept; or refund.
  - `duplicate_payment`: refund the extra payment.
  - `amount_mismatch` / `currency_mismatch`: review, then refund or accept.
  - `merchant_changed`: the keys changed. Check in the old Razorpay account.
  - `payment_unmatched`: a paid reference with no link here.
  - `refund_unknown` / `refund_failed`: check with Razorpay before any action. They are never re-sent automatically.
- **Refund that arrives before its payment (fixed in phase 15).** Settlement now re-reads Razorpay's refund list, so the refund is counted once the payment settles.
- **Billing:**
  - `event_error` items with reason `charge_unapplied` mean Razorpay took a subscription charge the workspace was not invoiced for. Invoice it or refund it in Razorpay, then resolve the item.
  - Since Phase 15 the same `charge_unapplied` item is also opened when a charge arrives on a stray (superseded) checkout that the worker cancels at Razorpay; the event's error reads "Superseded checkout: cancelled at the provider, but a paid charge was taken…".
  - `invoice_unissued`: fix the billing configuration (seller state, GSTIN), then issue the invoice.
  - The workspace's `past_due` → `grace` → `suspended` lifecycle runs by itself; recovery happens on the next successful charge.
- **Never** clear `outbound_intents` or reconciliation items without the provider-side check.
