SET LOCAL lock_timeout = '5s';

-- Store plan Phase 8, batch 7: shop insights. Additive; two new tables, no change to an existing one.
-- shop_live_hits: the live view's counter. One row per (workspace, minute, page key), hits only: no address, no user agent, no cookie,
--   nothing that tells one visitor from another. The page key is one of a fixed set (home, all, search, cart, links, other) or
--   product:/category:/page: plus an id or slug. The worker (the public beacon) writes; admins read; rows older than two hours are deleted
--   by the beacon itself, by the admin read and by the hourly retention sweep. The per-minute total and the number of distinct pages per
--   minute are capped in code, so a flood cannot grow the table.
-- shop_redirects: admin-defined old shop path -> new shop path (both relative to /s/<handle>; never another host), 301 or 302.
--   At most 200 per workspace (a trigger enforces it). Loops are refused in code; the public page also stops after a few hops.
-- If it aborts on lock_timeout: prisma migrate resolve --rolled-back 20261201006000_shop_insights.

CREATE TABLE shop_live_hits (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  minute timestamptz NOT NULL,
  page text NOT NULL CHECK (page ~ '^(home|all|search|cart|links|other|(product|category|page):[0-9a-z-]{1,64})$'),
  hits integer NOT NULL DEFAULT 1 CHECK (hits BETWEEN 1 AND 100000),
  PRIMARY KEY (account_id, minute, page)
);

CREATE TABLE shop_redirects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  from_path text NOT NULL CHECK (from_path ~ '^/[A-Za-z0-9._~%/-]{1,199}$' AND from_path !~ '//' AND from_path !~ '\.\.'),
  to_path text NOT NULL CHECK (to_path ~ '^/[A-Za-z0-9._~%/-]{0,199}$' AND to_path !~ '//' AND to_path !~ '\.\.'),
  status_code smallint NOT NULL DEFAULT 301 CHECK (status_code IN (301, 302)),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, from_path),
  CHECK (from_path <> to_path)
);

CREATE FUNCTION shop_redirects_cap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM shop_redirects WHERE account_id = NEW.account_id) >= 200 THEN
    RAISE EXCEPTION 'redirect_limit' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shop_redirects_cap BEFORE INSERT ON shop_redirects FOR EACH ROW EXECUTE FUNCTION shop_redirects_cap();

-- ================================================================ RLS
ALTER TABLE shop_live_hits ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_live_hits FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON shop_live_hits FOR SELECT TO bodhinox_app USING (account_id=app_account_id() AND app_write_allowed('admin'));
-- Admins also clear old rows when they open the report.
CREATE POLICY tenant_delete ON shop_live_hits FOR DELETE TO bodhinox_app USING (account_id=app_account_id() AND app_write_allowed('admin'));
CREATE POLICY worker_write ON shop_live_hits FOR ALL TO bodhinox_worker USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT SELECT, DELETE ON shop_live_hits TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON shop_live_hits TO bodhinox_worker;

ALTER TABLE shop_redirects ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_redirects FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON shop_redirects FOR SELECT TO bodhinox_app,bodhinox_worker USING (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY tenant_write ON shop_redirects FOR ALL TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin')) WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
GRANT SELECT, INSERT, DELETE ON shop_redirects TO bodhinox_app;
GRANT SELECT ON shop_redirects TO bodhinox_worker;
