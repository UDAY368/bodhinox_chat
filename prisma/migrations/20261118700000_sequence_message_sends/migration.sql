-- Stage 5 (5H): the delivery log of sequence messages, and claims the worker
-- left behind.
--
--   sequence_message_sends  one row per subscription round, message and
--                           attempt chain: the worker inserts it as 'starting'
--                           in the same transaction that claims the
--                           subscription, before it starts the message's flow.
--                           The unique key (subscription, round, message) is
--                           the marker that stops a second start after a crash:
--                           a recovered claim finds the row and looks for the
--                           run it started instead of starting another.
--                           'sent' (the flow run started), 'skipped' (a machine
--                           reason, e.g. window_closed: nothing was sent) or
--                           'failed' (the start kept failing; no run exists).
--                           It also feeds the per-message Sent, Clicks, Open
--                           rate and CTR. round_started_at is the
--                           subscription's subscribed_at, so a contact who
--                           subscribes again receives the messages again.
--                           Written by the worker only; members read it.
--
--   crm_due_sequence_accounts() also lists workspaces whose claim expired (a
--   worker that stopped mid-send), so the claim is recovered even when nothing
--   else is due. Same SECURITY DEFINER rules as before: worker only, ids only.
-- Additive: a new table and a replaced function body.
SET LOCAL lock_timeout = '5s';

CREATE TABLE sequence_message_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL,
  round_started_at timestamptz NOT NULL,
  sequence_id uuid NOT NULL,
  sequence_message_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  conversation_id uuid,
  flow_id uuid,
  flow_run_id uuid,
  status text NOT NULL DEFAULT 'starting' CHECK (status IN ('starting','sent','skipped','failed')),
  reason text CHECK (reason IS NULL OR reason IN ('window_closed','flow_not_live','inactive','no_conversation',
    'unavailable','channel_off','start_failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('skipped','failed')) = (reason IS NOT NULL)),
  CHECK (status <> 'sent' OR flow_run_id IS NOT NULL),
  UNIQUE (account_id, id),
  UNIQUE (account_id, subscription_id, round_started_at, sequence_message_id),
  FOREIGN KEY (account_id, subscription_id) REFERENCES sequence_subscriptions(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, sequence_id) REFERENCES sequences(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, sequence_message_id) REFERENCES sequence_messages(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations(account_id, id) ON DELETE SET NULL (conversation_id)
);
CREATE INDEX sequence_message_sends_stats_idx ON sequence_message_sends (account_id, sequence_id, sequence_message_id);

ALTER TABLE sequence_message_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_message_sends FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON sequence_message_sends FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY worker_write ON sequence_message_sends FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT ON sequence_message_sends TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE ON sequence_message_sends TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON sequence_message_sends FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- The lease matches SEQUENCE_CLAIM_LEASE_MS in src/lib/sequences/worker.ts.
CREATE OR REPLACE FUNCTION crm_due_sequence_accounts()
RETURNS TABLE(account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT DISTINCT s.account_id FROM sequence_subscriptions s
  JOIN sequences q ON q.account_id = s.account_id AND q.id = s.sequence_id
  WHERE q.status = 'active'
    AND ((s.status = 'active' AND s.next_due_at <= now())
      OR (s.status = 'sending' AND s.claimed_at < now() - interval '10 minutes'))
  ORDER BY s.account_id
  LIMIT 5000
$$;
REVOKE ALL ON FUNCTION crm_due_sequence_accounts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_due_sequence_accounts() TO bodhinox_worker;
