-- Phase 10: Meta lead ads. The signed Page webhook (leadgen) and a periodic
-- backfill store each lead; the worker fetches its answers with the encrypted
-- Page token. Members read leads through the dedicated routes only (these
-- tables are not CRM resources). An erasure request clears a lead's answers
-- and keeps a tombstone (status 'erased') so a backfill, webhook redelivery or
-- reconnect never re-imports it. Nothing here runs unless META_ADS_ENABLED
-- and its config are set.
-- Additive.

CREATE TABLE meta_lead_forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  form_id text NOT NULL CHECK (form_id ~ '^\d{1,32}$'),
  name text CHECK (char_length(name) <= 500),
  status text CHECK (char_length(status) <= 32),
  questions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (pg_column_size(questions) <= 65536),
  synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, form_id),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, connection_id) REFERENCES meta_ad_connections(account_id, id)
);

CREATE TABLE meta_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  leadgen_id text NOT NULL CHECK (leadgen_id ~ '^\d{1,32}$'),
  form_id text CHECK (form_id ~ '^\d{1,32}$'),
  ad_id text CHECK (ad_id ~ '^\d{1,32}$'),
  adset_id text CHECK (adset_id ~ '^\d{1,32}$'),
  campaign_id text CHECK (campaign_id ~ '^\d{1,32}$'),
  page_id text CHECK (page_id ~ '^\d{1,32}$'),
  ad_name text CHECK (char_length(ad_name) <= 500),
  campaign_name text CHECK (char_length(campaign_name) <= 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','fetched','failed','erased')),
  field_data jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (pg_column_size(field_data) <= 65536),
  contact_id uuid,
  lead_created_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  fetched_at timestamptz,
  -- Meta code[:subcode] or a short category, never a message body.
  fetch_error_code text CHECK (char_length(fetch_error_code) <= 64),
  UNIQUE (account_id, leadgen_id),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, connection_id) REFERENCES meta_ad_connections(account_id, id),
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE SET NULL (contact_id)
);
-- Empty new tables: plain indexes are safe here.
CREATE INDEX meta_leads_list ON meta_leads(account_id, received_at DESC);
CREATE INDEX meta_leads_form ON meta_leads(account_id, form_id);
CREATE INDEX meta_leads_ad ON meta_leads(account_id, ad_id);
CREATE INDEX meta_leads_contact ON meta_leads(account_id, contact_id);

ALTER TABLE meta_lead_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_lead_forms FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON meta_lead_forms FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY worker_write ON meta_lead_forms FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT ON meta_lead_forms TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE ON meta_lead_forms TO bodhinox_worker;

ALTER TABLE meta_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_leads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON meta_leads FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY worker_write ON meta_leads FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT ON meta_leads TO bodhinox_app;
-- Erasure is an UPDATE to a tombstone (admin action, audited); no DELETE.
GRANT SELECT, INSERT, UPDATE ON meta_leads TO bodhinox_worker;
