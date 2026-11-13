-- Contacts redesign: a contact owner, a city, typed custom fields and a
-- contact activity timeline. Additive and live-safe.
--
--   contacts.owner_id   the member responsible for the contact (NULL: no one).
--                       Set only through PATCH /api/contacts/[id] and the bulk
--                       "assign owner" action, which check the user is a member
--                       of the workspace; the browser data contract refuses
--                       direct writes. A deleted user leaves the contact unowned.
--   contacts.city       free text, at most 200 characters.
--   custom_fields       field_type is one of text, number, date, choice (every
--                       existing field is 'text'); a choice field keeps its
--                       choices as a JSON array of strings in field_options;
--                       a field's type never changes once it exists. Values stay
--                       text in contact_custom_values (number as a decimal
--                       string, date as YYYY-MM-DD), so every stored value stays
--                       valid. The checks are NOT VALID; 20261121000400
--                       validates the field_type, owner and city ones. The
--                       choice-options check stays NOT VALID (it only concerns
--                       the new choice fields).
--   contact_activity    an append-only timeline of changes made to a contact by
--                       members (field edits, owner, consent, block, tag
--                       removal, template sends). detail holds field names, ids
--                       and states only, never contact details or message text.
SET LOCAL lock_timeout = '5s';

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS owner_id uuid;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE contacts ADD CONSTRAINT contacts_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth_users(id) ON DELETE SET NULL NOT VALID;
ALTER TABLE contacts ADD CONSTRAINT contacts_city_check CHECK (city IS NULL OR char_length(city) <= 200) NOT VALID;

ALTER TABLE custom_fields ADD CONSTRAINT custom_fields_field_type_check CHECK (field_type IN ('text','number','date','choice')) NOT VALID;
ALTER TABLE custom_fields ADD CONSTRAINT custom_fields_choice_options_check CHECK (field_type <> 'choice' OR (jsonb_typeof(field_options) = 'array' AND jsonb_array_length(field_options) BETWEEN 2 AND 50)) NOT VALID;

CREATE FUNCTION custom_fields_type_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.field_type IS DISTINCT FROM OLD.field_type THEN
    RAISE EXCEPTION 'A custom field''s type cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER custom_fields_type_fixed BEFORE UPDATE OF field_type ON custom_fields FOR EACH ROW EXECUTE FUNCTION custom_fields_type_fixed(); -- additive-exception: a row trigger on a small settings table that only refuses type changes

CREATE TABLE contact_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  actor_id uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('field_changed','owner_changed','custom_field_changed','consent_changed','blocked','unblocked','tag_removed','template_sent')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE CASCADE
);
CREATE INDEX contact_activity_contact_idx ON contact_activity(account_id, contact_id, created_at DESC);

ALTER TABLE contact_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_activity FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON contact_activity FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY tenant_insert ON contact_activity FOR INSERT TO bodhinox_app
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('agent'));
GRANT SELECT, INSERT ON contact_activity TO bodhinox_app;
GRANT SELECT ON contact_activity TO bodhinox_worker;
