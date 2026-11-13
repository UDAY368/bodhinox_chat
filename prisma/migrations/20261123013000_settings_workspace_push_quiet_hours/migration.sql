-- Settings redesign: the Workspace section's default language, the Notifications
-- section's push column and quiet hours, and the browser push path.
--
--   accounts.default_language       the workspace's language for members who chose none.
--   notification_preferences.push   per member and event, like in_app and email.
--   member_preferences              one row per membership: the member's own language
--                                    and quiet hours (local times in the member's time zone).
--   push_subscriptions              a member's browser push endpoints (Web Push, VAPID).
--                                    Only the member reads or writes their own; the
--                                    worker reads and prunes them while sending.
--   notification_push_queue         entries written by createNotification beside the
--                                    in-app row; the worker claims (sent_at) before it
--                                    sends, so a retry never pushes the same entry twice.
--                                    An entry inside the member's quiet hours is held
--                                    (not_before = when they end) and sent then, unless
--                                    it would be more than 12 hours old.
--                                    A push carries no payload: no title or customer
--                                    content reaches the push service.
--
-- Additive: two nullable/defaulted columns and three new tables with forced
-- row-level security.
SET LOCAL lock_timeout = '5s';

ALTER TABLE accounts ADD COLUMN default_language text
  CONSTRAINT accounts_default_language_check CHECK (default_language IN ('en','es','ko','pt'));

ALTER TABLE notification_preferences ADD COLUMN push boolean NOT NULL DEFAULT false;

CREATE TABLE member_preferences (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  language text CHECK (language IN ('en','es','ko','pt')),
  quiet_enabled boolean NOT NULL DEFAULT false,
  quiet_start smallint NOT NULL DEFAULT 1320 CHECK (quiet_start BETWEEN 0 AND 1439),
  quiet_end smallint NOT NULL DEFAULT 420 CHECK (quiet_end BETWEEN 0 AND 1439),
  quiet_time_zone text NOT NULL DEFAULT 'UTC' CHECK (char_length(quiet_time_zone) BETWEEN 1 AND 64),
  quiet_allow_mentions boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id),
  CHECK (quiet_start <> quiet_end),
  FOREIGN KEY (account_id, user_id) REFERENCES account_memberships(account_id, user_id) ON DELETE CASCADE
);
ALTER TABLE member_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_preferences FORCE ROW LEVEL SECURITY;
-- Members read the workspace's rows so a sender can respect a recipient's
-- quiet hours; each member writes only their own.
CREATE POLICY tenant_read ON member_preferences FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY own_write ON member_preferences FOR ALL TO bodhinox_app
  USING (account_id = app_account_id() AND user_id = app_user_id())
  WITH CHECK (account_id = app_account_id() AND user_id = app_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON member_preferences TO bodhinox_app;
GRANT SELECT ON member_preferences TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON member_preferences
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  endpoint text NOT NULL CHECK (char_length(endpoint) BETWEEN 10 AND 1000 AND endpoint LIKE 'https://%'),
  p256dh text NOT NULL CHECK (char_length(p256dh) BETWEEN 20 AND 200),
  auth text NOT NULL CHECK (char_length(auth) BETWEEN 8 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_sent_at timestamptz,
  UNIQUE (account_id, user_id, endpoint),
  FOREIGN KEY (account_id, user_id) REFERENCES account_memberships(account_id, user_id) ON DELETE CASCADE
);
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON push_subscriptions FOR ALL TO bodhinox_app
  USING (account_id = app_account_id() AND user_id = app_user_id())
  WITH CHECK (account_id = app_account_id() AND user_id = app_user_id());
CREATE POLICY worker_rows ON push_subscriptions FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriptions TO bodhinox_app;
GRANT SELECT, UPDATE, DELETE ON push_subscriptions TO bodhinox_worker;

CREATE TABLE notification_push_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  event text NOT NULL CHECK (event IN ('assigned_message', 'mention', 'sla_breach', 'campaign_finished',
    'template_rejected', 'number_quality', 'appointment_booked', 'appointment_cancelled',
    'appointment_rescheduled', 'automation_notice', 'webhook_disabled')),
  notification_id uuid,
  dedupe_key text CHECK (dedupe_key IS NULL OR char_length(dedupe_key) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  -- Held by quiet hours until this time; the worker leaves it unclaimed until then.
  not_before timestamptz,
  -- sent, quiet (dropped: quiet hours outlasted 12 hours), skipped (read, switched off, stale or no device), failed
  outcome text CHECK (outcome IS NULL OR outcome IN ('sent', 'quiet', 'skipped', 'failed')),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, user_id) REFERENCES account_memberships(account_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, notification_id) REFERENCES notifications(account_id, id) ON DELETE SET NULL (notification_id)
);
CREATE UNIQUE INDEX notification_push_queue_dedupe
  ON notification_push_queue (account_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX notification_push_queue_pending_idx
  ON notification_push_queue (account_id, created_at) WHERE sent_at IS NULL;
ALTER TABLE notification_push_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_push_queue FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_insert ON notification_push_queue FOR INSERT TO bodhinox_app
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('agent'));
CREATE POLICY worker_queue ON notification_push_queue FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT INSERT ON notification_push_queue TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON notification_push_queue TO bodhinox_worker;

-- Fixed worker projection: which workspaces have unsent push entries.
-- Identifiers only; the worker then reads and writes inside each tenant scope.
DO $$ BEGIN
  EXECUTE format('CREATE POLICY push_migration_owner ON notification_push_queue FOR SELECT TO %I USING (true)', current_user);
END $$;
CREATE FUNCTION crm_accounts_with_pending_notification_push() RETURNS TABLE(account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT DISTINCT q.account_id FROM notification_push_queue q
  WHERE q.sent_at IS NULL AND (q.not_before IS NULL OR q.not_before <= now())
$$;
REVOKE ALL ON FUNCTION crm_accounts_with_pending_notification_push() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_accounts_with_pending_notification_push() TO bodhinox_worker;
