SET LOCAL lock_timeout = '5s';

-- Store plan Phase 8, batch 6: shop marketing. Additive.
-- shop_marketing_settings: one row per workspace, admins write. order_emails_enabled turns on the order confirmation
--   email; sender_name, sender_address (the postal address every marketing email carries) and reply_to shape the emails;
--   referral_enabled / referral_reward_minor / referral_hold_days are the referral program (the reward is store credit,
--   paid once the order is paid and the hold has passed).
-- shop_email_prefs: one row per contact, the email consent and the suppression in one place. opted_in_at is recorded by
--   an admin (they attest the customer agreed); unsubscribed_at is written only by the public unsubscribe page (the worker)
--   and is never cleared: an unsubscribed contact is never emailed again.
-- shop_email_campaigns / shop_email_recipients: a marketing email and its recipient snapshot (one row per contact, taken when
--   it is sent). The campaign text is frozen once queued. Each recipient is one queued job; a recipient row is the dedupe.
-- shop_referral_codes / shop_referrals: a code per customer (made when their first order is paid) or per named affiliate, and
--   the order a code brought in (one row per order, and only one per buyer: a buyer's first order is the one that counts).
--   The reward is a store credit entry (kind 'referral', key referral:<order>); an affiliate gets a commission figure in
--   the report only (no payout).
-- shop_link_page: the link-in-bio page /s/<handle>/links (bio, up to 12 links, up to 6 featured products).
-- shop_order_emails: the one confirmation email per order and how it ended.
-- shop_cart_codes.referral_code_id / shop_otp_challenges.referral_code_id: the referral code the buyer arrived with when they made the cart.
-- orders.buyer_email: the address the buyer typed at checkout (confirmation emails go to it). The contact keeps its own address; it only
--   takes this one when it has none. "Email me offers" records consent for the contact only when the address is the contact's own.
-- shop_credit_ledger.kind: the new kind 'referral'; the CHECK is rebuilt as a superset of 20261201003000_price_rules.
-- If it aborts on lock_timeout: prisma migrate resolve --rolled-back 20261201005000_shop_marketing.

-- ================================================================ settings
CREATE TABLE shop_marketing_settings (
  account_id uuid PRIMARY KEY DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  order_emails_enabled boolean NOT NULL DEFAULT false,
  sender_name text CHECK (sender_name IS NULL OR (char_length(sender_name) BETWEEN 1 AND 80 AND sender_name !~ '[[:cntrl:]]')),
  sender_address text CHECK (sender_address IS NULL OR (char_length(sender_address) BETWEEN 1 AND 300)),
  reply_to text CHECK (reply_to IS NULL OR (char_length(reply_to) <= 254 AND reply_to ~ '^[^[:space:]@<>",;]+@[^[:space:]@<>",;]+$')),
  referral_enabled boolean NOT NULL DEFAULT false,
  referral_reward_minor bigint NOT NULL DEFAULT 0 CHECK (referral_reward_minor BETWEEN 0 AND 100000000000),
  referral_hold_days integer NOT NULL DEFAULT 14 CHECK (referral_hold_days BETWEEN 0 AND 90),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shop_link_page (
  account_id uuid PRIMARY KEY DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  bio text CHECK (bio IS NULL OR char_length(bio) BETWEEN 1 AND 280),
  -- [{"label": "Instagram", "url": "https://..."}], at most 12
  links jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(links) = 'array' AND jsonb_array_length(links) <= 12
    AND pg_column_size(links) <= 6144),
  -- ["<product id>", ...], at most 6
  featured_product_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(featured_product_ids) = 'array'
    AND jsonb_array_length(featured_product_ids) <= 6 AND pg_column_size(featured_product_ids) <= 1024),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ================================================================ email consent and suppression
CREATE TABLE shop_email_prefs (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  opted_in_at timestamptz,
  opt_in_source text CHECK (opt_in_source IS NULL OR opt_in_source ~ '^[a-z_]{1,40}$'),
  opted_in_by uuid,
  unsubscribed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, contact_id),
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE CASCADE
);

-- ================================================================ campaigns
CREATE TABLE shop_email_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 150 AND subject !~ '[[:cntrl:]]'),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  -- null: every contact with consent and an email address.
  segment_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sending','cancelled')),
  recipient_count integer NOT NULL DEFAULT 0 CHECK (recipient_count >= 0),
  created_by uuid,
  queued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, segment_id) REFERENCES segments(account_id, id) ON DELETE SET NULL (segment_id)
);
CREATE INDEX shop_email_campaigns_created_idx ON shop_email_campaigns (account_id, created_at DESC);

-- What was sent cannot change after it was queued.
CREATE FUNCTION shop_email_campaign_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.queued_at IS NOT NULL AND (NEW.queued_at IS DISTINCT FROM OLD.queued_at
      OR NEW.name IS DISTINCT FROM OLD.name OR NEW.subject IS DISTINCT FROM OLD.subject OR NEW.body IS DISTINCT FROM OLD.body) THEN
    RAISE EXCEPTION 'campaign_locked' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shop_email_campaign_freeze BEFORE UPDATE ON shop_email_campaigns FOR EACH ROW EXECUTE FUNCTION shop_email_campaign_freeze();

CREATE TABLE shop_email_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
  -- queued: waiting for its job; sending: claimed, the send not settled (an uncertain send is closed as unknown and never sent again);
  -- sent; skipped / failed: nothing was sent (reason holds a code, never customer content); unknown: the SMTP outcome is not known.
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','skipped','failed','unknown')),
  reason text CHECK (reason IS NULL OR reason ~ '^[a-z0-9_]{1,64}$'),
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, campaign_id, contact_id),
  FOREIGN KEY (account_id, campaign_id) REFERENCES shop_email_campaigns(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE CASCADE
);
CREATE INDEX shop_email_recipients_status_idx ON shop_email_recipients (account_id, campaign_id, status);

-- ================================================================ referrals
CREATE TABLE shop_referral_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  kind text NOT NULL CHECK (kind IN ('contact','affiliate')),
  contact_id uuid,
  name text CHECK (name IS NULL OR (char_length(name) BETWEEN 1 AND 80 AND name !~ '[[:cntrl:]]')),
  -- Affiliates only: the share of the order's net amount shown in the commission report (basis points).
  commission_bps integer CHECK (commission_bps IS NULL OR commission_bps BETWEEN 0 AND 5000),
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, code),
  CHECK ((kind = 'contact' AND contact_id IS NOT NULL AND name IS NULL AND commission_bps IS NULL)
    OR (kind = 'affiliate' AND contact_id IS NULL AND name IS NOT NULL)),
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX shop_referral_codes_contact_key ON shop_referral_codes (account_id, contact_id) WHERE kind = 'contact'; -- additive-exception: the table is new and empty

CREATE TABLE shop_referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  code_id uuid,
  kind text NOT NULL CHECK (kind IN ('contact','affiliate')),
  referrer_contact_id uuid,
  buyer_contact_id uuid NOT NULL,
  -- pending: waiting for the order to be paid and the hold to pass; rewarded: the credit (or the commission figure) was settled; skipped: nothing is owed.
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','rewarded','skipped')),
  reason text CHECK (reason IS NULL OR reason ~ '^[a-z0-9_]{1,64}$'),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  net_minor bigint CHECK (net_minor IS NULL OR net_minor >= 0),
  reward_minor bigint CHECK (reward_minor IS NULL OR reward_minor >= 0),
  commission_minor bigint CHECK (commission_minor IS NULL OR commission_minor >= 0),
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  -- One referral per order, and one per buyer: only a buyer's first order counts.
  UNIQUE (account_id, order_id),
  UNIQUE (account_id, buyer_contact_id),
  FOREIGN KEY (account_id, order_id) REFERENCES orders(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, code_id) REFERENCES shop_referral_codes(account_id, id) ON DELETE SET NULL (code_id),
  FOREIGN KEY (account_id, buyer_contact_id) REFERENCES contacts(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, referrer_contact_id) REFERENCES contacts(account_id, id) ON DELETE SET NULL (referrer_contact_id)
);
CREATE INDEX shop_referrals_code_idx ON shop_referrals (account_id, code_id);

CREATE TABLE shop_order_emails (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('sent','skipped','failed','unknown')),
  reason text CHECK (reason IS NULL OR reason ~ '^[a-z0-9_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, order_id),
  FOREIGN KEY (account_id, order_id) REFERENCES orders(account_id, id) ON DELETE CASCADE
);

-- ================================================================ existing tables
ALTER TABLE shop_cart_codes ADD COLUMN referral_code_id uuid;
ALTER TABLE shop_cart_codes ADD CONSTRAINT shop_cart_codes_referral_fkey FOREIGN KEY (account_id, referral_code_id)
  REFERENCES shop_referral_codes(account_id, id) ON DELETE SET NULL (referral_code_id) NOT VALID; -- the column is new and empty: nothing to check; validate in a later migration

ALTER TABLE shop_otp_challenges ADD COLUMN referral_code_id uuid;
ALTER TABLE shop_otp_challenges ADD CONSTRAINT shop_otp_challenges_referral_fkey FOREIGN KEY (account_id, referral_code_id)
  REFERENCES shop_referral_codes(account_id, id) ON DELETE SET NULL (referral_code_id) NOT VALID; -- the column is new and empty: nothing to check; validate in a later migration

ALTER TABLE orders ADD COLUMN buyer_email text;
ALTER TABLE orders ADD CONSTRAINT orders_buyer_email_check CHECK (buyer_email IS NULL OR char_length(buyer_email) BETWEEN 3 AND 254) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT orders_buyer_email_check;

ALTER TABLE shop_credit_ledger DROP CONSTRAINT shop_credit_ledger_kind_check; -- additive-exception: replaced below by a superset
ALTER TABLE shop_credit_ledger ADD CONSTRAINT shop_credit_ledger_kind_check
  CHECK (kind IN ('refund','spend','spend_reversal','adjust','referral')) NOT VALID;
ALTER TABLE shop_credit_ledger VALIDATE CONSTRAINT shop_credit_ledger_kind_check;

-- ================================================================ RLS
-- Settings, the link page, campaigns and codes: agents and above read (the worker reads for emails and the public page); only admins write.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['shop_marketing_settings','shop_link_page','shop_email_campaigns','shop_referral_codes']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT TO bodhinox_app,bodhinox_worker USING (account_id=app_account_id() AND app_write_allowed(%L))', t, 'agent');
    EXECUTE format('CREATE POLICY tenant_write ON %I FOR ALL TO bodhinox_app USING (account_id=app_account_id() AND app_write_allowed(%L)) WITH CHECK (account_id=app_account_id() AND app_write_allowed(%L))', t, 'admin', 'admin');
    EXECUTE format('GRANT SELECT ON %I TO bodhinox_worker', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO bodhinox_app', t);
  END LOOP;
END $$;
GRANT UPDATE (order_emails_enabled, sender_name, sender_address, reply_to, referral_enabled, referral_reward_minor, referral_hold_days, updated_at)
  ON shop_marketing_settings TO bodhinox_app;
GRANT UPDATE (enabled, bio, links, featured_product_ids, updated_at) ON shop_link_page TO bodhinox_app;
GRANT UPDATE (name, subject, body, segment_id, status, recipient_count, queued_at, updated_at) ON shop_email_campaigns TO bodhinox_app;
GRANT UPDATE (active, name, commission_bps) ON shop_referral_codes TO bodhinox_app;
-- Codes of customers are made by the worker (when their first order is paid).
CREATE POLICY worker_write ON shop_referral_codes FOR INSERT TO bodhinox_worker WITH CHECK (account_id=app_account_id());
GRANT INSERT ON shop_referral_codes TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON shop_marketing_settings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON shop_link_page FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON shop_email_campaigns FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Email consent: agents read; an admin records consent (never an unsubscribe: that is the public page, the worker).
ALTER TABLE shop_email_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_email_prefs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON shop_email_prefs FOR SELECT TO bodhinox_app,bodhinox_worker USING (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY tenant_write ON shop_email_prefs FOR ALL TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin') AND unsubscribed_at IS NULL);
CREATE POLICY worker_write ON shop_email_prefs FOR ALL TO bodhinox_worker USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT SELECT ON shop_email_prefs TO bodhinox_app;
GRANT INSERT (account_id, contact_id, opted_in_at, opt_in_source, opted_in_by) ON shop_email_prefs TO bodhinox_app;
GRANT UPDATE (opted_in_at, opt_in_source, opted_in_by, updated_at) ON shop_email_prefs TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE ON shop_email_prefs TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON shop_email_prefs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Recipients: an admin makes them when a campaign is sent (and ends the queued ones when it is cancelled); the worker settles them.
ALTER TABLE shop_email_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_email_recipients FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON shop_email_recipients FOR SELECT TO bodhinox_app,bodhinox_worker USING (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY tenant_write ON shop_email_recipients FOR ALL TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin')) WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
CREATE POLICY worker_write ON shop_email_recipients FOR ALL TO bodhinox_worker USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT SELECT, INSERT ON shop_email_recipients TO bodhinox_app;
GRANT UPDATE (status, reason, settled_at) ON shop_email_recipients TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE ON shop_email_recipients TO bodhinox_worker;

-- Referrals and order emails: written by the worker (placing and paying an order, the jobs); agents read.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['shop_referrals','shop_order_emails']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT TO bodhinox_app,bodhinox_worker USING (account_id=app_account_id() AND app_write_allowed(%L))', t, 'agent');
    EXECUTE format('CREATE POLICY worker_write ON %I FOR ALL TO bodhinox_worker USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id())', t);
    EXECUTE format('GRANT SELECT ON %I TO bodhinox_app', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO bodhinox_worker', t);
  END LOOP;
END $$;
