-- Phase 12: immutable published flow versions. DDL only; additive.
--
-- Publishing a flow snapshots its draft (trigger, entry, fallback policy,
-- channel scope and nodes) into flow_versions. flows.published_version_id
-- names the live version; every run records the version it started on in
-- flow_runs.flow_version_id and stays on it (edits affect future enrollments
-- only). flows.whatsapp_config_id is not versioned: it stays a live routing
-- setting.
--
-- Versions are never changed: no role has UPDATE or DELETE, and a BEFORE
-- UPDATE trigger refuses any update as defense in depth. Rows go away only
-- through foreign-key cascades (account, flow, or the flow author's deletion
-- through flows_user_id_fkey). published_by is an audit identity with no
-- foreign key: an FK with SET NULL would be an UPDATE the trigger refuses.
--
-- lock_timeout makes the deploy fail fast (re-run it) instead of queueing
-- behind the flow engine on a busy flows/flow_runs table.
SET LOCAL lock_timeout = '5s';

CREATE TABLE flow_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  flow_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  trigger_type text NOT NULL,
  trigger_config jsonb NOT NULL,
  entry_node_id text,
  fallback_policy jsonb NOT NULL,
  channel_scope text NOT NULL CHECK (channel_scope IN ('whatsapp','instagram','any')),
  -- [{node_key,node_type,config,position_x,position_y}]; positions are kept for the read-only canvas.
  nodes jsonb NOT NULL CHECK (jsonb_typeof(nodes) = 'array' AND octet_length(nodes::text) <= 1048576),
  published_by uuid,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  -- Lets flows and flow_runs reference a version of their own flow only.
  UNIQUE (account_id, flow_id, id),
  UNIQUE (account_id, flow_id, version),
  FOREIGN KEY (account_id, flow_id) REFERENCES flows(account_id, id) ON DELETE CASCADE
);

ALTER TABLE flow_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON flow_versions FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY app_publish ON flow_versions FOR INSERT TO bodhinox_app
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('agent') AND published_by = app_user_id());
GRANT SELECT ON flow_versions TO bodhinox_app, bodhinox_worker;
-- FORCE RLS binds the owner too. ALTER TABLE ... VALIDATE CONSTRAINT checks
-- existing rows with an ordinary query as the owner (unlike per-row RI
-- checks), so without this read policy 20261110100200 would find no version
-- for any pinned run when the owner is not a superuser. flow_runs already has
-- the same owner read (scheduling_migration_owner, 20261014020000).
DO $$ BEGIN
  EXECUTE format('CREATE POLICY flow_versions_migration_owner ON flow_versions FOR SELECT TO %I USING (true)', current_user);
END $$;
-- Owner-only policies for the data backfill (20261110100100), so it needs no
-- NO FORCE / FORCE bracket and therefore takes only ROW EXCLUSIVE and
-- ACCESS SHARE locks instead of ACCESS EXCLUSIVE on the flow tables for its
-- whole run. CREATE POLICY itself takes ACCESS EXCLUSIVE, so these belong in
-- this brief DDL file. flows and flow_runs already have the owner read
-- (scheduling_migration_owner); flow_nodes and plan_archives get one here.
-- No runtime role is named, so no app or worker access changes.
DO $$ BEGIN
  EXECUTE format('CREATE POLICY flow_versions_backfill_owner ON flow_versions FOR INSERT TO %I WITH CHECK (true)', current_user);
  EXECUTE format('CREATE POLICY flow_versions_backfill_owner ON flows FOR UPDATE TO %I USING (true) WITH CHECK (true)', current_user);
  EXECUTE format('CREATE POLICY flow_versions_backfill_owner ON flow_runs FOR UPDATE TO %I USING (true) WITH CHECK (true)', current_user);
  EXECUTE format('CREATE POLICY flow_versions_backfill_owner ON flow_nodes FOR SELECT TO %I USING (true)', current_user);
  EXECUTE format('CREATE POLICY flow_versions_backfill_owner ON plan_archives FOR SELECT TO %I USING (true)', current_user);
END $$;
-- id and published_at are server defaults; the app cannot forge them.
GRANT INSERT (account_id, flow_id, version, trigger_type, trigger_config, entry_node_id, fallback_policy,
  channel_scope, nodes, published_by) ON flow_versions TO bodhinox_app;

CREATE FUNCTION flow_versions_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'flow_versions rows are immutable' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER flow_versions_immutable BEFORE UPDATE ON flow_versions
  FOR EACH ROW EXECUTE FUNCTION flow_versions_immutable();

-- The live version. flows is small; the constraint is validated here.
ALTER TABLE flows ADD COLUMN published_version_id uuid;
ALTER TABLE flows ADD CONSTRAINT flows_published_version_fkey
  FOREIGN KEY (account_id, id, published_version_id) REFERENCES flow_versions(account_id, flow_id, id)
  ON DELETE SET NULL (published_version_id);

-- 'paused': no new enrollments; in-flight runs finish on their version.
-- Superset of the inline CHECK from 20261014000000_foundation.
ALTER TABLE flows DROP CONSTRAINT flows_status_check;
ALTER TABLE flows ADD CONSTRAINT flows_status_check CHECK (status IN ('draft','active','paused','archived'));

-- The version a run is pinned to. NULL: a draft test-number run, or a run
-- started before this migration that the backfill did not pin; both run on
-- the live draft exactly as before. Adding a nullable column is
-- metadata-only. The foreign key is NOT VALID here, so no scan happens under
-- this lock; 20261110100200 validates it under SHARE UPDATE EXCLUSIVE.
ALTER TABLE flow_runs ADD COLUMN flow_version_id uuid;
ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_flow_version_fkey
  FOREIGN KEY (account_id, flow_id, flow_version_id) REFERENCES flow_versions(account_id, flow_id, id)
  ON DELETE CASCADE NOT VALID;
