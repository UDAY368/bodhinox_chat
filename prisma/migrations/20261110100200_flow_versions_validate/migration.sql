-- Phase 12: validate the run-to-version foreign key 20261110100000_flow_versions
-- added NOT VALID. VALIDATE CONSTRAINT holds SHARE UPDATE EXCLUSIVE on
-- flow_runs (plus ROW SHARE on flow_versions), so the flow engine keeps
-- reading and writing runs during the scan. New rows were already checked
-- from the moment the constraint was added. Same pattern as
-- 20261109101400_conversation_channel_validate. Additive.
SET LOCAL lock_timeout = '5s';
ALTER TABLE flow_runs VALIDATE CONSTRAINT flow_runs_flow_version_fkey;
