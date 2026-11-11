-- Instagram Phase 1 (Stage 2): validate the trigger and step checks that
-- 20261117070000_flow_ig_triggers re-added NOT VALID. VALIDATE CONSTRAINT holds
-- SHARE UPDATE EXCLUSIVE, so flow reads and writes continue during the scan.
-- Every existing row already passed the narrower checks. Additive.
SET LOCAL lock_timeout = '5s';

ALTER TABLE flows VALIDATE CONSTRAINT flows_trigger_type_check;
ALTER TABLE flow_nodes VALIDATE CONSTRAINT flow_nodes_node_type_check;
