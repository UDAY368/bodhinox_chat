SET LOCAL lock_timeout = '5s';

-- Store plan Phase 4, package 2: product CSV import. Additive.
-- shop_import_jobs holds one queued import: the uploaded CSV text (cleared when
-- the job ends), how far the worker got and a capped list of row errors (row
-- number, column and code only, never cell contents). Admins queue a row
-- through the app role and read everything except the file text; the worker
-- updates progress. One queued or running import per workspace.

CREATE TABLE shop_import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  csv_text text CHECK (csv_text IS NULL OR char_length(csv_text) <= 5500000),
  total_rows integer NOT NULL CHECK (total_rows BETWEEN 1 AND 5000),
  processed_rows integer NOT NULL DEFAULT 0 CHECK (processed_rows >= 0 AND processed_rows <= total_rows),
  created_count integer NOT NULL DEFAULT 0 CHECK (created_count >= 0),
  updated_count integer NOT NULL DEFAULT 0 CHECK (updated_count >= 0),
  error_count integer NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  errors jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(errors) = 'array' AND jsonb_array_length(errors) <= 200),
  error_code text CHECK (error_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE (account_id, id),
  CHECK (status NOT IN ('queued','running') OR csv_text IS NOT NULL)
);
CREATE UNIQUE INDEX shop_import_jobs_one_active ON shop_import_jobs (account_id) WHERE status IN ('queued','running');
CREATE INDEX shop_import_jobs_account_idx ON shop_import_jobs (account_id, created_at DESC);

ALTER TABLE shop_import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_import_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY admin_read ON shop_import_jobs FOR SELECT TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin'));
CREATE POLICY admin_insert ON shop_import_jobs FOR INSERT TO bodhinox_app
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('admin') AND status = 'queued' AND requested_by = app_user_id());
CREATE POLICY worker_all ON shop_import_jobs FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
-- The browser never reads the uploaded file back (no csv_text in the column list).
GRANT SELECT (id, account_id, requested_by, status, total_rows, processed_rows, created_count, updated_count, error_count, errors,
  error_code, created_at, started_at, completed_at) ON shop_import_jobs TO bodhinox_app;
GRANT INSERT (account_id, requested_by, csv_text, total_rows) ON shop_import_jobs TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE ON shop_import_jobs TO bodhinox_worker;
