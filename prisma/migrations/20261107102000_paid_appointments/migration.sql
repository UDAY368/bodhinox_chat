-- Phase 8: paid appointments (design E15). A public hold of a paid service
-- waits for a verified payment before it is confirmed. Additive: each
-- redefined CHECK is a superset of 20261106100000_appointments.

-- A service may require payment only with a price (the app role can update
-- payment_required, so the database enforces the price).
ALTER TABLE appointment_services DROP CONSTRAINT appointment_services_payment_required_check;
ALTER TABLE appointment_services ADD CONSTRAINT appointment_services_payment_price_check
  CHECK (NOT payment_required OR (price_minor > 0 AND currency IS NOT NULL));

-- none: not collected online (free, or staff booked); pending: waiting for the
-- link to be paid; paid / refunded: set by the worker after settlement.
ALTER TABLE appointments ADD COLUMN payment_status text NOT NULL DEFAULT 'none'
  CHECK (payment_status IN ('none','pending','paid','refunded'));
-- The app role has no UPDATE grant on payment_status (worker only) and may only insert 'none'.
CREATE FUNCTION appointments_payment_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'bodhinox_app' AND NEW.payment_status <> 'none' THEN
    RAISE EXCEPTION 'appointment_payment_status_forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER appointments_payment_status_guard BEFORE INSERT ON appointments
  FOR EACH ROW EXECUTE FUNCTION appointments_payment_status_guard();

CREATE INDEX appointments_payment_pending_idx ON appointments (account_id)
  WHERE status = 'held' AND payment_status = 'pending';

ALTER TABLE appointment_events DROP CONSTRAINT appointment_events_kind_check;
ALTER TABLE appointment_events ADD CONSTRAINT appointment_events_kind_check CHECK (kind IN ('held','confirmed','rescheduled',
  'reassigned','cancelled','expired','completed','no_show','feedback','reminder_skipped',
  'payment_pending','payment_captured','late_payment'));

ALTER TABLE appointment_messages DROP CONSTRAINT appointment_messages_kind_check;
ALTER TABLE appointment_messages ADD CONSTRAINT appointment_messages_kind_check CHECK (kind IN ('confirmation','reminder_24h',
  'reminder_2h','cancelled','rescheduled','feedback','rebook','payment_link'));
