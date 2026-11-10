-- Instagram Phase 1 (Stage 2): the new flow triggers and steps.
--
-- Triggers: ig_comment (a comment on a post), ig_story_reply, ig_story_mention
-- (Instagram flows only) and default_reply (both channels). Steps:
-- ig_comment_reply, ig_private_reply, send_card and send_gallery (Instagram
-- flows only). src/lib/channels/capabilities.ts keeps each in its channel; the
-- engine and the publish validator refuse anything else.
--
-- Both checks are supersets of the current ones (flows: 20261104101000_ad_referrals;
-- flow_nodes: 20261107102500_commerce_wiring), so every existing row still
-- passes. They are re-added NOT VALID and validated by
-- 20261117070100_flow_ig_triggers_validate under SHARE UPDATE EXCLUSIVE, so the
-- scan does not run while this file's ACCESS EXCLUSIVE lock is held.
-- flow_versions.trigger_type has no check. Additive.
SET LOCAL lock_timeout = '5s';

ALTER TABLE flows DROP CONSTRAINT IF EXISTS flows_trigger_type_check; -- additive-exception: re-added below as a superset (NOT VALID, validated in 20261117070100)
ALTER TABLE flows ADD CONSTRAINT flows_trigger_type_check
  CHECK (trigger_type IN ('keyword', 'first_inbound_message', 'manual', 'template_reply', 'order_received', 'ad_click',
    'default_reply', 'ig_comment', 'ig_story_reply', 'ig_story_mention')) NOT VALID;

ALTER TABLE flow_nodes DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check; -- additive-exception: re-added below as a superset (NOT VALID, validated in 20261117070100)
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
  'ig_comment_reply','ig_private_reply','send_card','send_gallery')) NOT VALID;
