-- Phase 10: Click-to-WhatsApp ad referrals. The Cloud API webhook we already
-- receive carries a `referral` object on the first message after an ad click;
-- the worker stores it inside the inbound-message transaction. No Meta call is
-- involved, so this part is always on. The click id (ctwa_clid) is readable by
-- the worker only (it is sent to the Conversions API); the app role sees the
-- generated has_click_id bit instead. Additive.
--
-- Every CHECK must accept whatever src/lib/meta-ads/referrals.ts parseReferral
-- returns: the insert runs inside the inbound-message transaction, and a CHECK
-- failure would roll back the message.

CREATE TABLE ad_referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  conversation_id uuid,
  message_id uuid,
  wa_message_id text NOT NULL CHECK (char_length(wa_message_id) BETWEEN 1 AND 256),
  whatsapp_config_id uuid,
  -- Ad ids are digits; a post id can be '<page>_<post>'.
  source_id text CHECK (source_id ~ '^[0-9_]{1,64}$'),
  source_type text NOT NULL CHECK (source_type IN ('ad','post','unknown')),
  source_url text CHECK (char_length(source_url) <= 2048),
  headline text CHECK (char_length(headline) <= 1024),
  body text CHECK (char_length(body) <= 4096),
  media_type text CHECK (media_type IN ('image','video')),
  ctwa_clid text CHECK (char_length(ctwa_clid) <= 512),
  has_click_id boolean GENERATED ALWAYS AS (ctwa_clid IS NOT NULL) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_type <> 'ad' OR source_id IS NULL OR source_id ~ '^\d{1,32}$'),
  UNIQUE (account_id, wa_message_id),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations(account_id, id) ON DELETE SET NULL (conversation_id),
  FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, id) ON DELETE SET NULL (message_id),
  FOREIGN KEY (account_id, whatsapp_config_id) REFERENCES whatsapp_config(account_id, id) ON DELETE SET NULL (whatsapp_config_id)
);
-- Empty new table: plain indexes are safe here.
CREATE INDEX ad_referrals_contact ON ad_referrals(account_id, contact_id, created_at DESC);
CREATE INDEX ad_referrals_source ON ad_referrals(account_id, source_id, created_at);
CREATE INDEX ad_referrals_conversation ON ad_referrals(account_id, conversation_id);

ALTER TABLE ad_referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_referrals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON ad_referrals FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY worker_write ON ad_referrals FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
-- ctwa_clid is excluded: the app role can neither read it nor filter on it.
GRANT SELECT (id, account_id, contact_id, conversation_id, message_id, whatsapp_config_id, source_id,
  source_type, source_url, headline, body, media_type, has_click_id, created_at)
  ON ad_referrals TO bodhinox_app;
GRANT SELECT, INSERT ON ad_referrals TO bodhinox_worker;

-- Flow trigger: a conversation started from an ad.
ALTER TABLE flows DROP CONSTRAINT IF EXISTS flows_trigger_type_check;
ALTER TABLE flows ADD CONSTRAINT flows_trigger_type_check
  CHECK (trigger_type IN ('keyword', 'first_inbound_message', 'manual', 'template_reply', 'order_received', 'ad_click'));
