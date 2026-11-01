-- resolve_click_token is SECURITY DEFINER, and FORCE RLS applies to its owner too:
-- grant the owner read access to the two tables this one definer projection needs
-- (same pattern as migration_owner in the foundation migration).
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['broadcasts','broadcast_recipients']
  LOOP
    EXECUTE format('CREATE POLICY click_migration_owner ON %I FOR SELECT TO %I USING (true)',t,current_user);
  END LOOP;
END $$;
