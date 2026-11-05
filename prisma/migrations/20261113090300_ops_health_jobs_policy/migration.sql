-- Phase 15: lets crm_ops_health() (SECURITY DEFINER, owned by the migration owner)
-- read jobs when the owner is subject to its forced RLS. Railway's default owner is
-- a superuser, which bypasses RLS: then this does nothing and takes no lock.
-- Otherwise CREATE POLICY takes ACCESS EXCLUSIVE on jobs for a moment, waiting at
-- most 5 s (lock_timeout). One hot table per migration (outbound_intents first, then
-- jobs) so the two locks are never held together; send paths lock them in either order.
-- If it aborts on lock_timeout, prisma migrate deploy records a failed migration (P3009):
-- prisma migrate resolve --rolled-back 20261113090300_ops_health_jobs_policy, then re-run
-- (docs/runbooks/release-rollback.md).
SET LOCAL lock_timeout = '5s';

DO $$ BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('CREATE POLICY ops_health_owner ON jobs FOR SELECT TO %I USING (true)', current_user); -- additive-exception: owner-only read policy, skipped for a superuser owner
  END IF;
END $$;
