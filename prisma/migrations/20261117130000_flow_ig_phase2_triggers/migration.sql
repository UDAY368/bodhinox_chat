-- Instagram Phase 2 (Stage 3): the new flow triggers.
--
-- ig_live_comment (a comment on the account's Instagram Live broadcast) and
-- ig_ref (a chat opened from an ig.me ref link), both Instagram flows only;
-- src/lib/channels/capabilities.ts keeps each in its channel, and the engine
-- and the publish validator refuse anything else. No new step types.
--
-- The check is a superset of the current one (20261117070000_flow_ig_triggers),
-- so every existing row still passes. It is re-added NOT VALID and validated by
-- 20261117130100_flow_ig_phase2_triggers_validate under SHARE UPDATE EXCLUSIVE,
-- so the scan does not run while this file's ACCESS EXCLUSIVE lock is held.
-- flow_versions.trigger_type has no check. Additive.
SET LOCAL lock_timeout = '5s';

ALTER TABLE flows DROP CONSTRAINT IF EXISTS flows_trigger_type_check; -- additive-exception: re-added below as a superset (NOT VALID, validated in 20261117130100)
ALTER TABLE flows ADD CONSTRAINT flows_trigger_type_check
  CHECK (trigger_type IN ('keyword', 'first_inbound_message', 'manual', 'template_reply', 'order_received', 'ad_click',
    'default_reply', 'ig_comment', 'ig_story_reply', 'ig_story_mention', 'ig_live_comment', 'ig_ref')) NOT VALID;
