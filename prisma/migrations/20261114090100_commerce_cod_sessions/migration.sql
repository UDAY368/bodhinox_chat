-- Cash on delivery, part 2: the customer's payment choice lives on the storefront session, so the
-- quote shown and the place reprice both include the COD fee. One hot table per migration.
-- Metadata-only ADD COLUMN; the CHECK is NOT VALID here and validated in 20261114090400.
-- If it aborts on lock_timeout: prisma migrate resolve --rolled-back 20261114090100_commerce_cod_sessions.
SET LOCAL lock_timeout = '5s';

ALTER TABLE storefront_sessions ADD COLUMN payment_method text NOT NULL DEFAULT 'online';
ALTER TABLE storefront_sessions ADD CONSTRAINT storefront_sessions_payment_method_check
  CHECK (payment_method IN ('online','cod')) NOT VALID;
