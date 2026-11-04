-- Phase 9: Zoom meetings for online appointments (design §1, D1-D9). All additive:
-- each redefined CHECK is a superset that keeps every existing value.
--
-- Off by default: nothing here makes a provider call. A workspace has a meeting
-- only after its admin connected Zoom and the deployment set ZOOM_ENABLED and the
-- app credentials (src/lib/meetings/config.ts).
--
-- Secrets (*_enc, encrypted by src/lib/whatsapp/encryption) are excluded from the
-- app role's column SELECT grant; server code reads them through the worker
-- role. Members below agent read nothing new.

-- ================================================================ connections
CREATE TABLE meeting_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'zoom' CHECK (provider = 'zoom'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','token_invalid','disconnected')),
  zoom_account_id text CHECK (zoom_account_id IS NULL OR zoom_account_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  authorized_zoom_user_id text CHECK (authorized_zoom_user_id IS NULL OR authorized_zoom_user_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  access_token_enc text CHECK (access_token_enc IS NULL OR char_length(access_token_enc) <= 4096),
  refresh_token_enc text CHECK (refresh_token_enc IS NULL OR char_length(refresh_token_enc) <= 4096),
  token_expires_at timestamptz,
  refresh_rotated_at timestamptz,
  scopes text[] NOT NULL DEFAULT '{}' CHECK (cardinality(scopes) <= 50),
  register_attendees boolean NOT NULL DEFAULT false,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,64}$'),
  connected_by uuid,
  connected_at timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  CHECK (status = 'disconnected' OR zoom_account_id IS NOT NULL)
);
-- One live connection per workspace, and one live workspace per Zoom account (zoom_account_in_use).
CREATE UNIQUE INDEX meeting_connections_live_account_key ON meeting_connections (account_id) WHERE status <> 'disconnected';
CREATE UNIQUE INDEX meeting_connections_live_zoom_key ON meeting_connections (zoom_account_id) WHERE status <> 'disconnected';
ALTER TABLE meeting_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON meeting_connections FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'));
-- Admins change only the registration switch; connect and disconnect run as worker services.
CREATE POLICY admin_update ON meeting_connections FOR UPDATE TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
CREATE POLICY worker_write ON meeting_connections FOR ALL TO bodhinox_worker
  USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT SELECT (id, account_id, provider, status, register_attendees, last_error_code, connected_at, disconnected_at)
  ON meeting_connections TO bodhinox_app;
GRANT UPDATE (register_attendees, updated_at) ON meeting_connections TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE ON meeting_connections TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON meeting_connections FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ================================================================ practitioner host
-- NULL: the meeting is hosted by the Zoom user who authorized the connection.
ALTER TABLE appointment_staff ADD COLUMN meeting_host_email text
  CHECK (meeting_host_email IS NULL OR (char_length(meeting_host_email) <= 254 AND position('@' in meeting_host_email) > 1));
GRANT UPDATE (meeting_host_email) ON appointment_staff TO bodhinox_app;

-- ================================================================ meetings
-- One Zoom meeting per appointment. Created only by the worker job after a
-- claim (claim_token, claimed_until); an ambiguous create is reconciled by
-- meeting_ref (in the topic), never re-created. The host start URL is never stored.
CREATE TABLE appointment_meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  appointment_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'zoom' CHECK (provider = 'zoom'),
  meeting_ref text NOT NULL CHECK (meeting_ref ~ '^[a-z0-9]{10}$'),
  host_zoom_user text CHECK (host_zoom_user IS NULL OR char_length(host_zoom_user) BETWEEN 1 AND 254),
  external_meeting_id text CHECK (external_meeting_id IS NULL OR external_meeting_id ~ '^[0-9]{1,20}$'),
  registrant_id text CHECK (registrant_id IS NULL OR char_length(registrant_id) BETWEEN 1 AND 128),
  join_url text CHECK (join_url IS NULL OR (join_url ~ '^https://' AND char_length(join_url) <= 2048)),
  supplied_url text CHECK (supplied_url IS NULL OR (supplied_url ~ '^https://' AND char_length(supplied_url) <= 2048)),
  sync_state text NOT NULL DEFAULT 'creating'
    CHECK (sync_state IN ('creating','active','unknown','failed','deleted','manual','detached')),
  claim_token uuid,
  claimed_until timestamptz,
  synced_version integer CHECK (synced_version IS NULL OR synced_version > 0),
  synced_start_at timestamptz,
  synced_duration_min integer CHECK (synced_duration_min IS NULL OR synced_duration_min BETWEEN 1 AND 1440),
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,64}$'),
  attendance_evidence text NOT NULL DEFAULT 'none' CHECK (attendance_evidence IN ('none','guest_joined','registrant_joined')),
  first_join_at timestamptz,
  attended_seconds integer NOT NULL DEFAULT 0 CHECK (attended_seconds >= 0),
  meeting_ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, appointment_id),
  UNIQUE (account_id, meeting_ref),
  FOREIGN KEY (account_id, appointment_id) REFERENCES appointments(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, connection_id) REFERENCES meeting_connections(account_id, id)
);
CREATE INDEX appointment_meetings_external_idx ON appointment_meetings (account_id, external_meeting_id)
  WHERE external_meeting_id IS NOT NULL;
CREATE INDEX appointment_meetings_open_idx ON appointment_meetings (account_id, sync_state)
  WHERE sync_state IN ('creating','unknown','active');
ALTER TABLE appointment_meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_meetings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON appointment_meetings FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY worker_write ON appointment_meetings FOR ALL TO bodhinox_worker
  USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT SELECT (id, account_id, appointment_id, connection_id, provider, meeting_ref, host_zoom_user, external_meeting_id,
  join_url, supplied_url, sync_state, claimed_until, synced_version, synced_start_at, synced_duration_min, last_error_code,
  attendance_evidence, first_join_at, attended_seconds, meeting_ended_at, created_at, updated_at)
  ON appointment_meetings TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE ON appointment_meetings TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON appointment_meetings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ================================================================ attendance evidence (append-only)
-- Evidence only: never changes an appointment's status. participant_key is a
-- sha256 of Zoom's participant_uuid; never a name or an email.
CREATE TABLE meeting_participant_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  appointment_meeting_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('meeting_started','participant_joined','participant_left','meeting_ended')),
  participant_kind text CHECK (participant_kind IS NULL OR participant_kind IN ('host','registrant','guest')),
  participant_key text CHECK (participant_key IS NULL OR participant_key ~ '^[0-9a-f]{64}$'),
  event_at timestamptz NOT NULL,
  receipt_key text NOT NULL UNIQUE CHECK (char_length(receipt_key) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, appointment_meeting_id) REFERENCES appointment_meetings(account_id, id) ON DELETE CASCADE
);
CREATE INDEX meeting_participant_events_meeting_idx ON meeting_participant_events (account_id, appointment_meeting_id, event_at);
ALTER TABLE meeting_participant_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_participant_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON meeting_participant_events FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY worker_insert ON meeting_participant_events FOR INSERT TO bodhinox_worker
  WITH CHECK (account_id=app_account_id());
GRANT SELECT ON meeting_participant_events TO bodhinox_app;
GRANT SELECT, INSERT ON meeting_participant_events TO bodhinox_worker;

-- ================================================================ widened CHECKs
-- Superset of 20261107102000_paid_appointments. The meeting_* kinds are history
-- only (never fanned out to notifications, automations or tenant webhooks).
ALTER TABLE appointment_events DROP CONSTRAINT appointment_events_kind_check;
ALTER TABLE appointment_events ADD CONSTRAINT appointment_events_kind_check CHECK (kind IN ('held','confirmed','rescheduled',
  'reassigned','cancelled','expired','completed','no_show','feedback','reminder_skipped',
  'payment_pending','payment_captured','late_payment',
  'meeting_created','meeting_updated','meeting_deleted','meeting_sync_failed','meeting_joined_provider'));

-- Superset of 20261106100000_appointments.
ALTER TABLE tasks DROP CONSTRAINT tasks_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check CHECK (kind IN ('next_step','rebook','manual','meeting_sync','meeting_outcome'));
-- At most one open system task per appointment and kind (inserts use ON CONFLICT DO NOTHING).
CREATE UNIQUE INDEX tasks_open_meeting_key ON tasks (account_id, appointment_id, kind)
  WHERE status = 'open' AND kind IN ('meeting_sync','meeting_outcome');

-- ================================================================ webhook tenant lookup
-- Zoom sends one app-level webhook; the workspace is the live connection for the
-- event's Zoom account. Worker only.
CREATE FUNCTION crm_resolve_zoom_connection(p_zoom_account_id text)
RETURNS TABLE(account_id uuid, connection_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT c.account_id, c.id FROM meeting_connections c
  WHERE c.zoom_account_id = p_zoom_account_id AND c.status <> 'disconnected'
$$;
REVOKE ALL ON FUNCTION crm_resolve_zoom_connection(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_resolve_zoom_connection(text) TO bodhinox_worker;

-- FORCE RLS applies to the definer's owner too (pattern 20261107102500_commerce_wiring).
DO $$ BEGIN
  EXECUTE format('CREATE POLICY meetings_migration_owner ON meeting_connections FOR SELECT TO %I USING (true)', current_user);
END $$;
