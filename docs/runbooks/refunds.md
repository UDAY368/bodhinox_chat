# Refunds

Requirement ids: PAY-03, COM-05. Env var names only; no secrets, tenant ids or customer content belong in this file or in incident notes.

Moved from `docs/deployment/railway.md` (Commerce section) in Phase 15.

## Exception queue and refund rules

- **Exception queue**: check Payments → Exceptions daily during the pilot; a `refund_unknown` must be checked with Razorpay ("Check with Razorpay") before any manual action; it is never re-sent automatically.
- **Stale refund attempt** (`refund_unknown`, detail `stale_attempt_processed`, subject `provider_refund:<rfnd id>`): Razorpay reported an earlier, superseded attempt of a retried refund as processed. That money is neither counted nor dropped and the live attempt is unchanged. Staff reconcile it by hand in Razorpay; it is never cleared automatically, even when the payment later shows fully refunded. Each attempt now has its own Razorpay receipt (`<refund id>:<attempt>`) and `notes.attempt`.
- **Refund restock rules**: a refund not linked to a return restocks only an order that has not been dispatched and is being unwound (cancelled, or refunded in full); a partial refund of an order that still ships restocks nothing (use a return). Once the order-level `refund_restocked` event exists nothing restocks that order again, including closing a return. Closing a return with restock refuses (409) while its refund is still in flight, and restocks after a failed refund. Restocking a payment-review order (exception "restocked") is refused while any refund on that payment is in flight. Dispatch is refused (409) while a whole-order restocking refund is in flight. One refund per return (unique index `customer_refunds_return_key`).
- **Credit notes** are issued only for a payment that has a receipt; refunds of exception or unattached payments get no credit note and use no series number. Partial credit notes reverse tax cumulatively, so they add up to exactly the order's tax.
- **Cancel and refund with offline money**: an order paid wholly or partly offline, or a legacy paid order with no payment record, is refused with 409 `offline_payment` until staff confirm they returned that money outside the app (`refunded_outside: true`, the confirm box in the order panel). The offline part is then recorded as an `external` refund. Recording an offline payment is refused while a paid payment link on the order is still settling.

## Partial refunds, dashboard refunds and chargebacks


- **Partial refunds:** supported. Each refund is counted once when it reaches `processed`. The order's `refund_state` is `partial` until the refunded total reaches the amount paid, then `full`. A partial refund does not restock; use a return for that.
- **Dashboard refunds:** a refund made in the Razorpay dashboard is recorded as `external` when `refund.processed` arrives. It is also recorded when the payment settles later (B1 fix) or when Razorpay's refund list is synced.
- **Chargebacks and disputes:** the code has no dispute handling. Razorpay `payment.dispute.*` events are not subscribed and nothing records them. Handle chargebacks in the Razorpay dashboard and record any money returned as an offline or external note on the order. This is a known gap for the full release.
- **Verification:**
  - the order shows the refunded amount and state;
  - the credit note job ran (`commerce.issue_credit_note`) for a payment that had a receipt;
  - Payments → Exceptions is empty for the order.
