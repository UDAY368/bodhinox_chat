-- Instagram Phase 3 (Stage 4): scheduled replies, both channels (Inbox). A staff
-- member writes a message now and picks when it goes out. The row is the queue:
-- it exists before the composer is told "scheduled" (queue before
-- acknowledgement), and the worker sends it once through dispatchOnce with the
-- key scheduled-reply:<id>, so an ambiguous outcome (status 'unknown') is
-- surfaced for reconciliation and never re-sent blindly.
--
--   channel    the conversation's channel when scheduled. An Instagram reply
--              must go out within 7 days of scheduling (the Human Agent
--              ceiling); whether it is inside the 24-hour window, or needs the
--              Human Agent tag and INSTAGRAM_HUMAN_AGENT_ENABLED, is decided by
--              the application at schedule time and again at send time
--              (src/lib/instagram/window.ts); a closed window ends as 'skipped'.
--   status     pending -> sending (the worker claims it; claimed_at is the lease,
--              an expired claim is taken again with the same status and the
--              outbound intent prevents a second send) | cancelled (staff) |
--              skipped (the worker: window closed, conversation closed, channel
--              off). sending -> sent | failed | unknown. unknown -> sent | failed
--              once reconciled by staff. The guard trigger holds this for every
--              role and fixes the text and time once a row leaves pending.
--   content    staff-written text (1-4096 characters; the Instagram limit of
--              1000 bytes is checked by the application). Never logged.
--   message_id the messages row the send created (set with 'sent').
-- Members read the workspace's scheduled replies. An agent or above creates one
-- as themselves; the creator or an admin changes the text and time or cancels
-- it while it is pending (column grant). The worker does the rest.
-- crm_due_scheduled_reply_accounts() lists the workspaces with work for the
-- worker's schedule (SECURITY DEFINER, worker only, ids only).
-- Additive: a new, empty table, so plain indexes are fine.
SET LOCAL lock_timeout = '5s';

CREATE TABLE scheduled_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('whatsapp','instagram')),
  created_by_user_id uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  content text NOT NULL CHECK (char_length(btrim(content)) BETWEEN 1 AND 4096),
  send_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sending','sent','failed','unknown','cancelled','skipped')),
  claimed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  message_id uuid,
  sent_at timestamptz,
  -- A machine reason only (window_closed, conversation_closed, channel_off, ...), never a message body.
  reason_code text CHECK (reason_code ~ '^[a-z0-9_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (send_at <= created_at + interval '30 days'),
  CHECK (channel <> 'instagram' OR send_at <= created_at + interval '7 days'),
  CHECK (status <> 'sent' OR (message_id IS NOT NULL AND sent_at IS NOT NULL)),
  CHECK (status NOT IN ('sending','unknown') OR claimed_at IS NOT NULL),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations(account_id, id) ON DELETE CASCADE
);
-- The worker's due scan (pending and expired claims) and the composer's list.
CREATE INDEX scheduled_replies_due_idx ON scheduled_replies (send_at) WHERE status IN ('pending','sending');
CREATE INDEX scheduled_replies_conversation_idx ON scheduled_replies (account_id, conversation_id, status);

ALTER TABLE scheduled_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_replies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON scheduled_replies FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY agent_insert ON scheduled_replies FOR INSERT TO bodhinox_app
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('agent') AND created_by_user_id = app_user_id()
    AND status = 'pending' AND claimed_at IS NULL AND message_id IS NULL AND attempts = 0);
CREATE POLICY creator_update ON scheduled_replies FOR UPDATE TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('agent') AND status = 'pending'
    AND (created_by_user_id = app_user_id() OR app_write_allowed('admin')))
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('agent') AND status IN ('pending','cancelled')
    AND (created_by_user_id = app_user_id() OR app_write_allowed('admin')));
CREATE POLICY worker_write ON scheduled_replies FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT, INSERT ON scheduled_replies TO bodhinox_app;
GRANT UPDATE (content, send_at, status) ON scheduled_replies TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON scheduled_replies TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON scheduled_replies FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- No double send, for every role (see the header).
CREATE FUNCTION scheduled_replies_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'pending' AND NEW.status IN ('sending','cancelled','skipped'))
    OR (OLD.status = 'sending' AND NEW.status IN ('sent','failed','unknown'))
    OR (OLD.status = 'unknown' AND NEW.status IN ('sent','failed'))) THEN
    RAISE EXCEPTION 'scheduled_reply_status_transition' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'pending' AND (NEW.content IS DISTINCT FROM OLD.content OR NEW.send_at IS DISTINCT FROM OLD.send_at
       OR NEW.channel IS DISTINCT FROM OLD.channel OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id) THEN
    RAISE EXCEPTION 'scheduled_reply_fixed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION scheduled_replies_guard() FROM PUBLIC;
CREATE TRIGGER scheduled_replies_guard BEFORE UPDATE ON scheduled_replies
  FOR EACH ROW EXECUTE FUNCTION scheduled_replies_guard();

CREATE FUNCTION crm_due_scheduled_reply_accounts()
RETURNS TABLE(account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT DISTINCT s.account_id FROM scheduled_replies s
  WHERE s.status IN ('pending','sending') AND s.send_at <= now()
  ORDER BY s.account_id
  LIMIT 5000
$$;
REVOKE ALL ON FUNCTION crm_due_scheduled_reply_accounts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_due_scheduled_reply_accounts() TO bodhinox_worker;
