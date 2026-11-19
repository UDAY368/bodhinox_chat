SET LOCAL lock_timeout = '5s';

-- Store Phase 8 on top of Store Phase 5: one orders_priced_freeze that keeps both. Additive.
-- 20261130050000_order_edits_split_shipments let the order-edit service change a priced order's amounts
-- (and edit_version) for the one order it names in app.order_edit. 20261201001000 and 20261201003000 then
-- replaced the function to also freeze delivery_method, store_credit_minor, points_redeemed and
-- points_value_minor, from a body written before order edits existed, which froze the amounts for
-- everyone again and stopped guarding edit_version. This body has every column of both:
-- - never changes once priced, for anyone: priced_at, currency, tax mode, coupon, address, payment method,
--   delivery method, and what store credit and points paid;
-- - changes only inside an order edit: the amounts, the discount details and edit_version.
-- CREATE OR REPLACE FUNCTION takes no table lock; the existing trigger calls the new body.
CREATE OR REPLACE FUNCTION orders_priced_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.priced_at IS NOT NULL AND (
      NEW.priced_at IS DISTINCT FROM OLD.priced_at OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.tax_inclusive IS DISTINCT FROM OLD.tax_inclusive
      OR NEW.coupon_code IS DISTINCT FROM OLD.coupon_code OR NEW.shipping_address IS DISTINCT FROM OLD.shipping_address
      OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
      OR NEW.delivery_method IS DISTINCT FROM OLD.delivery_method
      OR NEW.store_credit_minor IS DISTINCT FROM OLD.store_credit_minor
      OR NEW.points_redeemed IS DISTINCT FROM OLD.points_redeemed
      OR NEW.points_value_minor IS DISTINCT FROM OLD.points_value_minor) THEN
    RAISE EXCEPTION 'order_priced_frozen' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.priced_at IS NOT NULL AND (
      NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor OR NEW.discount_minor IS DISTINCT FROM OLD.discount_minor
      OR NEW.shipping_minor IS DISTINCT FROM OLD.shipping_minor OR NEW.tax_minor IS DISTINCT FROM OLD.tax_minor
      OR NEW.total_minor IS DISTINCT FROM OLD.total_minor OR NEW.cod_fee_minor IS DISTINCT FROM OLD.cod_fee_minor
      OR NEW.auto_discount_minor IS DISTINCT FROM OLD.auto_discount_minor
      OR NEW.discount_details IS DISTINCT FROM OLD.discount_details
      OR NEW.edit_version IS DISTINCT FROM OLD.edit_version)
      AND NOT order_edit_open(OLD.id) THEN
    RAISE EXCEPTION 'order_priced_frozen' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
