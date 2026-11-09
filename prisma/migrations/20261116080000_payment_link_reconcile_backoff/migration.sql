-- Payment links are reconciled even when payment_link.paid webhooks never
-- arrive (audit finding 54). The reconcile sweep re-reads live 'created' and
-- 'partially_paid' links older than 30 minutes, including links with no
-- expiry, with a back-off: reconcile_checked_at records when the sweep last
-- asked Razorpay, and a link is asked again after a quarter of its age (at
-- most every six hours). Nullable, no default, no backfill.
-- Additive.
SET LOCAL lock_timeout = '5s';

ALTER TABLE payment_links ADD COLUMN reconcile_checked_at timestamptz;
