SET LOCAL lock_timeout = '5s';

-- Campaigns (batch 7): frequency cap, quiet hours, cancel remaining, CSV consent and full drafts. Additive.
--
-- broadcasts.skip_recent_days: leave out contacts who received a campaign or sequence message in the last N days
--   (0 = off, every existing row). Applied in the SQL that builds the audience and in the reach count.
-- broadcasts.send_window_*: quiet hours. Sends happen only between start and end (minutes after local midnight) in the
--   stored IANA time zone (the workspace's when the campaign was created); start > end spans midnight. All three NULL
--   = no window (every existing row). The dispatcher requeues a pass for when the window opens.
-- broadcasts.csv_consent_*: who confirmed that a CSV audience agreed to WhatsApp messages, and when.
-- broadcast_recipients.status gains 'cancelled': "Cancel remaining" stops a campaign for good; rows with an open
--   outbound intent stay as they are for reconciliation. The check is widened only.
-- broadcast_drafts: a draft's full wizard state (header media, tracked link, extras, schedule, send controls) and its
--   CSV rows, server-side. One row per draft broadcast, removed with it. No outbox trigger: CSV rows never reach
--   realtime events. Members read, agents write (like broadcasts).
-- If it aborts on lock_timeout: prisma migrate resolve --rolled-back 20261207030000_campaign_send_controls.

ALTER TABLE broadcasts
  ADD COLUMN skip_recent_days smallint NOT NULL DEFAULT 0 CHECK (skip_recent_days BETWEEN 0 AND 365),
  ADD COLUMN send_window_start smallint CHECK (send_window_start BETWEEN 0 AND 1439),
  ADD COLUMN send_window_end smallint CHECK (send_window_end BETWEEN 0 AND 1439),
  ADD COLUMN send_window_time_zone text CHECK (send_window_time_zone IS NULL OR char_length(send_window_time_zone) BETWEEN 1 AND 64),
  ADD COLUMN csv_consent_user_id uuid,
  ADD COLUMN csv_consent_at timestamptz;
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_send_window_check
  CHECK ((send_window_start IS NULL) = (send_window_end IS NULL) AND (send_window_start IS NULL) = (send_window_time_zone IS NULL)
    AND (send_window_start IS NULL OR send_window_start <> send_window_end)) NOT VALID;

ALTER TABLE broadcast_recipients DROP CONSTRAINT broadcast_recipients_status_check; -- additive-exception: re-added below with 'cancelled'; widens the allowed set only
ALTER TABLE broadcast_recipients ADD CONSTRAINT broadcast_recipients_status_check
  CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'replied', 'failed', 'cancelled')) NOT VALID;
ALTER TABLE broadcast_recipients VALIDATE CONSTRAINT broadcast_recipients_status_check;

CREATE TABLE broadcast_drafts (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  broadcast_id uuid NOT NULL,
  state jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(state) = 'object' AND pg_column_size(state) <= 65536),
  csv_rows jsonb CHECK (csv_rows IS NULL OR (jsonb_typeof(csv_rows) = 'array' AND jsonb_array_length(csv_rows) <= 10000)),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, broadcast_id),
  FOREIGN KEY (account_id, broadcast_id) REFERENCES broadcasts(account_id, id) ON DELETE CASCADE
);

ALTER TABLE broadcast_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON broadcast_drafts FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
CREATE POLICY tenant_write ON broadcast_drafts FOR ALL TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('agent'));
GRANT SELECT,INSERT,UPDATE,DELETE ON broadcast_drafts TO bodhinox_app,bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON broadcast_drafts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
