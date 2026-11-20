-- Batch 5: flows start on the event feed's business events (src/lib/events, flows/event-start.ts):
-- orders, payments, form answers, deal stage moves, abandoned carts and appointments. The events.dispatch
-- job starts the run on the contact's WhatsApp conversation; no new table, no new step type.
--
-- The check is a superset of the current one (20261123014000_flow_event_triggers), so every existing
-- row still passes. It is re-added NOT VALID and validated by
-- 20261205006100_flow_domain_event_triggers_validate under SHARE UPDATE EXCLUSIVE.
-- automations.trigger_type has no check (rules need no DDL). flow_versions.trigger_type has no check. Additive.
SET LOCAL lock_timeout = '5s';

ALTER TABLE flows DROP CONSTRAINT IF EXISTS flows_trigger_type_check; -- additive-exception: re-added below as a superset (NOT VALID, validated in 20261205006100)
ALTER TABLE flows ADD CONSTRAINT flows_trigger_type_check
  CHECK (trigger_type IN ('keyword', 'first_inbound_message', 'manual', 'template_reply', 'order_received', 'ad_click',
    'default_reply', 'ig_comment', 'ig_story_reply', 'ig_story_mention', 'ig_live_comment', 'ig_ref', 'ig_share_to_story',
    'contact_created', 'tag_added', 'outside_hours',
    'order_created', 'order_paid', 'order_shipped', 'order_delivered', 'order_returned', 'payment_received',
    'form_submitted', 'deal_stage_changed', 'cart_abandoned',
    'appointment_booked', 'appointment_cancelled', 'appointment_rescheduled', 'appointment_completed', 'appointment_no_show')) NOT VALID;
