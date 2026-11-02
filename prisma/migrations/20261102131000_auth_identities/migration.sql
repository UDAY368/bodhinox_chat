-- External sign-in identities (Google). Only the auth role can read or write them; the app and
-- worker roles never see this table. One Google account per user and per Google subject.
CREATE TABLE auth_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google')),
  subject TEXT NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 255),
  email TEXT NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, subject),
  UNIQUE (user_id, provider)
);

REVOKE ALL ON auth_identities FROM PUBLIC;
ALTER TABLE auth_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_auth ON auth_identities FOR ALL TO bodhinox_auth USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, DELETE ON auth_identities TO bodhinox_auth;
GRANT UPDATE (email) ON auth_identities TO bodhinox_auth;
