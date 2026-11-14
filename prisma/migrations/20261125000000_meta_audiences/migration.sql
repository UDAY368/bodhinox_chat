SET LOCAL lock_timeout = '5s';

-- Ads gaps, phase 1: Meta custom audiences. Additive.
-- meta_audiences: a customer-list audience built from a contact segment (the
-- worker uploads SHA-256 hashed phone numbers and emails with Meta's replace
-- call, so a repeat sync never doubles anyone) or a lookalike of one. The
-- audience object itself is created once through an outbound intent; an
-- ambiguous create is settled by looking it up by name, otherwise the row is
-- 'unknown' until an admin re-checks or removes it. Blocked and opted-out
-- contacts are never uploaded. meta_ad_drafts gains the audiences an ad
-- includes or excludes. Nothing calls Meta unless META_ADS_ENABLED and
-- META_ADS_MANAGE_ENABLED are set.

CREATE TABLE meta_audiences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  ad_account_id text NOT NULL CHECK (ad_account_id ~ '^\d{1,32}$'),
  kind text NOT NULL CHECK (kind IN ('customer_list','lookalike')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  -- The segment a customer list is built from; no foreign key, a deleted segment fails the next sync.
  segment_id uuid,
  origin_id uuid,
  lookalike_country text CHECK (lookalike_country ~ '^[A-Z]{2}$'),
  lookalike_percent int CHECK (lookalike_percent BETWEEN 1 AND 10),
  meta_audience_id text CHECK (meta_audience_id ~ '^\d{1,32}$'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','ready','failed','unknown')),
  auto_sync boolean NOT NULL DEFAULT true,
  uploaded_count int CHECK (uploaded_count >= 0),
  matched_lower bigint CHECK (matched_lower >= 0),
  matched_upper bigint CHECK (matched_upper >= 0),
  last_synced_at timestamptz,
  last_error_code text CHECK (last_error_code ~ '^[0-9:a-z_]{0,40}$'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, connection_id) REFERENCES meta_ad_connections(account_id, id),
  FOREIGN KEY (account_id, origin_id) REFERENCES meta_audiences(account_id, id) ON DELETE CASCADE,
  CHECK (kind <> 'lookalike' OR (origin_id IS NOT NULL AND lookalike_country IS NOT NULL AND lookalike_percent IS NOT NULL)),
  CHECK (kind <> 'customer_list' OR origin_id IS NULL)
);
-- Meta finds an audience by its name after an unclear create, so names are unique per ad account.
CREATE UNIQUE INDEX meta_audiences_name ON meta_audiences(account_id, ad_account_id, lower(name));
CREATE INDEX meta_audiences_auto_sync ON meta_audiences(account_id) WHERE auto_sync AND kind = 'customer_list';

ALTER TABLE meta_audiences ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_audiences FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON meta_audiences FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
-- Writes run as the worker after the route's admin, membership and CSRF checks.
CREATE POLICY worker_write ON meta_audiences FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT ON meta_audiences TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON meta_audiences TO bodhinox_worker;

-- Audiences an ad targets (Meta audience ids), stored with the draft.
ALTER TABLE meta_ad_drafts ADD COLUMN audience_ids text[] NOT NULL DEFAULT '{}';
ALTER TABLE meta_ad_drafts ADD COLUMN excluded_audience_ids text[] NOT NULL DEFAULT '{}';
ALTER TABLE meta_ad_drafts ADD CONSTRAINT meta_ad_drafts_audiences_check CHECK (
  cardinality(audience_ids) <= 10 AND cardinality(excluded_audience_ids) <= 10
  AND array_to_string(audience_ids || excluded_audience_ids, ',') ~ '^[0-9,]*$') NOT VALID;
ALTER TABLE meta_ad_drafts VALIDATE CONSTRAINT meta_ad_drafts_audiences_check;
