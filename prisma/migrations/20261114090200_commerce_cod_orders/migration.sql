-- Cash on delivery, part 3: an order records how it is paid and the COD fee it carries (the fee is
-- inside total_minor, its tax inside tax_minor). Written by the worker only: no app grant.
-- One hot table per migration; metadata-only ADD COLUMN; CHECKs NOT VALID, validated in 20261114090400.
-- If it aborts on lock_timeout: prisma migrate resolve --rolled-back 20261114090200_commerce_cod_orders.
SET LOCAL lock_timeout = '5s';

ALTER TABLE orders ADD COLUMN payment_method text NOT NULL DEFAULT 'online';
ALTER TABLE orders ADD COLUMN cod_fee_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check CHECK (payment_method IN ('online','cod')) NOT VALID;
ALTER TABLE orders ADD CONSTRAINT orders_cod_fee_check CHECK (cod_fee_minor >= 0) NOT VALID;
