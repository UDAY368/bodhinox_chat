-- Batch 7: WhatsApp sequences and "Exit when" (src/lib/sequences/**).
--
--   sequences               exit_on_reply, exit_on_tag_id, exit_on_purchase:
--                           the worker stops a subscriber before a step when
--                           they wrote after joining, carry the tag, or have a
--                           paid order created after joining (pull-based, at
--                           send time). Deleting the tag clears the setting.
--   sequence_messages       a WhatsApp step's own content (text and/or one
--                           image, video or document) and the approved
--                           template sent instead when the contact's 24-hour
--                           window is closed, with its body values as
--                           placeholder text ({{contact.name|there}}).
--                           Instagram steps keep using flow_id.
--   sequence_subscriptions  exit_reason: why a subscriber was stopped
--                           (replied, tagged, purchased, opted_out, blocked).
--   sequence_message_sends  channel_message_id (the WhatsApp message id of a
--                           sent step: a WhatsApp send has no flow run) and
--                           sent_as (message | template); the reason list
--                           gains the WhatsApp reasons, e.g.
--                           outside_window_no_template. Each WhatsApp send goes
--                           through an outbound intent keyed by the send row,
--                           so a retry after an ambiguous result never sends
--                           twice (outcome_unknown is surfaced, not cleared).
--
-- crm_due_sequence_accounts(boolean): the same due list, leaving Instagram
-- sequences out while Instagram is off (WhatsApp sequences still run). Same
-- SECURITY DEFINER rules: worker only, ids only.
-- Additive: new nullable/defaulted columns, NOT VALID constraints validated
-- in place (the new columns are all NULL or default), two check constraints
-- replaced by supersets, and a new function overload.
SET LOCAL lock_timeout = '5s';

ALTER TABLE sequences
  ADD COLUMN exit_on_reply boolean NOT NULL DEFAULT false,
  ADD COLUMN exit_on_purchase boolean NOT NULL DEFAULT false,
  ADD COLUMN exit_on_tag_id uuid;
ALTER TABLE sequences ADD CONSTRAINT sequences_exit_tag_fkey FOREIGN KEY (account_id, exit_on_tag_id)
  REFERENCES tags(account_id, id) ON DELETE SET NULL (exit_on_tag_id) NOT VALID;

ALTER TABLE sequence_messages
  ADD COLUMN wa_text text,
  ADD COLUMN wa_media_type text,
  ADD COLUMN wa_media_url text,
  ADD COLUMN wa_media_filename text,
  ADD COLUMN template_name text,
  ADD COLUMN template_language text,
  ADD COLUMN template_params jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE sequence_messages ADD CONSTRAINT sequence_messages_wa_content_check CHECK (
  (wa_text IS NULL OR char_length(wa_text) <= 4096)
  AND (wa_media_type IS NULL OR wa_media_type IN ('image','video','document'))
  AND ((wa_media_type IS NULL) = (wa_media_url IS NULL))
  AND (wa_media_url IS NULL OR char_length(wa_media_url) <= 2048)
  AND (wa_media_filename IS NULL OR char_length(wa_media_filename) <= 240)
  AND (template_name IS NULL OR char_length(template_name) <= 512)
  AND (template_language IS NULL OR (template_name IS NOT NULL AND char_length(template_language) <= 15))
  AND jsonb_typeof(template_params) = 'array' AND jsonb_array_length(template_params) <= 20
) NOT VALID;
ALTER TABLE sequence_messages VALIDATE CONSTRAINT sequence_messages_wa_content_check;

ALTER TABLE sequence_subscriptions ADD COLUMN exit_reason text;
ALTER TABLE sequence_subscriptions ADD CONSTRAINT sequence_subscriptions_exit_reason_check
  CHECK (exit_reason IS NULL OR exit_reason IN ('replied','tagged','purchased','opted_out','blocked')) NOT VALID;
ALTER TABLE sequence_subscriptions VALIDATE CONSTRAINT sequence_subscriptions_exit_reason_check;

ALTER TABLE sequence_message_sends
  ADD COLUMN channel_message_id text,
  ADD COLUMN sent_as text;
ALTER TABLE sequence_message_sends ADD CONSTRAINT sequence_message_sends_sent_as_check
  CHECK (sent_as IS NULL OR sent_as IN ('message','template')) NOT VALID;
ALTER TABLE sequence_message_sends VALIDATE CONSTRAINT sequence_message_sends_sent_as_check;
ALTER TABLE sequence_message_sends DROP CONSTRAINT sequence_message_sends_reason_check; -- additive-exception: replaced below by a superset
ALTER TABLE sequence_message_sends ADD CONSTRAINT sequence_message_sends_reason_check CHECK (reason IS NULL OR reason IN (
  'window_closed','flow_not_live','inactive','no_conversation','unavailable','channel_off','start_failed',
  'outside_window_no_template','template_unavailable','no_content','bot_paused','provider_rejected','outcome_unknown')) NOT VALID;
ALTER TABLE sequence_message_sends VALIDATE CONSTRAINT sequence_message_sends_reason_check;
-- A sent Instagram step has its flow run; a sent WhatsApp step has its message id.
ALTER TABLE sequence_message_sends DROP CONSTRAINT sequence_message_sends_check1; -- additive-exception: replaced below by a superset
ALTER TABLE sequence_message_sends ADD CONSTRAINT sequence_message_sends_sent_check
  CHECK (status <> 'sent' OR flow_run_id IS NOT NULL OR channel_message_id IS NOT NULL) NOT VALID;
ALTER TABLE sequence_message_sends VALIDATE CONSTRAINT sequence_message_sends_sent_check;

-- The lease matches SEQUENCE_CLAIM_LEASE_MS in src/lib/sequences/worker.ts.
CREATE FUNCTION crm_due_sequence_accounts(p_include_instagram boolean)
RETURNS TABLE(account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT DISTINCT s.account_id FROM sequence_subscriptions s
  JOIN sequences q ON q.account_id = s.account_id AND q.id = s.sequence_id
  WHERE q.status = 'active' AND (q.channel = 'whatsapp' OR p_include_instagram)
    AND ((s.status = 'active' AND s.next_due_at <= now())
      OR (s.status = 'sending' AND s.claimed_at < now() - interval '10 minutes'))
  ORDER BY s.account_id
  LIMIT 5000
$$;
REVOKE ALL ON FUNCTION crm_due_sequence_accounts(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_due_sequence_accounts(boolean) TO bodhinox_worker;
