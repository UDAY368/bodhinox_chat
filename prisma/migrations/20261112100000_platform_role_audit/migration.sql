-- Phase 14: restricted platform administration, part 1.
--
-- bodhinox_platform is a fourth runtime role for the platform console. It has
-- NO table grants: it can only execute the crm_platform_* SECURITY DEFINER
-- functions, each of which returns fixed columns (ids, names, counts, statuses,
-- error codes) and never message bodies, contact fields, secrets or tokens.
-- Like the other roles it starts NOLOGIN; scripts/db-bootstrap-roles.ts applies
-- the operator password only when PLATFORM_DATABASE_URL is configured, so an
-- environment without it has no way to log in as this role.
--
-- platform_audit_log is the platform-side trail: FORCE RLS with only the owner
-- policy and no role grants, written only through crm_platform_audit and the
-- mutating crm_platform_* functions, and append-only (a trigger rejects UPDATE
-- and DELETE). target_account_id has no foreign key, so the trail outlives a
-- workspace. Every mutating platform function that targets a workspace also
-- writes a tenant audit_logs row in the same call (owner INSERT policy below).
-- Additive.
SET LOCAL lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bodhinox_platform') THEN
    CREATE ROLE bodhinox_platform NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO bodhinox_platform;

CREATE TABLE platform_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_email text NOT NULL CHECK (char_length(admin_email) BETWEEN 3 AND 254 AND admin_email LIKE '%@%'),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.]{1,79}$'),
  target_account_id uuid,
  target_ref text CHECK (char_length(target_ref) <= 200),
  reason text CHECK (char_length(reason) <= 1000),
  -- Ids, statuses, counts and amounts only.
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object' AND pg_column_size(detail) <= 16384),
  ip_hash text CHECK (ip_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_audit_log_created_idx ON platform_audit_log(created_at DESC);
CREATE INDEX platform_audit_log_account_idx ON platform_audit_log(target_account_id, created_at DESC)
  WHERE target_account_id IS NOT NULL;
ALTER TABLE platform_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_audit_log FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform_audit_log FROM PUBLIC;
DO $$ BEGIN
  EXECUTE format('CREATE POLICY platform_audit_owner ON platform_audit_log FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
END $$;

CREATE FUNCTION platform_audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_log is append-only' USING ERRCODE = '42501';
END $$;
REVOKE ALL ON FUNCTION platform_audit_log_append_only() FROM PUBLIC;
CREATE TRIGGER platform_audit_log_append_only BEFORE UPDATE OR DELETE ON platform_audit_log
  FOR EACH ROW EXECUTE FUNCTION platform_audit_log_append_only();
CREATE TRIGGER platform_audit_log_no_truncate BEFORE TRUNCATE ON platform_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION platform_audit_log_append_only();

-- The tenant half of a platform action: a workspace audit row with no user
-- (user_id is the historical identity of a tenant member; a platform admin is
-- not one), naming the admin in metadata. FORCE RLS applies to the definer.
DO $$ BEGIN
  EXECUTE format('CREATE POLICY platform_audit_owner_insert ON audit_logs FOR INSERT TO %I WITH CHECK (true)', current_user);
END $$;

-- Writes one platform audit row and, when it targets a workspace, the tenant
-- audit row, in the caller's transaction. Executable by the platform role (the
-- console) and the worker (the prices and rate-card routes stay on the worker).
CREATE FUNCTION crm_platform_audit(p_admin_email text, p_action text, p_account uuid, p_target_ref text,
  p_reason text, p_detail jsonb, p_ip_hash text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result uuid;
BEGIN
  IF p_admin_email IS NULL OR p_action IS NULL THEN RAISE EXCEPTION 'admin email and action are required'; END IF;
  INSERT INTO platform_audit_log(admin_email, action, target_account_id, target_ref, reason, detail, ip_hash)
  VALUES (lower(trim(p_admin_email)), p_action, p_account, left(p_target_ref, 200), left(p_reason, 1000),
    COALESCE(p_detail, '{}'::jsonb), p_ip_hash)
  RETURNING id INTO result;
  IF p_account IS NOT NULL AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = p_account) THEN
    INSERT INTO audit_logs(account_id, user_id, action, resource_id, metadata)
    VALUES (p_account, NULL, p_action, left(p_target_ref, 200),
      jsonb_build_object('platform_admin_email', lower(trim(p_admin_email)), 'platform_audit_id', result));
  END IF;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION crm_platform_audit(text, text, uuid, text, text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_platform_audit(text, text, uuid, text, text, jsonb, text) TO bodhinox_platform, bodhinox_worker;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'accounts'
      AND current_user::name = ANY(p.roles) AND p.cmd IN ('SELECT','ALL')) THEN
    EXECUTE format('CREATE POLICY platform_owner_read ON accounts FOR SELECT TO %I USING (true)', current_user);
  END IF;
END $$;
