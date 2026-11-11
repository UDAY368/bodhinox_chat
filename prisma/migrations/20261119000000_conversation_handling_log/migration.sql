-- Who handled which chat (team management, group 1).
--
--   conversations.resolved_by   the member who resolved the conversation, set by
--                               the database when it becomes resolved: the
--                               signed-in member (app_user_id()), or NULL when
--                               it resolved without one (auto-resolve, the
--                               worker). Cleared on reopen. A write to the
--                               column itself is ignored, so no client can
--                               claim or move a resolution.
--
--   conversation_handling_events  one row per assignment change, resolve and
--                               reopen, written by an AFTER trigger on every
--                               path that changes the row (inbox, routing
--                               rules, the reassign job, member removal), with
--                               the acting member (NULL = automatic). Members
--                               read their workspace's rows; nobody writes
--                               them except this trigger. User ids carry no
--                               foreign key, so history survives a member
--                               leaving the workspace.
--
-- Additive: one nullable column, one new table, two new triggers. Nothing is
-- backfilled: earlier assignments were never recorded.
SET LOCAL lock_timeout = '5s';

ALTER TABLE conversations ADD COLUMN resolved_by uuid;

CREATE TABLE conversation_handling_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('assigned', 'unassigned', 'resolved', 'reopened')),
  from_user_id uuid,
  to_user_id uuid,
  actor_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'assigned' OR to_user_id IS NOT NULL),
  CHECK (kind <> 'unassigned' OR (from_user_id IS NOT NULL AND to_user_id IS NULL)),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations(account_id, id) ON DELETE CASCADE
);
CREATE INDEX conversation_handling_events_conversation_idx
  ON conversation_handling_events (account_id, conversation_id, created_at);
CREATE INDEX conversation_handling_events_agent_idx
  ON conversation_handling_events (account_id, to_user_id, created_at) WHERE to_user_id IS NOT NULL;

ALTER TABLE conversation_handling_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_handling_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON conversation_handling_events FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
GRANT SELECT ON conversation_handling_events TO bodhinox_app, bodhinox_worker;

-- The log is written only by the trigger function below, which runs as its
-- owner; the app and worker roles have no INSERT, UPDATE or DELETE on it.
CREATE FUNCTION log_conversation_handling() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp AS $$
DECLARE actor uuid := app_user_id();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_agent_id IS NOT NULL THEN
      INSERT INTO conversation_handling_events(account_id, conversation_id, kind, to_user_id, actor_user_id)
      VALUES (NEW.account_id, NEW.id, 'assigned', NEW.assigned_agent_id, actor);
    END IF;
    RETURN NULL;
  END IF;
  IF NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id THEN
    INSERT INTO conversation_handling_events(account_id, conversation_id, kind, from_user_id, to_user_id, actor_user_id)
    VALUES (NEW.account_id, NEW.id, CASE WHEN NEW.assigned_agent_id IS NULL THEN 'unassigned' ELSE 'assigned' END,
      OLD.assigned_agent_id, NEW.assigned_agent_id, actor);
  END IF;
  IF NEW.resolved_at IS NOT NULL AND OLD.resolved_at IS NULL THEN
    INSERT INTO conversation_handling_events(account_id, conversation_id, kind, to_user_id, actor_user_id)
    VALUES (NEW.account_id, NEW.id, 'resolved', NEW.assigned_agent_id, actor);
  ELSIF NEW.resolved_at IS NULL AND OLD.resolved_at IS NOT NULL THEN
    INSERT INTO conversation_handling_events(account_id, conversation_id, kind, to_user_id, actor_user_id)
    VALUES (NEW.account_id, NEW.id, 'reopened', NEW.assigned_agent_id, actor);
  END IF;
  RETURN NULL;
END $$;
-- The owner writes the log under its own policy (FORCE RLS applies to the owner too).
DO $$ BEGIN
  EXECUTE format('CREATE POLICY handling_log_owner ON conversation_handling_events FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
END $$;
REVOKE ALL ON FUNCTION log_conversation_handling() FROM PUBLIC;

-- No column list on the update trigger: the lifecycle trigger sets resolved_at on a
-- status-only save, so the WHEN clause compares the values instead.
CREATE TRIGGER conversation_handling_log_insert AFTER INSERT ON conversations
  -- additive-exception: a new trigger takes a brief lock on conversations; lock_timeout bounds it to 5s
  FOR EACH ROW WHEN (NEW.assigned_agent_id IS NOT NULL)
  EXECUTE FUNCTION log_conversation_handling();
CREATE TRIGGER conversation_handling_log_update AFTER UPDATE ON conversations
  -- additive-exception: a new trigger takes a brief lock on conversations; lock_timeout bounds it to 5s
  FOR EACH ROW WHEN (OLD.assigned_agent_id IS DISTINCT FROM NEW.assigned_agent_id
    OR OLD.resolved_at IS DISTINCT FROM NEW.resolved_at)
  EXECUTE FUNCTION log_conversation_handling();

-- Runs after conversation_lifecycle (BEFORE triggers fire in name order), so it sees the
-- resolved_at that trigger sets.
CREATE FUNCTION set_conversation_resolved_by() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF NEW.resolved_at IS NOT NULL AND OLD.resolved_at IS NULL THEN
    NEW.resolved_by := app_user_id();
  ELSIF NEW.resolved_at IS NULL THEN
    NEW.resolved_by := NULL;
  ELSE
    NEW.resolved_by := OLD.resolved_by;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER conversation_resolved_by BEFORE UPDATE ON conversations
  -- additive-exception: a new trigger takes a brief lock on conversations; lock_timeout bounds it to 5s
  FOR EACH ROW EXECUTE FUNCTION set_conversation_resolved_by();
