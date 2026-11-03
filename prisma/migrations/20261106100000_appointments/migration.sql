-- Phase 7: appointments and consultation journeys. All additive.
--
-- Tenancy: every table carries account_id (defaulted from app.account_id), has
-- UNIQUE (account_id, id), and every child reference is a composite
-- (account_id, x_id) foreign key, so a row can never point at another tenant.
-- Configuration is admin-written; bookings are agent-written; the worker (public
-- pages, inbound WhatsApp, jobs) writes bookings, history and message outcomes.
--
-- No-overbooking is enforced by transaction advisory locks plus a recount after
-- the lock (src/lib/appointments/booking.ts), not by an EXCLUDE constraint,
-- because capacity can be greater than one.

-- ================================================================ settings
CREATE TABLE appointment_settings (
  account_id uuid PRIMARY KEY DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  hold_minutes integer NOT NULL DEFAULT 15 CHECK (hold_minutes BETWEEN 5 AND 60),
  max_active_holds_per_page integer NOT NULL DEFAULT 20 CHECK (max_active_holds_per_page BETWEEN 1 AND 200),
  min_notice_minutes integer NOT NULL DEFAULT 60 CHECK (min_notice_minutes BETWEEN 0 AND 10080),
  horizon_days integer NOT NULL DEFAULT 60 CHECK (horizon_days BETWEEN 1 AND 365),
  customer_cancel_cutoff_minutes integer NOT NULL DEFAULT 120 CHECK (customer_cancel_cutoff_minutes BETWEEN 0 AND 10080),
  reminder_24h boolean NOT NULL DEFAULT true,
  reminder_2h boolean NOT NULL DEFAULT true,
  staff_notify boolean NOT NULL DEFAULT true,
  confirm_template_name text CHECK (confirm_template_name IS NULL OR char_length(confirm_template_name) BETWEEN 1 AND 512),
  confirm_template_language text CHECK (confirm_template_language IS NULL OR char_length(confirm_template_language) BETWEEN 2 AND 15),
  reminder_template_name text CHECK (reminder_template_name IS NULL OR char_length(reminder_template_name) BETWEEN 1 AND 512),
  reminder_template_language text CHECK (reminder_template_language IS NULL OR char_length(reminder_template_language) BETWEEN 2 AND 15),
  change_template_name text CHECK (change_template_name IS NULL OR char_length(change_template_name) BETWEEN 1 AND 512),
  change_template_language text CHECK (change_template_language IS NULL OR char_length(change_template_language) BETWEEN 2 AND 15),
  feedback_template_name text CHECK (feedback_template_name IS NULL OR char_length(feedback_template_name) BETWEEN 1 AND 512),
  feedback_template_language text CHECK (feedback_template_language IS NULL OR char_length(feedback_template_language) BETWEEN 2 AND 15),
  rebook_template_name text CHECK (rebook_template_name IS NULL OR char_length(rebook_template_name) BETWEEN 1 AND 512),
  rebook_template_language text CHECK (rebook_template_language IS NULL OR char_length(rebook_template_language) BETWEEN 2 AND 15),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((confirm_template_name IS NULL) = (confirm_template_language IS NULL)),
  CHECK ((reminder_template_name IS NULL) = (reminder_template_language IS NULL)),
  CHECK ((change_template_name IS NULL) = (change_template_language IS NULL)),
  CHECK ((feedback_template_name IS NULL) = (feedback_template_language IS NULL)),
  CHECK ((rebook_template_name IS NULL) = (rebook_template_language IS NULL))
);

-- ================================================================ locations
CREATE TABLE appointment_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  address text CHECK (address IS NULL OR char_length(address) <= 500),
  -- IANA zone, validated in the app (isValidTimeZone).
  timezone text NOT NULL CHECK (char_length(timezone) BETWEEN 1 AND 64),
  kind text NOT NULL DEFAULT 'physical' CHECK (kind IN ('physical','online')),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)
);

-- ================================================================ services
CREATE TABLE appointment_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  mode text NOT NULL CHECK (mode IN ('offline','online')),
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  buffer_minutes integer NOT NULL DEFAULT 0 CHECK (buffer_minutes BETWEEN 0 AND 240),
  -- NULL = step equals the duration.
  slot_step_minutes integer CHECK (slot_step_minutes IS NULL OR slot_step_minutes BETWEEN 5 AND 480),
  capacity integer NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 200),
  price_minor bigint CHECK (price_minor IS NULL OR price_minor >= 0),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  -- Payment-gated confirmation arrives with payments; until then it is refused.
  payment_required boolean NOT NULL DEFAULT false CONSTRAINT appointment_services_payment_required_check CHECK (NOT payment_required),
  -- ISO weekdays, 1 = Monday. NULL = every day.
  allowed_weekdays smallint[] CHECK (allowed_weekdays IS NULL OR (cardinality(allowed_weekdays) BETWEEN 1 AND 7
    AND allowed_weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[])),
  meeting_url text CHECK (meeting_url IS NULL OR (meeting_url ~ '^https://' AND char_length(meeting_url) <= 2048)),
  feedback_delay_minutes integer CHECK (feedback_delay_minutes IS NULL OR feedback_delay_minutes BETWEEN 0 AND 10080),
  rebook_after_days integer CHECK (rebook_after_days IS NULL OR rebook_after_days BETWEEN 1 AND 365),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  CHECK ((price_minor IS NULL) = (currency IS NULL)),
  CHECK (mode = 'online' OR meeting_url IS NULL)
);

-- ================================================================ staff
CREATE TABLE appointment_staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 80),
  user_id uuid,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, user_id) REFERENCES account_memberships(account_id, user_id) ON DELETE SET NULL (user_id)
);

-- ================================================================ offerings
-- (service, staff, location). NULL staff = a location pool. A (service, location)
-- is either pooled or staffed, never both (enforced in config.ts under a lock).
CREATE TABLE appointment_offerings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  service_id uuid NOT NULL,
  staff_id uuid,
  location_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, service_id) REFERENCES appointment_services(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, staff_id) REFERENCES appointment_staff(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, location_id) REFERENCES appointment_locations(account_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX appointment_offerings_key ON appointment_offerings
  (account_id, service_id, staff_id, location_id) NULLS NOT DISTINCT;

-- ================================================================ weekly hours
-- hours is the WorkingHours shape (src/lib/inbox/working-hours.ts). NULL staff = pool hours.
CREATE TABLE appointment_hours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  staff_id uuid,
  location_id uuid NOT NULL,
  hours jsonb NOT NULL CHECK (jsonb_typeof(hours) = 'object' AND pg_column_size(hours) <= 8192),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, staff_id) REFERENCES appointment_staff(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, location_id) REFERENCES appointment_locations(account_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX appointment_hours_key ON appointment_hours (account_id, staff_id, location_id) NULLS NOT DISTINCT;

-- ================================================================ exceptions and holidays
-- Dates are local dates in the location's zone. ranges NULL = closed all day.
CREATE TABLE appointment_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  staff_id uuid,
  location_id uuid NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  ranges jsonb CHECK (ranges IS NULL OR (jsonb_typeof(ranges) = 'array' AND pg_column_size(ranges) <= 2048)),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  CHECK (ends_on >= starts_on AND ends_on - starts_on <= 366),
  FOREIGN KEY (account_id, staff_id) REFERENCES appointment_staff(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, location_id) REFERENCES appointment_locations(account_id, id) ON DELETE CASCADE
);
CREATE INDEX appointment_exceptions_range_idx ON appointment_exceptions (account_id, location_id, starts_on, ends_on);

-- ================================================================ booking pages
CREATE TABLE booking_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$'),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  active boolean NOT NULL DEFAULT true,
  location_id uuid,
  -- NULL = the workspace's default number.
  whatsapp_config_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, location_id) REFERENCES appointment_locations(account_id, id) ON DELETE SET NULL (location_id),
  FOREIGN KEY (account_id, whatsapp_config_id) REFERENCES whatsapp_config(account_id, id) ON DELETE SET NULL (whatsapp_config_id)
);

CREATE TABLE booking_page_services (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  page_id uuid NOT NULL,
  service_id uuid NOT NULL,
  PRIMARY KEY (account_id, page_id, service_id),
  FOREIGN KEY (account_id, page_id) REFERENCES booking_pages(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, service_id) REFERENCES appointment_services(account_id, id) ON DELETE CASCADE
);

-- ================================================================ appointments
CREATE TABLE appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  -- NULL while a public hold waits for its WhatsApp code, and after the contact is deleted.
  contact_id uuid,
  service_id uuid NOT NULL,
  staff_id uuid,
  location_id uuid NOT NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  -- Snapshot of the location's zone at booking.
  timezone text NOT NULL CHECK (char_length(timezone) BETWEEN 1 AND 64),
  local_date date GENERATED ALWAYS AS ((start_at AT TIME ZONE timezone)::date) STORED,
  status text NOT NULL CHECK (status IN ('held','confirmed','cancelled','completed','no_show','expired')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  source text NOT NULL CHECK (source IN ('staff','public','flow')),
  source_ref text CHECK (source_ref IS NULL OR char_length(source_ref) <= 200),
  booking_page_id uuid,
  hold_expires_at timestamptz,
  hold_code text CHECK (hold_code IS NULL OR hold_code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  -- Public intake (name/city/state); nulled on confirm or expiry.
  intake jsonb CHECK (intake IS NULL OR (jsonb_typeof(intake) = 'object' AND pg_column_size(intake) <= 2048)),
  -- Public holds: keyed hash (HMAC) of the client IP for the per-client hold cap; nulled on confirm, expiry or cancel.
  hold_client_hash text CHECK (hold_client_hash IS NULL OR hold_client_hash ~ '^[0-9a-f]{64}$'),
  confirmed_at timestamptz,
  price_minor bigint CHECK (price_minor IS NULL OR price_minor >= 0),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  meeting_url text CHECK (meeting_url IS NULL OR (meeting_url ~ '^https://' AND char_length(meeting_url) <= 2048)),
  service_name text NOT NULL CHECK (char_length(service_name) BETWEEN 1 AND 120),
  manage_token_hash text UNIQUE CHECK (manage_token_hash IS NULL OR manage_token_hash ~ '^[0-9a-f]{64}$'),
  token_epoch integer NOT NULL DEFAULT 1 CHECK (token_epoch > 0),
  cancel_reason text CHECK (cancel_reason IS NULL OR cancel_reason IN ('customer','staff','expired','other')),
  outcome_note text CHECK (outcome_note IS NULL OR char_length(outcome_note) <= 1000),
  feedback_score smallint CHECK (feedback_score IS NULL OR feedback_score BETWEEN 1 AND 5),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, source_ref),
  CHECK (end_at > start_at AND end_at - start_at <= interval '8 hours'),
  CHECK (status <> 'held' OR hold_expires_at IS NOT NULL),
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE SET NULL (contact_id),
  FOREIGN KEY (account_id, service_id) REFERENCES appointment_services(account_id, id),
  FOREIGN KEY (account_id, staff_id) REFERENCES appointment_staff(account_id, id),
  FOREIGN KEY (account_id, location_id) REFERENCES appointment_locations(account_id, id),
  FOREIGN KEY (account_id, booking_page_id) REFERENCES booking_pages(account_id, id) ON DELETE SET NULL (booking_page_id)
);
CREATE UNIQUE INDEX appointments_hold_code_key ON appointments (account_id, hold_code) WHERE status = 'held';
CREATE INDEX appointments_staff_active_idx ON appointments (account_id, staff_id, start_at)
  WHERE status IN ('held','confirmed');
CREATE INDEX appointments_pool_active_idx ON appointments (account_id, service_id, location_id, start_at)
  WHERE staff_id IS NULL AND status IN ('held','confirmed');
CREATE INDEX appointments_contact_idx ON appointments (account_id, contact_id, start_at);
CREATE INDEX appointments_local_date_idx ON appointments (account_id, local_date);
CREATE INDEX appointments_page_held_idx ON appointments (account_id, booking_page_id) WHERE status = 'held';

-- ================================================================ history (append-only)
CREATE TABLE appointment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  appointment_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  kind text NOT NULL CHECK (kind IN ('held','confirmed','rescheduled','reassigned','cancelled','expired',
    'completed','no_show','feedback','reminder_skipped')),
  old_start_at timestamptz,
  new_start_at timestamptz,
  actor text NOT NULL CHECK (actor IN ('staff','customer','system')),
  actor_user_id uuid,
  -- A code only, never customer content.
  detail text CHECK (detail IS NULL OR detail ~ '^[a-z0-9_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, appointment_id) REFERENCES appointments(account_id, id) ON DELETE CASCADE
);
CREATE INDEX appointment_events_appointment_idx ON appointment_events (account_id, appointment_id, created_at);
CREATE INDEX appointment_events_created_idx ON appointment_events (account_id, created_at);

-- ================================================================ customer message outcomes
CREATE TABLE appointment_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  appointment_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  kind text NOT NULL CHECK (kind IN ('confirmation','reminder_24h','reminder_2h','cancelled','rescheduled','feedback','rebook')),
  status text NOT NULL CHECK (status IN ('sent','skipped','blocked','failed','outcome_unknown')),
  reason text CHECK (reason IS NULL OR reason ~ '^[a-z0-9_]{1,64}$'),
  resolved_at timestamptz,
  resolved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, appointment_id, version, kind),
  FOREIGN KEY (account_id, appointment_id) REFERENCES appointments(account_id, id) ON DELETE CASCADE
);
CREATE INDEX appointment_messages_open_idx ON appointment_messages (account_id, created_at)
  WHERE status IN ('blocked','failed','outcome_unknown') AND resolved_at IS NULL;

-- ================================================================ tasks
CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id uuid,
  appointment_id uuid,
  kind text NOT NULL CHECK (kind IN ('next_step','rebook','manual')),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  due_at timestamptz,
  assigned_to uuid,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE SET NULL (contact_id),
  FOREIGN KEY (account_id, appointment_id) REFERENCES appointments(account_id, id) ON DELETE SET NULL (appointment_id),
  FOREIGN KEY (account_id, assigned_to) REFERENCES account_memberships(account_id, user_id) ON DELETE SET NULL (assigned_to)
);
CREATE INDEX tasks_open_idx ON tasks (account_id, status, due_at);
CREATE INDEX tasks_appointment_idx ON tasks (account_id, appointment_id);

-- ================================================================ RLS
-- Configuration: every member reads; admins write; the worker reads.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['appointment_settings','appointment_locations','appointment_services','appointment_staff',
    'appointment_offerings','appointment_hours','appointment_exceptions','booking_pages','booking_page_services']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT TO bodhinox_app,bodhinox_worker USING (account_id=app_account_id())', t);
    EXECUTE format('CREATE POLICY tenant_write ON %I FOR ALL TO bodhinox_app USING (account_id=app_account_id() AND app_write_allowed(%L)) WITH CHECK (account_id=app_account_id() AND app_write_allowed(%L))', t, 'admin', 'admin');
    EXECUTE format('GRANT SELECT ON %I TO bodhinox_worker', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON appointment_settings TO bodhinox_app;
GRANT UPDATE (hold_minutes, max_active_holds_per_page, min_notice_minutes, horizon_days, customer_cancel_cutoff_minutes,
  reminder_24h, reminder_2h, staff_notify, confirm_template_name, confirm_template_language,
  reminder_template_name, reminder_template_language, change_template_name, change_template_language,
  feedback_template_name, feedback_template_language, rebook_template_name, rebook_template_language, updated_at)
  ON appointment_settings TO bodhinox_app;

GRANT SELECT, INSERT ON appointment_locations TO bodhinox_app;
GRANT UPDATE (name, address, timezone, kind, archived_at, updated_at) ON appointment_locations TO bodhinox_app;

GRANT SELECT, INSERT ON appointment_services TO bodhinox_app;
GRANT UPDATE (name, mode, duration_minutes, buffer_minutes, slot_step_minutes, capacity, price_minor, currency,
  payment_required, allowed_weekdays, meeting_url, feedback_delay_minutes, rebook_after_days, archived_at, updated_at)
  ON appointment_services TO bodhinox_app;

GRANT SELECT, INSERT ON appointment_staff TO bodhinox_app;
GRANT UPDATE (display_name, user_id, archived_at, updated_at) ON appointment_staff TO bodhinox_app;

GRANT SELECT, INSERT, DELETE ON appointment_offerings TO bodhinox_app;

GRANT SELECT, INSERT, DELETE ON appointment_hours TO bodhinox_app;
GRANT UPDATE (hours, updated_at) ON appointment_hours TO bodhinox_app;

GRANT SELECT, INSERT, DELETE ON appointment_exceptions TO bodhinox_app;
GRANT UPDATE (starts_on, ends_on, ranges, reason) ON appointment_exceptions TO bodhinox_app;

GRANT SELECT, INSERT, DELETE ON booking_pages TO bodhinox_app;
GRANT UPDATE (slug, title, active, location_id, whatsapp_config_id, updated_at) ON booking_pages TO bodhinox_app;

GRANT SELECT, INSERT, DELETE ON booking_page_services TO bodhinox_app;

-- Appointments: agents and above book and manage; the worker books (public, flow,
-- inbound) and runs lifecycle jobs. The app role cannot rewrite the contact, the
-- manage-link hash or epoch, or the idempotency reference after insert.
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON appointments FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
CREATE POLICY tenant_write ON appointments FOR ALL TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('agent'));
GRANT SELECT, INSERT ON appointments TO bodhinox_app;
GRANT UPDATE (status, version, start_at, end_at, timezone, staff_id, location_id, hold_expires_at, confirmed_at,
  cancel_reason, outcome_note, feedback_score, hold_client_hash, updated_at) ON appointments TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE ON appointments TO bodhinox_worker;

-- History: append-only for everyone.
ALTER TABLE appointment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON appointment_events FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
CREATE POLICY tenant_insert ON appointment_events FOR INSERT TO bodhinox_app,bodhinox_worker
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('agent'));
GRANT SELECT, INSERT ON appointment_events TO bodhinox_app;
GRANT SELECT, INSERT ON appointment_events TO bodhinox_worker;

-- Message outcomes: written by the worker; admins only mark them resolved.
ALTER TABLE appointment_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON appointment_messages FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
CREATE POLICY admin_resolve ON appointment_messages FOR UPDATE TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
CREATE POLICY worker_write ON appointment_messages FOR ALL TO bodhinox_worker
  USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT SELECT ON appointment_messages TO bodhinox_app;
GRANT UPDATE (resolved_at, resolved_by) ON appointment_messages TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE ON appointment_messages TO bodhinox_worker;

-- Tasks: agents write; the worker creates follow-up tasks.
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON tasks FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
CREATE POLICY tenant_write ON tasks FOR ALL TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('agent'));
GRANT SELECT, INSERT ON tasks TO bodhinox_app;
GRANT UPDATE (title, due_at, assigned_to, status, updated_at) ON tasks TO bodhinox_app;
GRANT SELECT, INSERT ON tasks TO bodhinox_worker;
