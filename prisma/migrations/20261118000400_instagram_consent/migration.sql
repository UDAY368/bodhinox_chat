-- Stage 5 (5A): per-channel Instagram subscription and custom keywords (5D
-- implements the behaviour in src/lib/contacts/channel-consent.ts).
--
--   contacts.instagram_opted_out_at  set by STOP on Instagram (or an Actions
--                                    step); while set, no flow, automation,
--                                    default reply or AI reply on Instagram.
--   contacts.instagram_opted_in_at   set by START; clears the opt-out.
--   The contact-wide contacts.opted_out_at (WhatsApp STOP) is unchanged and
--   still blocks marketing on every channel.
--
--   instagram_consent_settings (one row per workspace, admin-managed): extra
--   opt-out and opt-in keywords (up to 20 each, trimmed and lowercased, 1-50
--   characters), one confirmation reply for each, and one flow for each (a flow
--   of the same workspace; deleting the flow clears the link).
--
-- Additive: nullable columns and a new table. keyword_list_ok() is a plain
-- IMMUTABLE helper for the array checks (CHECK cannot hold a subquery).
SET LOCAL lock_timeout = '5s';

ALTER TABLE contacts ADD COLUMN instagram_opted_out_at timestamptz;
ALTER TABLE contacts ADD COLUMN instagram_opted_in_at timestamptz;

CREATE FUNCTION keyword_list_ok(words text[], max_items integer, max_chars integer) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SET search_path=public,pg_temp AS $$
  SELECT cardinality(words) <= max_items
    AND NOT EXISTS (SELECT 1 FROM unnest(words) w
      WHERE w IS NULL OR char_length(w) NOT BETWEEN 1 AND max_chars OR w <> lower(btrim(w)))
$$;

CREATE TABLE instagram_consent_settings (
  account_id uuid PRIMARY KEY DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  opt_out_keywords text[] NOT NULL DEFAULT '{}' CHECK (COALESCE(keyword_list_ok(opt_out_keywords, 20, 50), false)),
  opt_in_keywords text[] NOT NULL DEFAULT '{}' CHECK (COALESCE(keyword_list_ok(opt_in_keywords, 20, 50), false)),
  opt_out_reply text CHECK (opt_out_reply IS NULL OR char_length(btrim(opt_out_reply)) >= 1 AND char_length(opt_out_reply) <= 1000),
  opt_in_reply text CHECK (opt_in_reply IS NULL OR char_length(btrim(opt_in_reply)) >= 1 AND char_length(opt_in_reply) <= 1000),
  opt_out_flow_id uuid,
  opt_in_flow_id uuid,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, opt_out_flow_id) REFERENCES flows(account_id, id) ON DELETE SET NULL (opt_out_flow_id),
  FOREIGN KEY (account_id, opt_in_flow_id) REFERENCES flows(account_id, id) ON DELETE SET NULL (opt_in_flow_id)
);

ALTER TABLE instagram_consent_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE instagram_consent_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON instagram_consent_settings FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY tenant_write ON instagram_consent_settings FOR ALL TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('admin'));
GRANT SELECT, INSERT, UPDATE ON instagram_consent_settings TO bodhinox_app;
GRANT SELECT ON instagram_consent_settings TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON instagram_consent_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
