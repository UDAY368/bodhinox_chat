-- Cash on delivery, part 7: a priced order's total includes its COD fee. orders_priced_total_check
-- (20261107100500) required total = subtotal - discount + shipping (+ tax when exclusive) and so refused
-- every COD order. The replacement adds cod_fee_minor (0 for every existing order, so existing rows
-- still satisfy it). It is added NOT VALID (no scan under the lock) and validated in
-- 20261114090700_commerce_cod_total_validate; the old constraint is then dropped here, so new rows are
-- always checked by one of the two. Both statements take a brief ACCESS EXCLUSIVE lock on orders,
-- waiting at most 5 s (lock_timeout). If it aborts: prisma migrate resolve --rolled-back
-- 20261114090600_commerce_cod_total_check, then re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE orders ADD CONSTRAINT orders_priced_total_cod_check CHECK (priced_at IS NULL OR (
  tax_inclusive IS NOT NULL AND total_minor IS NOT NULL AND discount_minor <= subtotal_minor AND
  total_minor = subtotal_minor - discount_minor + shipping_minor + cod_fee_minor
    + CASE WHEN tax_inclusive THEN 0 ELSE tax_minor END)) NOT VALID;
ALTER TABLE orders DROP CONSTRAINT orders_priced_total_check; -- additive-exception: replaced by orders_priced_total_cod_check, which adds the COD fee
