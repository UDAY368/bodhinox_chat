-- Phase 15: worker liveness. The worker upserts one row per process at start
-- and every 15 s (src/lib/jobs/worker-loop.ts); crm_ops_health() reads the
-- newest beat for the token-protected deep health check. No tenant data, so it
-- is on the RLS-sweep allowlist: RLS is still enabled and forced, and only the
-- worker role has a policy and grants. A new table: additive.
SET LOCAL lock_timeout = '5s';

CREATE TABLE worker_heartbeats (
  worker_id text PRIMARY KEY CHECK (char_length(worker_id) BETWEEN 1 AND 200),
  started_at timestamptz NOT NULL,
  beat_at timestamptz NOT NULL,
  release text CHECK (release IS NULL OR char_length(release) <= 200),
  current_job_type text CHECK (current_job_type IS NULL OR char_length(current_job_type) <= 200),
  schedule_failures integer NOT NULL DEFAULT 0 CHECK (schedule_failures >= 0)
);

ALTER TABLE worker_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_heartbeats FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_heartbeat ON worker_heartbeats FOR ALL TO bodhinox_worker USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON worker_heartbeats TO bodhinox_worker;
-- The migration owner reads it inside the crm_ops_health() definer (FORCE applies to the owner too).
DO $$ BEGIN
  EXECUTE format('CREATE POLICY ops_health_owner ON worker_heartbeats FOR SELECT TO %I USING (true)', current_user);
END $$;
