-- Cash on delivery, part 8: validate orders_priced_total_cod_check (added NOT VALID in
-- 20261114090600). VALIDATE takes SHARE UPDATE EXCLUSIVE: reads and writes continue during the scan.
-- If it aborts on lock_timeout: prisma migrate resolve --rolled-back 20261114090700_commerce_cod_total_validate.
SET LOCAL lock_timeout = '5s';

ALTER TABLE orders VALIDATE CONSTRAINT orders_priced_total_cod_check;
