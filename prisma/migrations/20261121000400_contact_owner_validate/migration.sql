-- Contacts redesign: validate the checks and the owner foreign key added NOT
-- VALID in 20261121000200. Every existing contact has owner_id and city NULL,
-- and every existing custom field is 'text' (the only type the app wrote), so
-- all pass. VALIDATE CONSTRAINT holds SHARE UPDATE EXCLUSIVE: reads and writes
-- continue during each scan. The choice-options check stays NOT VALID: it only
-- concerns choice fields, which are new. Additive.
SET LOCAL lock_timeout = '5s';

ALTER TABLE contacts VALIDATE CONSTRAINT contacts_owner_id_fkey;
ALTER TABLE contacts VALIDATE CONSTRAINT contacts_city_check;
ALTER TABLE custom_fields VALIDATE CONSTRAINT custom_fields_field_type_check;
