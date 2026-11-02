-- Phase 6: per-workspace order settings. Today one setting: the confirmation
-- sent when a WhatsApp cart arrives (off, a free-form text, or an approved
-- template). Additive; one row per account, created on first save.
CREATE TABLE order_settings (
  account_id uuid PRIMARY KEY DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  confirmation_mode text NOT NULL DEFAULT 'off' CHECK (confirmation_mode IN ('off','text','template')),
  confirmation_text text CHECK (char_length(confirmation_text) <= 1024),
  template_name text CHECK (char_length(template_name) BETWEEN 1 AND 512),
  template_language text CHECK (char_length(template_language) BETWEEN 1 AND 15),
  -- {"1": "<field>", ...}: template body variable -> order field.
  variable_map jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(variable_map) = 'object' AND pg_column_size(variable_map) <= 4096),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (confirmation_mode <> 'text' OR char_length(btrim(confirmation_text)) > 0),
  CHECK (confirmation_mode <> 'template' OR template_name IS NOT NULL)
);
ALTER TABLE order_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_settings FORCE ROW LEVEL SECURITY;
-- Agents see what is sent on their behalf; admins change it; the worker reads it.
CREATE POLICY tenant_read ON order_settings FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY tenant_write ON order_settings FOR ALL TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
GRANT SELECT,INSERT,UPDATE ON order_settings TO bodhinox_app;
GRANT SELECT ON order_settings TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON order_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
