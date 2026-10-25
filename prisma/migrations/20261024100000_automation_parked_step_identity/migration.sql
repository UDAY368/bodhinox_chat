-- Keep the identity after step deletion so the runner can expire stale continuations.
ALTER TABLE automation_pending_executions ADD COLUMN parked_step_id uuid;
