-- Phase 4.1: new flow node kinds, per-node delays and their run-log events.
ALTER TABLE flow_nodes DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;
ALTER TABLE flow_nodes ADD CONSTRAINT flow_nodes_node_type_check CHECK (node_type IN (
  'start','send_buttons','send_list','send_message','send_media','collect_input','condition','set_tag','handoff','http_fetch','end',
  'set_attribute','ask_media','ask_location','ask_address'));

ALTER TABLE flow_run_events DROP CONSTRAINT IF EXISTS flow_run_events_event_type_check;
ALTER TABLE flow_run_events ADD CONSTRAINT flow_run_events_event_type_check CHECK (event_type IN (
  'started','node_entered','message_sent','reply_received','fallback_fired','handoff','timeout','error','completed',
  'delay_scheduled','input_invalid','attribute_set'));

-- Set while a run waits out a node delay; the flow.timer job clears it.
ALTER TABLE flow_runs ADD COLUMN delay_until TIMESTAMPTZ;
