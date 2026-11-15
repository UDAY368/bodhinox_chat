SET LOCAL lock_timeout = '5s';

-- Store plan Phase 3, package 3: back-in-stock alerts. Additive.
-- shop_stock_alerts: a visitor asks to be told when a sold-out variant is back. The public page
--   saves a six-character code (48 hours); the buyer sends "NOTIFY <CODE>" to the shop's WhatsApp
--   number, which claims it for that contact (first sender wins, claim_expires_at = 90 days), so the
--   later message goes only to someone who messaged first. notified_at is set once the message was
--   sent; closed_at ends an alert (sent, refused for good, uncertain or a duplicate) and skip_reason
--   holds the code, never customer content. One open alert per contact and variant.
--   Written only by the worker (public route, inbound job, restock job); admins read counts.
-- order_notice_templates.kind: the new notice kind 'back_in_stock' (an approved MARKETING template
--   for the message outside the 24-hour window). The CHECK is rebuilt as a superset of
--   20261128001000_shop_cart_cod_followups.
-- If it aborts on lock_timeout: prisma migrate resolve --rolled-back 20261128002000_shop_stock_alerts.

CREATE TABLE shop_stock_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  variant_id uuid NOT NULL,
  contact_id uuid,
  conversation_id uuid,
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  notified_at timestamptz,
  closed_at timestamptz,
  skip_reason text CHECK (skip_reason IS NULL OR skip_reason ~ '^[a-z0-9_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, code),
  CHECK ((claimed_at IS NULL) = (contact_id IS NULL)),
  CHECK ((claimed_at IS NULL) = (claim_expires_at IS NULL)),
  FOREIGN KEY (account_id, variant_id) REFERENCES shop_variants(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations(account_id, id) ON DELETE SET NULL (conversation_id)
);
CREATE UNIQUE INDEX shop_stock_alerts_open_contact_variant_idx ON shop_stock_alerts (account_id, contact_id, variant_id)
  WHERE contact_id IS NOT NULL AND closed_at IS NULL;
CREATE INDEX shop_stock_alerts_waiting_idx ON shop_stock_alerts (account_id, variant_id, id)
  WHERE claimed_at IS NOT NULL AND closed_at IS NULL;
CREATE INDEX shop_stock_alerts_expiry_idx ON shop_stock_alerts (expires_at) WHERE claimed_at IS NULL;

ALTER TABLE shop_stock_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_stock_alerts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON shop_stock_alerts FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY worker_write ON shop_stock_alerts FOR ALL TO bodhinox_worker
  USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT SELECT ON shop_stock_alerts TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE ON shop_stock_alerts TO bodhinox_worker;

ALTER TABLE order_notice_templates DROP CONSTRAINT order_notice_templates_kind_check; -- additive-exception: replaced below by a superset
ALTER TABLE order_notice_templates ADD CONSTRAINT order_notice_templates_kind_check
  CHECK (kind IN ('dispatched','delivered','feedback','repeat_purchase','abandoned_cart','cod_confirm','back_in_stock')) NOT VALID;
ALTER TABLE order_notice_templates VALIDATE CONSTRAINT order_notice_templates_kind_check;
