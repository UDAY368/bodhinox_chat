-- Instagram Phase 3 (Stage 4): validate the trigger check that
-- 20261117190300_flow_ig_share_trigger re-added NOT VALID. VALIDATE CONSTRAINT
-- holds SHARE UPDATE EXCLUSIVE, so flow reads and writes continue during the
-- scan. Every existing row already passed the narrower check. Additive.
SET LOCAL lock_timeout = '5s';

ALTER TABLE flows VALIDATE CONSTRAINT flows_trigger_type_check;
