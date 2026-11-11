-- Stage 5 (5A): tracked links for flow buttons (5F implements
-- src/lib/flows/link-tracking.ts and the /r/[token] lookup).
--
-- One row per run, step and button slot (unique), so a retried send reuses its
-- token. The token is 32 lowercase hex characters, unique across workspaces
-- because the public redirect runs before any workspace is known. The worker
-- writes rows (sends and clicks run in jobs and the redirect); members read
-- them for CTR. The destination URL is http(s) only, as for campaign links.
--
-- resolve_flow_link_token(token) is the only cross-tenant lookup the public
-- redirect needs (token -> workspace, row, run, destination), like
-- resolve_click_token for campaigns: SECURITY DEFINER, worker only. FORCE RLS
-- binds the definer's owner too, so the owner gets a read policy on this table
-- (pattern 20261102020000_click_token_owner_policy).
-- Additive: a new table and a new function.
SET LOCAL lock_timeout = '5s';

CREATE TABLE flow_tracked_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  token char(32) NOT NULL UNIQUE CHECK (token ~ '^[0-9a-f]{32}$'),
  flow_id uuid NOT NULL,
  flow_run_id uuid NOT NULL,
  node_key text NOT NULL CHECK (char_length(node_key) BETWEEN 1 AND 200),
  slot text NOT NULL CHECK (char_length(slot) BETWEEN 1 AND 200),
  -- Kept as plain ids: deleting a contact or conversation never blocks or rewrites a sent link.
  contact_id uuid,
  conversation_id uuid,
  url text NOT NULL CHECK (char_length(url) <= 2048 AND url ~* '^https?://'),
  created_at timestamptz NOT NULL DEFAULT now(),
  first_clicked_at timestamptz,
  click_count integer NOT NULL DEFAULT 0 CHECK (click_count >= 0),
  CHECK ((click_count = 0) = (first_clicked_at IS NULL)),
  UNIQUE (account_id, id),
  UNIQUE (account_id, flow_run_id, node_key, slot),
  FOREIGN KEY (account_id, flow_id) REFERENCES flows(account_id, id) ON DELETE CASCADE
);
CREATE INDEX flow_tracked_links_flow_idx ON flow_tracked_links (account_id, flow_id, node_key);

ALTER TABLE flow_tracked_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_tracked_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON flow_tracked_links FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY worker_write ON flow_tracked_links FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
-- Members read links for CTR, never the token: the token alone records a click.
-- The table is not a contracts.ts resource either.
GRANT SELECT (id, account_id, flow_id, flow_run_id, node_key, slot, contact_id, conversation_id, url, created_at,
  first_clicked_at, click_count) ON flow_tracked_links TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE ON flow_tracked_links TO bodhinox_worker;

DO $$ BEGIN
  EXECUTE format('CREATE POLICY flow_link_definer_owner ON flow_tracked_links FOR SELECT TO %I USING (true)', current_user);
END $$;

CREATE FUNCTION resolve_flow_link_token(p_token text)
RETURNS TABLE(account_id uuid, link_id uuid, flow_run_id uuid, url text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT l.account_id, l.id, l.flow_run_id, l.url FROM flow_tracked_links l
  WHERE p_token ~ '^[0-9a-f]{32}$' AND l.token = p_token
$$;
REVOKE ALL ON FUNCTION resolve_flow_link_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_flow_link_token(text) TO bodhinox_worker;
