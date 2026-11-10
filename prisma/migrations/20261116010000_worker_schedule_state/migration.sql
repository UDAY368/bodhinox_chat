-- Audit 50/56: the automation scheduler remembers the last cron minute it queued, so after a long
-- job, a restart or a deploy it queues the minutes it missed (at most 60) instead of skipping them
-- (src/lib/jobs/handlers.ts scheduleWork). One row per scheduler name; no tenant data, so it is on
-- the RLS-sweep allowlist: RLS is enabled and forced, and only the worker role has a policy and
-- grants. A new table: additive. Code running before this migration schedules the current minute
-- only, as before.
SET LOCAL lock_timeout = '5s';

CREATE TABLE worker_schedule_state (
  name text PRIMARY KEY CHECK (char_length(name) BETWEEN 1 AND 100),
  last_minute timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

ALTER TABLE worker_schedule_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_schedule_state FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_schedule_state ON worker_schedule_state FOR ALL TO bodhinox_worker USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON worker_schedule_state TO bodhinox_worker;
