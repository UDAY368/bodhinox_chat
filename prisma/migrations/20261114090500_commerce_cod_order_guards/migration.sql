-- Cash on delivery, part 6: the order triggers learn COD.
-- orders_status_guard: a priced order still reaches dispatched or delivered only once paid, except a
-- cash-on-delivery order, which ships from confirmed before its cash arrives (the cash is recorded
-- later through offline payment and keeps the dispatched/delivered status).
-- orders_priced_freeze: once priced, the payment method and COD fee are frozen like the other money.
-- CREATE OR REPLACE FUNCTION takes no table lock; the existing triggers call the new bodies.
-- If it aborts on lock_timeout: prisma migrate resolve --rolled-back 20261114090500_commerce_cod_order_guards.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION orders_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'bodhinox_app' AND (NEW.status IN ('paid','payment_review','expired')
      OR OLD.status IN ('payment_review','expired')) THEN
    RAISE EXCEPTION 'order_status_forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.priced_at IS NOT NULL AND NEW.status IN ('dispatched','fulfilled') AND OLD.status NOT IN ('paid','dispatched')
      AND NOT (NEW.payment_method = 'cod' AND OLD.status = 'confirmed') THEN
    RAISE EXCEPTION 'order_not_paid' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION orders_priced_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.priced_at IS NOT NULL AND (
      NEW.priced_at IS DISTINCT FROM OLD.priced_at OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor OR NEW.discount_minor IS DISTINCT FROM OLD.discount_minor
      OR NEW.shipping_minor IS DISTINCT FROM OLD.shipping_minor OR NEW.tax_minor IS DISTINCT FROM OLD.tax_minor
      OR NEW.total_minor IS DISTINCT FROM OLD.total_minor OR NEW.tax_inclusive IS DISTINCT FROM OLD.tax_inclusive
      OR NEW.coupon_code IS DISTINCT FROM OLD.coupon_code OR NEW.shipping_address IS DISTINCT FROM OLD.shipping_address
      OR NEW.payment_method IS DISTINCT FROM OLD.payment_method OR NEW.cod_fee_minor IS DISTINCT FROM OLD.cod_fee_minor) THEN
    RAISE EXCEPTION 'order_priced_frozen' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
