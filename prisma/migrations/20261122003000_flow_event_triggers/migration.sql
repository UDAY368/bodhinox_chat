-- Automation list: three event triggers for flows.
--
-- contact_created: the inbound message that created the contact.
-- tag_added:       a tag newly added to the contact (started by the tag writer,
--                  src/lib/contacts/tag-events.ts, on the contact's conversation).
-- outside_hours:   any inbound message while the workspace is outside its
--                  working hours (workspace_inbox_settings).
-- All run on WhatsApp and Instagram (src/lib/channels/capabilities.ts). No new
-- step types and no new tables.
--
-- Named after 20261121000100 on purpose: 20261117190300 re-adds this check,
-- so on a fresh database the superset must apply after it.
-- The check is a superset of the current one (20261117190300), so every
-- existing row still passes. It is re-added NOT VALID and validated by
-- 20261122003100_flow_event_triggers_validate under SHARE UPDATE EXCLUSIVE.
-- flow_versions.trigger_type has no check. Additive.
SET LOCAL lock_timeout = '5s';

ALTER TABLE flows DROP CONSTRAINT IF EXISTS flows_trigger_type_check; -- additive-exception: re-added below as a superset (NOT VALID, validated in 20261122003100)
ALTER TABLE flows ADD CONSTRAINT flows_trigger_type_check
  CHECK (trigger_type IN ('keyword', 'first_inbound_message', 'manual', 'template_reply', 'order_received', 'ad_click',
    'default_reply', 'ig_comment', 'ig_story_reply', 'ig_story_mention', 'ig_live_comment', 'ig_ref', 'ig_share_to_story',
    'contact_created', 'tag_added', 'outside_hours')) NOT VALID;
