-- Audit 38: lets crm_platform_requeue_job() (SECURITY DEFINER, owned by the migration owner)
-- update a failed job when the owner is subject to jobs' forced RLS. Railway's default owner is a
-- superuser, which bypasses RLS: then this does nothing and takes no lock. Otherwise CREATE POLICY
-- takes ACCESS EXCLUSIVE on jobs for a moment, waiting at most 5 s (lock_timeout). Alone in its
-- migration so the hot-table lock is never held with another. If it aborts on lock_timeout,
-- prisma migrate deploy records a failed migration (P3009):
-- prisma migrate resolve --rolled-back 20261116010100_platform_job_requeue_policy, then re-run
-- (docs/runbooks/release-rollback.md).
SET LOCAL lock_timeout = '5s';

DO $$ BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('CREATE POLICY platform_owner_requeue ON jobs FOR UPDATE TO %I USING (true) WITH CHECK (true)', current_user); -- additive-exception: owner-only update policy for the audited requeue definer, skipped for a superuser owner
  END IF;
END $$;
