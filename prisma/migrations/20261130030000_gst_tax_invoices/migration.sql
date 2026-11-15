SET LOCAL lock_timeout = '5s';

-- Store Phase 5: GST tax invoices for business buyers. The buyer's GSTIN and legal name are stored on the order
-- (nullable; the server validates the GSTIN before it writes). Variants and order lines already carry hsn_code.
ALTER TABLE orders ADD COLUMN buyer_gstin text;
ALTER TABLE orders ADD COLUMN buyer_legal_name text;
ALTER TABLE orders ADD CONSTRAINT orders_buyer_gstin_check
  CHECK (buyer_gstin IS NULL OR buyer_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$') NOT VALID;
ALTER TABLE orders ADD CONSTRAINT orders_buyer_legal_name_check
  CHECK (buyer_legal_name IS NULL OR char_length(buyer_legal_name) BETWEEN 1 AND 200) NOT VALID;

-- A tax invoice joins the receipt and credit note kinds; it shares their per-workspace, per-year number series.
ALTER TABLE commerce_documents DROP CONSTRAINT commerce_documents_kind_check; -- additive-exception: replaced in the next statement by a wider check that still admits every existing kind
ALTER TABLE commerce_documents ADD CONSTRAINT commerce_documents_kind_check
  CHECK (kind IN ('receipt','credit_note','tax_invoice')) NOT VALID;

-- One tax invoice per order, whatever happens (a replay, two payments, the admin asking again).
CREATE UNIQUE INDEX commerce_documents_tax_invoice_order_key ON commerce_documents (account_id, order_id) WHERE kind = 'tax_invoice'; -- additive-exception: commerce_documents holds receipts only (a few per order), the build is brief and takes a write lock only for that moment
