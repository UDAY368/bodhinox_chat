ALTER TABLE "flow_runs" ADD COLUMN "transition_seq" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "flow_runs" DROP CONSTRAINT "flow_runs_status_check";
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_status_check"
  CHECK (status IN ('active', 'completed', 'handed_off', 'timed_out', 'paused_by_agent', 'failed', 'cancelled'));
