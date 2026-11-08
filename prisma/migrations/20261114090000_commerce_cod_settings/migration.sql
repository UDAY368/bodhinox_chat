-- Cash on delivery (COD), part 1: the store switch and fee, and the per-product flag.
-- COD is offered only when the store switch is on and every product in the cart allows it.
-- Both tables see few writes; ADD COLUMN with a constant default is metadata-only. The CHECKs
-- are added NOT VALID (every existing row holds the default) and validated in
-- 20261114090400_commerce_cod_validate. Waits at most 5 s for each lock (lock_timeout); if it
-- aborts, prisma migrate resolve --rolled-back 20261114090000_commerce_cod_settings, then re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE commerce_settings ADD COLUMN cod_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE commerce_settings ADD COLUMN cod_fee_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE commerce_settings ADD CONSTRAINT commerce_settings_cod_fee_check
  CHECK (cod_fee_minor >= 0 AND cod_fee_minor <= 100000000000) NOT VALID;
GRANT UPDATE (cod_enabled, cod_fee_minor) ON commerce_settings TO bodhinox_app;

-- Default true: COD follows the store switch until a product opts out.
ALTER TABLE shop_products ADD COLUMN cod_available boolean NOT NULL DEFAULT true;
GRANT UPDATE (cod_available) ON shop_products TO bodhinox_app;
