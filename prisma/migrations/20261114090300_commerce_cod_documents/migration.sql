-- Cash on delivery, part 4: an invoice or receipt snapshot keeps the COD fee as its own line, so
-- subtotal - discount + shipping + COD fee (+ tax when exclusive) adds up to the printed total.
-- If it aborts on lock_timeout: prisma migrate resolve --rolled-back 20261114090300_commerce_cod_documents.
SET LOCAL lock_timeout = '5s';

ALTER TABLE commerce_documents ADD COLUMN cod_fee_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE commerce_documents ADD CONSTRAINT commerce_documents_cod_fee_check CHECK (cod_fee_minor >= 0) NOT VALID;
