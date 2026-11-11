-- Stage 5 (5A): widen the flow step type check for the new steps: actions,
-- randomizer, smart_delay and google_sheets (src/lib/flows/types.ts
-- STAGE5_NODE_TYPES; the engine runs them from 5B, and until then the publish
-- validator refuses them).
--
-- The check is a superset of the current one (20261117070000_flow_ig_triggers),
-- so every existing row still passes. It is re-added NOT VALID and validated by
-- 20261118001200_stage5_validate under SHARE UPDATE EXCLUSIVE.
--
-- Checked while writing this migration: flows.trigger_type gains no value in
-- Stage 5 (extra triggers live in flows.extra_triggers), and automations
-- .trigger_type and automation_steps.step_type carry no CHECK constraint (the
-- foundation declares them as plain text), so the new automation trigger types
-- tag_removed and field_changed and the start_flow step need no DDL.
-- flow_versions stores nodes as jsonb, with no type check. Additive.
SET LOCAL lock_timeout = '5s';

ALTER TABLE flow_nodes DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check; -- additive-exception: re-added below as a superset (NOT VALID, validated in 20261118001200)
ALTER TABLE flow_nodes ADD CONSTRAINT flow_nodes_node_type_check CHECK (node_type IN (
  'start','send_buttons','send_list','send_message','send_media','collect_input','condition','set_tag','handoff','http_fetch','end',
  'set_attribute','ask_media','ask_location','ask_address',
  'send_template','api_request','connect_flow','assign_agent',
  'send_form',
  'send_product','send_product_list','send_catalog','payment_link',
  'ai_reply',
  'conversion_event',
  'book_appointment',
  'send_storefront_link',
  'ig_comment_reply','ig_private_reply','send_card','send_gallery',
  'actions','randomizer','smart_delay','google_sheets')) NOT VALID;
