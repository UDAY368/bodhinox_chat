-- Phase 5: inbox premium foundation. Internal notes, conversation lifecycle and
-- first-response SLA, routing rules, workspace inbox settings (working hours,
-- away message, auto-resolve), per-member phone masking, notification
-- preferences and an email digest queue, saved filters, quick-reply favourites
-- and media-library columns.
--
-- All additive. Every ADD COLUMN below has a constant default (metadata-only on
-- PostgreSQL 11+). The conversations backfill runs with the outbox and
-- updated_at triggers disabled, as in 20261102090000_whatsapp_multi_number, so
-- deploying it neither floods realtime nor reorders the inbox.
--
-- Message full-text search is a separate migration
-- (20261102120500_messages_search_index): it builds its index CONCURRENTLY,
-- which PostgreSQL only allows outside a multi-statement transaction.

-- ================================================================ conversations
-- lifecycle_state sits beside the existing status column (open/pending/closed),
-- which keeps its meaning and stays the source of truth for "closed":
--   bot        open, unassigned, a bot (flow or AI auto-reply) is handling it
--   requesting open, unassigned, a person is needed
--   assigned   open, assigned_agent_id is set
--   resolved   status = 'closed'
-- A BEFORE trigger (conversation_lifecycle) keeps the two consistent for every
-- writer, including code that only knows about status and assigned_agent_id.
ALTER TABLE conversations ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'requesting'
  CONSTRAINT conversations_lifecycle_state_check
  CHECK (lifecycle_state IN ('bot', 'requesting', 'assigned', 'resolved'));
-- First-response SLA for the current open cycle; cleared on reopen.
ALTER TABLE conversations ADD COLUMN first_response_due_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN first_responded_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN resolved_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN reopened_count INTEGER NOT NULL DEFAULT 0
  CONSTRAINT conversations_reopened_count_check CHECK (reopened_count >= 0);

ALTER TABLE conversations DISABLE TRIGGER set_updated_at;
ALTER TABLE conversations DISABLE TRIGGER domain_outbox;
UPDATE conversations c SET
  lifecycle_state = CASE
    WHEN c.status = 'closed' THEN 'resolved'
    WHEN c.assigned_agent_id IS NOT NULL THEN 'assigned'
    WHEN NOT c.bot_paused AND (
      EXISTS (SELECT 1 FROM flow_runs r WHERE r.account_id = c.account_id
        AND r.conversation_id = c.id AND r.status = 'active')
      OR (NOT c.ai_autoreply_disabled AND EXISTS (SELECT 1 FROM ai_configs a
        WHERE a.account_id = c.account_id AND a.is_active AND a.auto_reply_enabled)))
      THEN 'bot'
    ELSE 'requesting' END,
  resolved_at = CASE WHEN c.status = 'closed' THEN COALESCE(c.updated_at, c.last_message_at, c.created_at) END
WHERE c.status = 'closed' OR c.assigned_agent_id IS NOT NULL OR NOT c.bot_paused;
ALTER TABLE conversations ENABLE TRIGGER domain_outbox;
ALTER TABLE conversations ENABLE TRIGGER set_updated_at;

CREATE INDEX conversations_lifecycle_idx
  ON conversations (account_id, lifecycle_state, last_message_at DESC);
-- SLA sweep: open cycles still waiting for a first human reply.
CREATE INDEX conversations_first_response_due_idx
  ON conversations (account_id, first_response_due_at)
  WHERE first_responded_at IS NULL AND first_response_due_at IS NOT NULL;

-- ================================================================ inbox settings
CREATE TABLE workspace_inbox_settings (
  account_id uuid PRIMARY KEY DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  timezone text NOT NULL DEFAULT 'UTC' CHECK (char_length(timezone) BETWEEN 1 AND 64),
  -- {"mon":[{"start":"09:00","end":"18:00"}],...}; validated in src/lib/inbox/working-hours.ts.
  working_hours jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(working_hours) = 'object' AND pg_column_size(working_hours) <= 8192),
  away_message_enabled boolean NOT NULL DEFAULT false,
  away_message text CHECK (char_length(away_message) <= 1024),
  auto_resolve_after_hours integer CHECK (auto_resolve_after_hours BETWEEN 1 AND 720),
  sla_first_response_minutes integer CHECK (sla_first_response_minutes BETWEEN 1 AND 10080),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT away_message_enabled OR char_length(btrim(COALESCE(away_message, ''))) > 0)
);
ALTER TABLE workspace_inbox_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_inbox_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON workspace_inbox_settings FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
CREATE POLICY tenant_write ON workspace_inbox_settings FOR ALL TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
GRANT SELECT,INSERT,UPDATE ON workspace_inbox_settings TO bodhinox_app;
GRANT SELECT ON workspace_inbox_settings TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON workspace_inbox_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ================================================================ lifecycle trigger
-- Keeps status <-> lifecycle_state consistent and stamps resolve/reopen/SLA.
--   * A writer that changes lifecycle_state drives status: 'resolved' closes,
--     anything else re-opens a closed row. Otherwise status drives the state.
--   * assigned_agent_id is authoritative for 'assigned': assigning moves an
--     open row to 'assigned'; unassigning moves it to 'requesting'. To hand a
--     conversation back to a bot, clear the assignee and set 'bot'.
--   * Pausing the bot (bot_paused) moves 'bot' to 'requesting'.
--   * Closing stamps resolved_at; re-opening a resolved row bumps
--     reopened_count and clears resolved_at and the SLA of the previous cycle.
--   * When an open row is outside 'bot', has no first response yet and no due
--     time, first_response_due_at = now() + the workspace's SLA (if set).
-- first_responded_at is stamped by messages_first_response below.
CREATE FUNCTION sync_conversation_lifecycle() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE was_resolved boolean := TG_OP = 'UPDATE' AND OLD.lifecycle_state = 'resolved';
  sla integer;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state THEN
    IF NEW.lifecycle_state = 'resolved' THEN NEW.status := 'closed';
    ELSIF NEW.status = 'closed' THEN NEW.status := 'open'; END IF;
  ELSIF TG_OP = 'INSERT' AND NEW.lifecycle_state = 'resolved' THEN
    NEW.status := 'closed';
  END IF;

  IF NEW.status = 'closed' THEN
    NEW.lifecycle_state := 'resolved';
    IF NOT was_resolved THEN NEW.resolved_at := now(); END IF;
    RETURN NEW;
  END IF;

  IF was_resolved THEN
    NEW.reopened_count := OLD.reopened_count + 1;
    NEW.resolved_at := NULL;
    NEW.first_responded_at := NULL;
    NEW.first_response_due_at := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    NEW.resolved_at := NULL;
  END IF;

  IF NEW.assigned_agent_id IS NOT NULL THEN NEW.lifecycle_state := 'assigned';
  ELSIF NEW.lifecycle_state IN ('assigned', 'resolved') THEN NEW.lifecycle_state := 'requesting';
  ELSIF NEW.lifecycle_state = 'bot' AND NEW.bot_paused THEN NEW.lifecycle_state := 'requesting';
  END IF;

  IF NEW.lifecycle_state <> 'bot' AND NEW.first_responded_at IS NULL AND NEW.first_response_due_at IS NULL THEN
    SELECT s.sla_first_response_minutes INTO sla FROM workspace_inbox_settings s WHERE s.account_id = NEW.account_id;
    IF sla IS NOT NULL THEN NEW.first_response_due_at := now() + make_interval(mins => sla); END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER conversation_lifecycle BEFORE INSERT OR UPDATE OF status, lifecycle_state, assigned_agent_id, bot_paused
  ON conversations FOR EACH ROW EXECUTE FUNCTION sync_conversation_lifecycle();

-- The first human (sender_type='agent') message of an open cycle records the
-- first response. Bot and automation sends do not count. Runs once per cycle:
-- the WHERE clause matches nothing after the first stamp.
CREATE FUNCTION stamp_conversation_first_response() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  UPDATE conversations SET first_responded_at = COALESCE(NEW.created_at, now())
  WHERE account_id = NEW.account_id AND id = NEW.conversation_id
    AND first_responded_at IS NULL AND lifecycle_state <> 'resolved';
  RETURN NULL;
END $$;
CREATE TRIGGER messages_first_response AFTER INSERT ON messages
  FOR EACH ROW WHEN (NEW.sender_type = 'agent') EXECUTE FUNCTION stamp_conversation_first_response();

-- ================================================================ notes
-- Internal notes. Never part of any message send path: no send code reads this
-- table. Members read; agents+ write their own; the author edits or
-- soft-deletes; admins soft-delete anyone's (they cannot edit them).
CREATE TABLE conversation_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  -- Historical author identity (kept when the member leaves), like messages.sender_id.
  author_id uuid NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  mentions uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(mentions) <= 20),
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations(account_id, id) ON DELETE CASCADE
);
CREATE INDEX conversation_notes_conversation_idx
  ON conversation_notes (account_id, conversation_id, created_at);
ALTER TABLE conversation_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON conversation_notes FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
CREATE POLICY author_insert ON conversation_notes FOR INSERT TO bodhinox_app
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('agent') AND author_id=app_user_id());
CREATE POLICY author_or_admin_update ON conversation_notes FOR UPDATE TO bodhinox_app
  USING (account_id=app_account_id() AND deleted_at IS NULL AND
    ((app_write_allowed('agent') AND author_id=app_user_id()) OR app_write_allowed('admin')))
  WITH CHECK (account_id=app_account_id() AND
    ((app_write_allowed('agent') AND author_id=app_user_id()) OR app_write_allowed('admin')));
CREATE POLICY worker_write ON conversation_notes FOR ALL TO bodhinox_worker
  USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT SELECT, INSERT ON conversation_notes TO bodhinox_app;
GRANT UPDATE (body, mentions, deleted_at) ON conversation_notes TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON conversation_notes TO bodhinox_worker;

-- Column rules RLS cannot express: only the author changes the text, a deleted
-- note is final, and edited_at is set by the database.
CREATE FUNCTION guard_conversation_note_update() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Deleted notes cannot change' USING ERRCODE = '42501';
  END IF;
  IF NEW.body IS DISTINCT FROM OLD.body OR NEW.mentions IS DISTINCT FROM OLD.mentions THEN
    IF current_user <> 'bodhinox_worker' AND OLD.author_id IS DISTINCT FROM app_user_id() THEN
      RAISE EXCEPTION 'Only the author can edit a note' USING ERRCODE = '42501';
    END IF;
    NEW.edited_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER conversation_note_guard BEFORE UPDATE ON conversation_notes
  FOR EACH ROW EXECUTE FUNCTION guard_conversation_note_update();
CREATE TRIGGER domain_outbox AFTER INSERT OR UPDATE OR DELETE ON conversation_notes
  FOR EACH ROW EXECUTE FUNCTION emit_domain_outbox_event();

-- ================================================================ routing rules
CREATE TABLE routing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  enabled boolean NOT NULL DEFAULT true,
  -- {tags_any?: uuid[], keywords_any?: string[], whatsapp_config_id?: uuid, within_working_hours?: boolean}
  conditions jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(conditions) = 'object' AND pg_column_size(conditions) <= 16384),
  -- {mode:'member', user_id} | {mode:'round_robin', user_ids:[...]}
  assign_to jsonb NOT NULL
    CHECK (jsonb_typeof(assign_to) = 'object' AND assign_to->>'mode' IN ('member', 'round_robin')
      AND pg_column_size(assign_to) <= 8192),
  reassign_after_minutes integer CHECK (reassign_after_minutes BETWEEN 1 AND 10080),
  -- Rotation position for round_robin; written by the worker.
  round_robin_last_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)
);
CREATE INDEX routing_rules_order_idx ON routing_rules (account_id, position, created_at);
ALTER TABLE routing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON routing_rules FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
CREATE POLICY tenant_write ON routing_rules FOR ALL TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
CREATE POLICY worker_update ON routing_rules FOR UPDATE TO bodhinox_worker
  USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT SELECT,INSERT,UPDATE,DELETE ON routing_rules TO bodhinox_app;
GRANT SELECT ON routing_rules TO bodhinox_worker;
GRANT UPDATE (round_robin_last_user_id) ON routing_rules TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON routing_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ================================================================ away messages
-- Once-per-window guard: insert (ON CONFLICT DO NOTHING) before queueing the
-- away message; a row means that window's message is claimed.
CREATE TABLE away_message_sends (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  window_key text NOT NULL CHECK (char_length(window_key) BETWEEN 1 AND 64),
  sent_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, conversation_id, window_key),
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations(account_id, id) ON DELETE CASCADE
);
ALTER TABLE away_message_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE away_message_sends FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON away_message_sends FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
CREATE POLICY worker_write ON away_message_sends FOR ALL TO bodhinox_worker
  USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT SELECT ON away_message_sends TO bodhinox_app;
GRANT SELECT,INSERT,DELETE ON away_message_sends TO bodhinox_worker;

-- ================================================================ phone masking
-- Admin-set per member. Owners and admins are never masked: the flag may only
-- be turned on for agents and viewers, and src/lib/inbox/masking.ts ignores it
-- for owners/admins (a promoted member keeps the stored flag harmlessly).
ALTER TABLE account_memberships ADD COLUMN mask_phone_numbers BOOLEAN NOT NULL DEFAULT false;
CREATE POLICY admin_mask_update ON account_memberships FOR UPDATE TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin')
    AND (NOT mask_phone_numbers OR role IN ('agent', 'viewer')));
GRANT UPDATE (mask_phone_numbers) ON account_memberships TO bodhinox_app;

-- ================================================================ notifications
-- Superset of 20261102113000_payment_notifications; a later replacement must
-- keep every value listed here.
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'whatsapp_number_health', 'payment_received',
    'assigned_message', 'mention', 'sla_breach', 'campaign_finished', 'template_rejected'));
-- In-app destination. Relative paths only, so a notification can never send a
-- member to another site.
ALTER TABLE notifications ADD COLUMN link TEXT
  CONSTRAINT notifications_link_check
  CHECK (link IS NULL OR (char_length(link) <= 500 AND link ~ '^/[^/\\]'));

CREATE TABLE notification_preferences (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  event text NOT NULL CHECK (event IN ('assigned_message', 'mention', 'sla_breach',
    'campaign_finished', 'template_rejected', 'number_quality')),
  in_app boolean NOT NULL DEFAULT true,
  email boolean NOT NULL DEFAULT false,
  PRIMARY KEY (account_id, user_id, event),
  FOREIGN KEY (account_id, user_id) REFERENCES account_memberships(account_id, user_id) ON DELETE CASCADE
);
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences FORCE ROW LEVEL SECURITY;
-- Members read the workspace's preferences so a sender (e.g. a mention) can
-- respect the recipient's choice; each member writes only their own.
CREATE POLICY tenant_read ON notification_preferences FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
CREATE POLICY own_write ON notification_preferences FOR ALL TO bodhinox_app
  USING (account_id=app_account_id() AND user_id=app_user_id())
  WITH CHECK (account_id=app_account_id() AND user_id=app_user_id());
GRANT SELECT,INSERT,UPDATE,DELETE ON notification_preferences TO bodhinox_app;
GRANT SELECT ON notification_preferences TO bodhinox_worker;

-- Email digest entries. Written alongside an in-app notification (or alone when
-- the member turned in-app off); a worker groups unsent rows per member and
-- marks them sent. The recipient's address is resolved by the worker, never
-- stored here.
CREATE TABLE notification_email_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  event text NOT NULL CHECK (event IN ('assigned_message', 'mention', 'sla_breach',
    'campaign_finished', 'template_rejected', 'number_quality')),
  notification_id uuid,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body text CHECK (char_length(body) <= 1000),
  link text CHECK (link IS NULL OR (char_length(link) <= 500 AND link ~ '^/[^/\\]')),
  dedupe_key text CHECK (dedupe_key IS NULL OR char_length(dedupe_key) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, user_id) REFERENCES account_memberships(account_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, notification_id) REFERENCES notifications(account_id, id) ON DELETE SET NULL (notification_id)
);
CREATE UNIQUE INDEX notification_email_queue_dedupe
  ON notification_email_queue (account_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX notification_email_queue_pending_idx
  ON notification_email_queue (account_id, user_id, created_at) WHERE sent_at IS NULL;
ALTER TABLE notification_email_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_email_queue FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_insert ON notification_email_queue FOR INSERT TO bodhinox_app
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY worker_queue ON notification_email_queue FOR ALL TO bodhinox_worker
  USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT INSERT ON notification_email_queue TO bodhinox_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON notification_email_queue TO bodhinox_worker;

-- ================================================================ saved filters
CREATE TABLE saved_filters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  filters jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(filters) = 'object' AND pg_column_size(filters) <= 8192),
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, user_id) REFERENCES account_memberships(account_id, user_id) ON DELETE CASCADE
);
CREATE INDEX saved_filters_owner_idx ON saved_filters (account_id, user_id, position);
ALTER TABLE saved_filters ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_filters FORCE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON saved_filters FOR ALL TO bodhinox_app
  USING (account_id=app_account_id() AND user_id=app_user_id())
  WITH CHECK (account_id=app_account_id() AND user_id=app_user_id());
GRANT SELECT,INSERT,UPDATE,DELETE ON saved_filters TO bodhinox_app;

-- ================================================================ quick replies
CREATE TABLE quick_reply_favourites (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  quick_reply_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id, quick_reply_id),
  FOREIGN KEY (account_id, quick_reply_id) REFERENCES quick_replies(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, user_id) REFERENCES account_memberships(account_id, user_id) ON DELETE CASCADE
);
ALTER TABLE quick_reply_favourites ENABLE ROW LEVEL SECURITY;
ALTER TABLE quick_reply_favourites FORCE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON quick_reply_favourites FOR ALL TO bodhinox_app
  USING (account_id=app_account_id() AND user_id=app_user_id())
  WITH CHECK (account_id=app_account_id() AND user_id=app_user_id());
GRANT SELECT,INSERT,DELETE ON quick_reply_favourites TO bodhinox_app;

-- ================================================================ media library
-- media_objects already has uploaded_by, content_type, byte_size, original_name,
-- created_at and deleted_at; kind is derived from content_type in code. A
-- library item is a row an agent saved for reuse (inbound mirrors stay out),
-- with an optional retention date after which a sweep may soft-delete it.
ALTER TABLE media_objects ADD COLUMN in_library BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE media_objects ADD COLUMN retain_until TIMESTAMPTZ;
CREATE INDEX media_objects_library_idx ON media_objects (account_id, created_at DESC)
  WHERE in_library AND deleted_at IS NULL;

-- ================================================================ worker sweep
-- Fixed worker projection: which workspaces have SLA, auto-resolve, away
-- message or reassignment configured. Identifiers only; the worker then reads
-- and writes inside each tenant scope.
DO $$ BEGIN
  EXECUTE format('CREATE POLICY inbox_migration_owner ON workspace_inbox_settings FOR SELECT TO %I USING (true)',current_user);
  EXECUTE format('CREATE POLICY inbox_migration_owner ON routing_rules FOR SELECT TO %I USING (true)',current_user);
  EXECUTE format('CREATE POLICY inbox_migration_owner ON notification_email_queue FOR SELECT TO %I USING (true)',current_user);
END $$;
CREATE FUNCTION crm_accounts_for_inbox_sweep() RETURNS TABLE(account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT s.account_id FROM workspace_inbox_settings s
  WHERE s.sla_first_response_minutes IS NOT NULL OR s.auto_resolve_after_hours IS NOT NULL
    OR s.away_message_enabled
  UNION
  SELECT r.account_id FROM routing_rules r WHERE r.enabled AND r.reassign_after_minutes IS NOT NULL
$$;
REVOKE ALL ON FUNCTION crm_accounts_for_inbox_sweep() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_accounts_for_inbox_sweep() TO bodhinox_worker;
CREATE FUNCTION crm_accounts_with_pending_notification_email() RETURNS TABLE(account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT DISTINCT q.account_id FROM notification_email_queue q WHERE q.sent_at IS NULL
$$;
REVOKE ALL ON FUNCTION crm_accounts_with_pending_notification_email() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_accounts_with_pending_notification_email() TO bodhinox_worker;
