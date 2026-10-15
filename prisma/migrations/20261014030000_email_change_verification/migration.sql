-- Email changes are proved by an expiring single-use token before modifying identity.
ALTER TABLE auth_verifications ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}';
ALTER TABLE auth_verifications DROP CONSTRAINT auth_verifications_purpose_check;
ALTER TABLE auth_verifications ADD CONSTRAINT auth_verifications_purpose_check
  CHECK (purpose IN ('verify','reset','change_email'));
