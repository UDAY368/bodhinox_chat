-- Stage 5 (5A): internal conversion events (5F implements
-- src/lib/analytics/conversion-log.ts, the Settings page and Insights).
--
--   conversion_event_types  named by admins, archived rather than deleted (a
--                           name is unique without case among unarchived types).
--   conversion_event_log    one row per run, step and type (unique key), so a
--                           replayed Actions step never double counts. Written
--                           by the worker (the flow engine); members read it.
--                           Contact, flow and run are plain ids so deleting
--                           them never blocks or rewrites the log.
-- This is an internal log; the Meta Conversions API step is unchanged.
-- Additive: new tables.
SET LOCAL lock_timeout = '5s';

CREATE TABLE conversion_event_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) >= 1 AND char_length(name) <= 60),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)
);
CREATE UNIQUE INDEX conversion_event_types_name_key ON conversion_event_types (account_id, lower(name)) WHERE archived_at IS NULL;

ALTER TABLE conversion_event_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversion_event_types FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON conversion_event_types FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY tenant_write ON conversion_event_types FOR ALL TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('admin'));
-- No DELETE: a type is archived, so the log keeps its name.
GRANT SELECT, INSERT ON conversion_event_types TO bodhinox_app;
GRANT UPDATE (name, archived_at) ON conversion_event_types TO bodhinox_app;
GRANT SELECT ON conversion_event_types TO bodhinox_worker;

CREATE TABLE conversion_event_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  event_type_id uuid NOT NULL,
  contact_id uuid,
  flow_id uuid,
  flow_run_id uuid,
  node_key text CHECK (node_key IS NULL OR char_length(node_key) BETWEEN 1 AND 200),
  channel text NOT NULL CHECK (channel IN ('whatsapp','instagram')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, flow_run_id, node_key, event_type_id),
  FOREIGN KEY (account_id, event_type_id) REFERENCES conversion_event_types(account_id, id) ON DELETE CASCADE
);
CREATE INDEX conversion_event_log_type_time_idx ON conversion_event_log (account_id, event_type_id, occurred_at);

ALTER TABLE conversion_event_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversion_event_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON conversion_event_log FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY worker_insert ON conversion_event_log FOR INSERT TO bodhinox_worker
  WITH CHECK (account_id = app_account_id());
GRANT SELECT ON conversion_event_log TO bodhinox_app;
GRANT SELECT, INSERT ON conversion_event_log TO bodhinox_worker;
