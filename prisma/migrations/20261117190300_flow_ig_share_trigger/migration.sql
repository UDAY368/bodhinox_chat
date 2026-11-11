-- Instagram Phase 3 (Stage 4): the Share-to-Story flow trigger.
--
-- ig_share_to_story: someone shares one of the account's posts or reels to their
-- story. It exists only if Meta delivers that event to Instagram Login apps; the
-- payload is not yet seen live, so the trigger stays behind
-- INSTAGRAM_SHARE_TO_STORY_ENABLED (and INSTAGRAM_ENABLED) and the value here
-- only lets a flow with this trigger be stored. Instagram flows only;
-- src/lib/channels/capabilities.ts keeps it in its channel. No new step types.
--
-- The check is a superset of the current one (20261117130000), so every existing
-- row still passes. It is re-added NOT VALID and validated by
-- 20261117190400_flow_ig_share_trigger_validate under SHARE UPDATE EXCLUSIVE.
-- flow_versions.trigger_type has no check. Additive.
SET LOCAL lock_timeout = '5s';

ALTER TABLE flows DROP CONSTRAINT IF EXISTS flows_trigger_type_check; -- additive-exception: re-added below as a superset (NOT VALID, validated in 20261117190400)
ALTER TABLE flows ADD CONSTRAINT flows_trigger_type_check
  CHECK (trigger_type IN ('keyword', 'first_inbound_message', 'manual', 'template_reply', 'order_received', 'ad_click',
    'default_reply', 'ig_comment', 'ig_story_reply', 'ig_story_mention', 'ig_live_comment', 'ig_ref', 'ig_share_to_story')) NOT VALID;
