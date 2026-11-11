-- Instagram Phase 3 (Stage 4): reminders and snooze on a conversation, both
-- channels (Inbox). A reminder tells its owner to look at a conversation again at
-- a time; a snooze is the same row with kind 'snooze' and also hides the
-- conversation from the owner's open list until then. Staff text only (the note);
-- no customer content is stored here.
--
--   user_id    who is reminded and who owns the row (reminders are personal; a
--              removed user's rows go with them).
--   remind_at  at most a year ahead (checked against created_at).
--   status     pending -> fired (the worker, once due) | dismissed | cancelled
--              (the owner); fired -> dismissed. The guard trigger holds this for
--              every role and fixes remind_at, note and kind once a row leaves
--              pending.
-- One pending snooze per conversation and person (partial unique index).
-- Members read the workspace's reminders; an agent or above writes only their
-- own rows (insert as pending, change remind_at, note and status through the
-- column grant). The worker fires reminders and may write everything.
-- crm_due_conversation_reminder_accounts() lists the workspaces with a due
-- pending reminder for the worker's schedule (SECURITY DEFINER, worker only, ids
-- only), because the scheduler runs before any workspace is chosen.
-- Additive: a new, empty table, so plain indexes are fine.
SET LOCAL lock_timeout = '5s';

CREATE TABLE conversation_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'reminder' CHECK (kind IN ('reminder','snooze')),
  remind_at timestamptz NOT NULL,
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','fired','dismissed','cancelled')),
  fired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (remind_at <= created_at + interval '366 days'),
  CHECK (status <> 'fired' OR fired_at IS NOT NULL),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations(account_id, id) ON DELETE CASCADE
);
-- The worker's due scan and the owner's list.
CREATE INDEX conversation_reminders_due_idx ON conversation_reminders (remind_at) WHERE status = 'pending';
CREATE INDEX conversation_reminders_owner_idx ON conversation_reminders (account_id, user_id, status, remind_at);
CREATE INDEX conversation_reminders_conversation_idx ON conversation_reminders (account_id, conversation_id);
CREATE UNIQUE INDEX conversation_reminders_one_snooze ON conversation_reminders (account_id, conversation_id, user_id)
  WHERE kind = 'snooze' AND status = 'pending';

ALTER TABLE conversation_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_reminders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON conversation_reminders FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY own_insert ON conversation_reminders FOR INSERT TO bodhinox_app
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('agent') AND user_id = app_user_id()
    AND status = 'pending' AND fired_at IS NULL);
CREATE POLICY own_update ON conversation_reminders FOR UPDATE TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('agent') AND user_id = app_user_id())
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('agent') AND user_id = app_user_id()
    AND status IN ('pending','dismissed','cancelled'));
CREATE POLICY worker_write ON conversation_reminders FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT, INSERT ON conversation_reminders TO bodhinox_app;
GRANT UPDATE (remind_at, note, status) ON conversation_reminders TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON conversation_reminders TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON conversation_reminders FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Status moves forward only and a decided row is fixed, for every role.
CREATE FUNCTION conversation_reminders_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'pending' AND NEW.status IN ('fired','dismissed','cancelled'))
    OR (OLD.status = 'fired' AND NEW.status = 'dismissed')) THEN
    RAISE EXCEPTION 'conversation_reminder_status_transition' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'pending' AND (NEW.remind_at IS DISTINCT FROM OLD.remind_at OR NEW.note IS DISTINCT FROM OLD.note
       OR NEW.kind IS DISTINCT FROM OLD.kind) THEN
    RAISE EXCEPTION 'conversation_reminder_fixed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION conversation_reminders_guard() FROM PUBLIC;
CREATE TRIGGER conversation_reminders_guard BEFORE UPDATE ON conversation_reminders
  FOR EACH ROW EXECUTE FUNCTION conversation_reminders_guard();

CREATE FUNCTION crm_due_conversation_reminder_accounts()
RETURNS TABLE(account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT DISTINCT r.account_id FROM conversation_reminders r
  WHERE r.status = 'pending' AND r.remind_at <= now()
  ORDER BY r.account_id
  LIMIT 5000
$$;
REVOKE ALL ON FUNCTION crm_due_conversation_reminder_accounts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_due_conversation_reminder_accounts() TO bodhinox_worker;
