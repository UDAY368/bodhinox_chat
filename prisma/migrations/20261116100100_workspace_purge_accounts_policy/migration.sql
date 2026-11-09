-- Data retention, part 2: lets crm_workspace_purge_check / _finish (SECURITY DEFINER,
-- owned by the migration owner) lock and delete one accounts row when the owner is
-- subject to the table's forced RLS. Railway's default owner is a superuser, which
-- bypasses RLS: then this does nothing and takes no lock. Otherwise CREATE POLICY takes
-- ACCESS EXCLUSIVE on accounts for a moment, waiting at most 5 s (lock_timeout); it is
-- the only table in this migration. If it aborts on lock_timeout, prisma migrate deploy
-- records a failed migration (P3009): prisma migrate resolve --rolled-back
-- 20261116100100_workspace_purge_accounts_policy, then re-run (docs/runbooks/release-rollback.md).
SET LOCAL lock_timeout = '5s';

DO $$ BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('CREATE POLICY workspace_purge_owner ON accounts FOR ALL TO %I USING (true) WITH CHECK (true)', current_user); -- additive-exception: owner-only policy for the purge functions, skipped for a superuser owner
  END IF;
END $$;
