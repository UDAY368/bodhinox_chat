SET LOCAL lock_timeout = '5s';

-- Store plan Phase 3, package 4: product reviews asked on WhatsApp after delivery. Additive.
-- commerce_settings.review_requests_enabled: off by default; when on, a delivered order queues one
--   commerce.review_request job three days later. Admins write it (column grant).
-- shop_reviews: one rating per order and product (UNIQUE), written only by the worker when the
--   buyer taps a star row (rvw:<order>:<product>:<1-5>) or, after a template request, replies 1 to 5.
--   A review starts 'pending'; admins publish or hide it through the app role (status, moderated_by
--   and moderated_at are the only columns they may change; agents read). body is the buyer's next
--   plain message within 30 minutes (body_closed_at ends that chance). reviewer_initial is the first
--   letter of the contact's name ("R."), kept so the public page never reads the contact.
--   rating_message_id and body_message_id are the inbound message that set each, so a retried
--   inbound job finds its own work again. A review never holds a phone number or a full name.
-- order_notice_templates and order_messages: the new kind 'review_request' (an approved MARKETING
--   template outside the 24-hour window; the ledger row says sent, skipped or blocked and why).
--   Both CHECKs are rebuilt as supersets of 20261128002000 and 20261128001000.
-- If it aborts on lock_timeout: prisma migrate resolve --rolled-back 20261128003000_shop_reviews.

ALTER TABLE commerce_settings ADD COLUMN review_requests_enabled boolean NOT NULL DEFAULT false;
GRANT UPDATE (review_requests_enabled) ON commerce_settings TO bodhinox_app;

CREATE TABLE shop_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  order_id uuid NOT NULL,
  contact_id uuid,
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body text CHECK (body IS NULL OR (char_length(body) BETWEEN 1 AND 1000 AND body !~ '[[:cntrl:]]')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','hidden')),
  reviewer_initial text CHECK (reviewer_initial IS NULL OR reviewer_initial ~ '^[^[:cntrl:]]\.$'),
  rated_at timestamptz NOT NULL DEFAULT now(),
  body_closed_at timestamptz,
  rating_message_id uuid,
  body_message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  moderated_by uuid,
  moderated_at timestamptz,
  UNIQUE (account_id, id),
  UNIQUE (account_id, order_id, product_id),
  FOREIGN KEY (account_id, product_id) REFERENCES shop_products(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, order_id) REFERENCES orders(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE SET NULL (contact_id)
);
CREATE INDEX shop_reviews_published_idx ON shop_reviews (account_id, product_id, created_at DESC) WHERE status = 'published';
CREATE INDEX shop_reviews_list_idx ON shop_reviews (account_id, status, created_at DESC, id DESC);
CREATE INDEX shop_reviews_body_idx ON shop_reviews (account_id, contact_id, rated_at DESC) WHERE body IS NULL AND body_closed_at IS NULL;
CREATE INDEX shop_reviews_body_message_idx ON shop_reviews (account_id, body_message_id) WHERE body_message_id IS NOT NULL;

ALTER TABLE shop_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON shop_reviews FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY tenant_moderate ON shop_reviews FOR UPDATE TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
CREATE POLICY worker_write ON shop_reviews FOR ALL TO bodhinox_worker
  USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT SELECT ON shop_reviews TO bodhinox_app;
GRANT UPDATE (status, moderated_by, moderated_at) ON shop_reviews TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE ON shop_reviews TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON shop_reviews FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE order_notice_templates DROP CONSTRAINT order_notice_templates_kind_check; -- additive-exception: replaced below by a superset
ALTER TABLE order_notice_templates ADD CONSTRAINT order_notice_templates_kind_check
  CHECK (kind IN ('dispatched','delivered','feedback','repeat_purchase','abandoned_cart','cod_confirm','back_in_stock','review_request')) NOT VALID;
ALTER TABLE order_notice_templates VALIDATE CONSTRAINT order_notice_templates_kind_check;

ALTER TABLE order_messages DROP CONSTRAINT order_messages_kind_check; -- additive-exception: replaced below by a superset
ALTER TABLE order_messages ADD CONSTRAINT order_messages_kind_check CHECK (kind IN ('checkout_link','payment_link','receipt',
  'dispatched','delivered','feedback','product_follow_up','repeat_purchase','cod_confirm','review_request')) NOT VALID;
ALTER TABLE order_messages VALIDATE CONSTRAINT order_messages_kind_check;
