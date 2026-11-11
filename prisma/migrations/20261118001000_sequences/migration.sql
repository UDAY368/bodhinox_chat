-- Stage 5 (5A, owner amendment 2): sequences (5H implements src/lib/sequences/**,
-- the routes, the Instagram Sequences tab and the worker).
--
--   sequences               name, channel, status. Only Instagram sequences are
--                           built this stage (WhatsApp needs approved templates
--                           outside its window); the check allows both channels
--                           so the column does not change later.
--   sequence_messages       ordered messages: a delay after the previous one
--                           (at most 365 days), an Active switch, and the flow
--                           whose steps are the message (a flow of the same
--                           workspace; deleting it clears the link and the
--                           worker skips the message). Positions are unique per
--                           sequence, checked at commit so a reorder can swap.
--   sequence_subscriptions  one row per contact and sequence: the next position
--                           and when it falls due. status: active -> sending (the
--                           worker's claim, with claimed_at) -> active | completed;
--                           any -> unsubscribed. The worker re-checks the 24-hour
--                           window when a message falls due, skips and logs
--                           window_closed outside it, and sends through outbound
--                           intents (never twice).
--
-- crm_due_sequence_accounts() lists workspaces with a due subscription of an
-- active sequence for the worker's schedule: SECURITY DEFINER, worker only, ids
-- only, because the scheduler runs before any workspace is chosen. FORCE RLS
-- binds the definer's owner too, so the owner gets read policies on the two
-- tables it reads (pattern 20261102020000_click_token_owner_policy).
-- Agents and above manage sequences and subscriptions; members read them.
-- Additive: new tables and a new function.
SET LOCAL lock_timeout = '5s';

CREATE TABLE sequences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('whatsapp','instagram')),
  name text NOT NULL CHECK (char_length(btrim(name)) >= 1 AND char_length(name) <= 100),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','archived')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)
);
CREATE INDEX sequences_account_channel_idx ON sequences (account_id, channel, status);

CREATE TABLE sequence_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  sequence_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 49),
  delay_amount integer NOT NULL CHECK (delay_amount >= 0),
  delay_unit text NOT NULL CHECK (delay_unit IN ('minutes','hours','days')),
  active boolean NOT NULL DEFAULT true,
  flow_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- At most 365 days after the previous message.
  CHECK (delay_amount * CASE delay_unit WHEN 'minutes' THEN 1 WHEN 'hours' THEN 60 ELSE 1440 END <= 525600),
  UNIQUE (account_id, id),
  CONSTRAINT sequence_messages_position_key UNIQUE (account_id, sequence_id, position) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (account_id, sequence_id) REFERENCES sequences(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, flow_id) REFERENCES flows(account_id, id) ON DELETE SET NULL (flow_id)
);

CREATE TABLE sequence_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  sequence_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  subscribed_at timestamptz NOT NULL DEFAULT now(),
  next_position integer NOT NULL DEFAULT 0 CHECK (next_position BETWEEN 0 AND 50),
  next_due_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','sending','completed','unsubscribed')),
  claimed_at timestamptz,
  ended_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'sending' OR claimed_at IS NOT NULL),
  CHECK ((status IN ('completed','unsubscribed')) = (ended_at IS NOT NULL)),
  UNIQUE (account_id, id),
  UNIQUE (account_id, sequence_id, contact_id),
  FOREIGN KEY (account_id, sequence_id) REFERENCES sequences(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE CASCADE
);
CREATE INDEX sequence_subscriptions_due_idx ON sequence_subscriptions (next_due_at) WHERE status = 'active';
CREATE INDEX sequence_subscriptions_contact_idx ON sequence_subscriptions (account_id, contact_id);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['sequences','sequence_messages','sequence_subscriptions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT TO bodhinox_app, bodhinox_worker USING (account_id = app_account_id())', t);
    EXECUTE format('CREATE POLICY tenant_write ON %I FOR ALL TO bodhinox_app, bodhinox_worker '
      || 'USING (account_id = app_account_id() AND app_write_allowed(%L)) WITH CHECK (account_id = app_account_id() AND app_write_allowed(%L))', t, 'agent', 'agent');
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO bodhinox_app, bodhinox_worker', t);
    EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()', t);
  END LOOP;
  EXECUTE format('CREATE POLICY sequences_definer_owner ON sequences FOR SELECT TO %I USING (true)', current_user);
  EXECUTE format('CREATE POLICY sequences_definer_owner ON sequence_subscriptions FOR SELECT TO %I USING (true)', current_user);
END $$;

CREATE FUNCTION crm_due_sequence_accounts()
RETURNS TABLE(account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT DISTINCT s.account_id FROM sequence_subscriptions s
  JOIN sequences q ON q.account_id = s.account_id AND q.id = s.sequence_id
  WHERE s.status = 'active' AND s.next_due_at <= now() AND q.status = 'active'
  ORDER BY s.account_id
  LIMIT 5000
$$;
REVOKE ALL ON FUNCTION crm_due_sequence_accounts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_due_sequence_accounts() TO bodhinox_worker;
