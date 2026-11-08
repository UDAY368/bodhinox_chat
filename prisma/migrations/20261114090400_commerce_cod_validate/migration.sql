-- Cash on delivery, part 5: validate the NOT VALID CHECKs of 20261114090000-090300. VALIDATE
-- CONSTRAINT takes SHARE UPDATE EXCLUSIVE, so reads and writes continue during the scan.
-- If it aborts on lock_timeout: prisma migrate resolve --rolled-back 20261114090400_commerce_cod_validate.
SET LOCAL lock_timeout = '5s';

ALTER TABLE commerce_settings VALIDATE CONSTRAINT commerce_settings_cod_fee_check;
ALTER TABLE storefront_sessions VALIDATE CONSTRAINT storefront_sessions_payment_method_check;
ALTER TABLE orders VALIDATE CONSTRAINT orders_payment_method_check;
ALTER TABLE orders VALIDATE CONSTRAINT orders_cod_fee_check;
ALTER TABLE commerce_documents VALIDATE CONSTRAINT commerce_documents_cod_fee_check;
