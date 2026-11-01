-- Phase 2c: API campaigns and click tracking. All additive.

-- An API campaign is a named campaign the public API adds recipients to over time.
ALTER TABLE broadcasts ADD COLUMN kind text NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard', 'api'));

-- Click tracking: a template URL button pointing at <app>/r/{{1}} gets a per-recipient
-- token; /r/<token> records the click and redirects to the campaign's HTTPS destination.
ALTER TABLE broadcasts ADD COLUMN tracked_url text
  CHECK (tracked_url IS NULL OR (tracked_url ~ '^https://' AND char_length(tracked_url) <= 2048));
ALTER TABLE broadcasts ADD COLUMN click_count integer NOT NULL DEFAULT 0;
ALTER TABLE broadcast_recipients ADD COLUMN click_token text CHECK (click_token ~ '^[0-9a-f]{32}$');
ALTER TABLE broadcast_recipients ADD COLUMN clicked_at timestamptz;
CREATE UNIQUE INDEX broadcast_recipients_click_token_key ON broadcast_recipients(click_token) WHERE click_token IS NOT NULL;

-- Every click (repeat clicks included); the IP is stored only as a keyed hash.
CREATE TABLE broadcast_clicks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  broadcast_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  clicked_at timestamptz NOT NULL DEFAULT now(),
  ip_hash text,
  FOREIGN KEY (account_id, broadcast_id) REFERENCES broadcasts(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, recipient_id) REFERENCES broadcast_recipients(account_id, id) ON DELETE CASCADE
);
CREATE INDEX broadcast_clicks_broadcast_idx ON broadcast_clicks(account_id, broadcast_id);
ALTER TABLE broadcast_clicks ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_clicks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON broadcast_clicks FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
CREATE POLICY tenant_insert ON broadcast_clicks FOR INSERT TO bodhinox_worker
  WITH CHECK (account_id=app_account_id());
GRANT SELECT ON broadcast_clicks TO bodhinox_app;
GRANT SELECT,INSERT ON broadcast_clicks TO bodhinox_worker;

-- The only cross-tenant lookup the public redirect needs: token -> its campaign's destination.
CREATE FUNCTION resolve_click_token(p_token text)
RETURNS TABLE(account_id uuid, broadcast_id uuid, recipient_id uuid, tracked_url text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT r.account_id, r.broadcast_id, r.id, b.tracked_url
  FROM broadcast_recipients r JOIN broadcasts b ON b.account_id=r.account_id AND b.id=r.broadcast_id
  WHERE r.click_token=p_token AND b.tracked_url IS NOT NULL
$$;
REVOKE ALL ON FUNCTION resolve_click_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_click_token(text) TO bodhinox_worker;

