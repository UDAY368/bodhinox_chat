-- Database roles begin NOLOGIN; scripts/db-bootstrap-roles.ts applies operator passwords.
-- Neither runtime role owns application tables or bypasses RLS.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bodhinox_app') THEN
    CREATE ROLE bodhinox_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bodhinox_auth') THEN
    CREATE ROLE bodhinox_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bodhinox_worker') THEN
    CREATE ROLE bodhinox_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO bodhinox_app, bodhinox_auth, bodhinox_worker;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;

CREATE FUNCTION app_account_id() RETURNS uuid LANGUAGE sql STABLE SECURITY INVOKER
  AS $$ SELECT NULLIF(current_setting('app.account_id', true),'')::uuid $$;
CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE SECURITY INVOKER
  AS $$ SELECT NULLIF(current_setting('app.user_id', true),'')::uuid $$;
CREATE FUNCTION app_write_allowed(minimum_role text) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
  AS $$ SELECT current_user = 'bodhinox_worker' OR
    array_position(ARRAY['viewer','agent','admin','owner'], NULLIF(current_setting('app.account_role',true),''))
    >= array_position(ARRAY['viewer','agent','admin','owner'], minimum_role) $$;

-- Every tenant table enforces scope, including child tables and owner sessions.
DO $$ DECLARE t record; minimum_role text; BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns
    WHERE table_schema='public' AND column_name='account_id'
      AND table_name NOT IN ('auth_sessions','audit_logs','profiles','account_memberships')
  LOOP
    minimum_role := CASE WHEN t.table_name IN
      ('account_invitations','tags','custom_fields','whatsapp_config','message_templates','pipelines','pipeline_stages',
       'api_keys','webhook_endpoints','ai_configs','ai_knowledge_documents','ai_knowledge_chunks')
      THEN 'admin' WHEN t.table_name IN ('member_presence','outbox_events') THEN 'viewer' ELSE 'agent' END;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t.table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t.table_name);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT TO bodhinox_app,bodhinox_worker USING (account_id=app_account_id())',t.table_name);
    EXECUTE format('CREATE POLICY tenant_write ON %I FOR ALL TO bodhinox_app,bodhinox_worker USING (account_id=app_account_id() AND app_write_allowed(%L)) WITH CHECK (account_id=app_account_id() AND app_write_allowed(%L))',t.table_name,minimum_role,minimum_role);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO bodhinox_app,bodhinox_worker',t.table_name);
    EXECUTE format('CREATE INDEX %I ON %I (account_id)',t.table_name||'_tenant_idx',t.table_name);
  END LOOP;
END $$;

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON accounts FOR SELECT TO bodhinox_app,bodhinox_worker USING (id=app_account_id());
CREATE POLICY tenant_update ON accounts FOR UPDATE TO bodhinox_app,bodhinox_worker USING (id=app_account_id() AND app_write_allowed('admin')) WITH CHECK (id=app_account_id() AND app_write_allowed('admin'));
CREATE POLICY identity_auth ON accounts FOR ALL TO bodhinox_auth USING (true) WITH CHECK (true);
GRANT SELECT,UPDATE ON accounts TO bodhinox_app,bodhinox_worker;

ALTER TABLE account_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON account_memberships FOR SELECT TO bodhinox_app,bodhinox_worker USING (account_id=app_account_id());
CREATE POLICY identity_auth ON account_memberships FOR ALL TO bodhinox_auth USING (true) WITH CHECK (true);
GRANT SELECT ON account_memberships TO bodhinox_app,bodhinox_worker;

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON profiles FOR SELECT TO bodhinox_app,bodhinox_worker USING
  (EXISTS (SELECT 1 FROM account_memberships m WHERE m.account_id=app_account_id() AND m.user_id=profiles.user_id));
CREATE POLICY own_profile_update ON profiles FOR UPDATE TO bodhinox_app USING
  (user_id=app_user_id()) WITH CHECK (user_id=app_user_id());
CREATE POLICY identity_auth ON profiles FOR ALL TO bodhinox_auth USING (true) WITH CHECK (true);
GRANT SELECT ON profiles TO bodhinox_app,bodhinox_worker;
GRANT UPDATE (full_name,avatar_url,beta_features,updated_at) ON profiles TO bodhinox_app;

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON audit_logs FOR SELECT TO bodhinox_app,bodhinox_worker USING
  (account_id=app_account_id() AND app_write_allowed('admin'));
CREATE POLICY audit_insert ON audit_logs FOR INSERT TO bodhinox_app,bodhinox_worker WITH CHECK (account_id=app_account_id());
CREATE POLICY identity_auth ON audit_logs FOR INSERT TO bodhinox_auth WITH CHECK (true);
GRANT SELECT,INSERT ON audit_logs TO bodhinox_app,bodhinox_worker;
GRANT INSERT ON audit_logs TO bodhinox_auth;

-- Notification recipients may only see and mark their own notices.
DROP POLICY tenant_read ON notifications;
DROP POLICY tenant_write ON notifications;
CREATE POLICY notification_read ON notifications FOR SELECT TO bodhinox_app
  USING(account_id=app_account_id() AND user_id=app_user_id());
CREATE POLICY notification_update ON notifications FOR UPDATE TO bodhinox_app
  USING(account_id=app_account_id() AND user_id=app_user_id()) WITH CHECK(account_id=app_account_id() AND user_id=app_user_id());
CREATE POLICY notification_insert ON notifications FOR INSERT TO bodhinox_app
  WITH CHECK(account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY notification_worker ON notifications FOR ALL TO bodhinox_worker
  USING(account_id=app_account_id()) WITH CHECK(account_id=app_account_id());
REVOKE UPDATE,DELETE ON notifications FROM bodhinox_app;
GRANT UPDATE(read_at) ON notifications TO bodhinox_app;

DROP POLICY tenant_write ON member_presence;
CREATE POLICY own_presence_write ON member_presence FOR ALL TO bodhinox_app
  USING(account_id=app_account_id() AND user_id=app_user_id()) WITH CHECK(account_id=app_account_id() AND user_id=app_user_id());
CREATE POLICY presence_worker_write ON member_presence FOR ALL TO bodhinox_worker
  USING(account_id=app_account_id()) WITH CHECK(account_id=app_account_id());

DROP POLICY tenant_write ON message_reactions;
CREATE POLICY own_reaction_write ON message_reactions FOR ALL TO bodhinox_app
  USING(account_id=app_account_id() AND actor_type='agent' AND actor_id=app_user_id() AND app_write_allowed('agent'))
  WITH CHECK(account_id=app_account_id() AND actor_type='agent' AND actor_id=app_user_id() AND app_write_allowed('agent'));
CREATE POLICY reaction_worker_write ON message_reactions FOR ALL TO bodhinox_worker
  USING(account_id=app_account_id()) WITH CHECK(account_id=app_account_id());

DROP POLICY tenant_read ON ai_usage_log;
DROP POLICY tenant_write ON ai_usage_log;
CREATE POLICY usage_read ON ai_usage_log FOR SELECT TO bodhinox_app USING(account_id=app_account_id() AND app_write_allowed('admin'));
CREATE POLICY usage_write ON ai_usage_log FOR INSERT TO bodhinox_app WITH CHECK(account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY usage_worker ON ai_usage_log FOR ALL TO bodhinox_worker USING(account_id=app_account_id()) WITH CHECK(account_id=app_account_id());
REVOKE UPDATE,DELETE ON ai_usage_log FROM bodhinox_app;

DROP POLICY tenant_read ON outbox_events;
DROP POLICY tenant_write ON outbox_events;
CREATE POLICY event_read ON outbox_events FOR SELECT TO bodhinox_app
  USING(account_id=app_account_id() AND (recipient_user_id IS NULL OR recipient_user_id=app_user_id()));
CREATE POLICY event_insert ON outbox_events FOR INSERT TO bodhinox_app WITH CHECK(account_id=app_account_id());
CREATE POLICY event_worker ON outbox_events FOR ALL TO bodhinox_worker
  USING(account_id=app_account_id()) WITH CHECK(account_id=app_account_id());
REVOKE UPDATE,DELETE ON outbox_events FROM bodhinox_app;

GRANT SELECT,INSERT,UPDATE,DELETE ON auth_users,auth_sessions,auth_refresh_tokens,auth_verifications,
  auth_rate_limits,auth_mfa_factors,accounts,account_memberships,account_invitations TO bodhinox_auth;
GRANT SELECT,INSERT,DELETE ON profiles TO bodhinox_auth;
GRANT UPDATE(full_name,email,avatar_url,updated_at,account_id,account_role) ON profiles TO bodhinox_auth;
CREATE POLICY identity_auth ON account_invitations FOR ALL TO bodhinox_auth USING (true) WITH CHECK (true);

-- Global queue enumeration is worker-only. Its domain operations still require tenant context.
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_queue ON jobs FOR ALL TO bodhinox_worker USING (true) WITH CHECK (true);
CREATE POLICY tenant_jobs ON jobs FOR ALL TO bodhinox_app USING (tenant_id=app_account_id()) WITH CHECK (tenant_id=app_account_id());
GRANT SELECT,INSERT,UPDATE,DELETE ON jobs TO bodhinox_worker;
GRANT SELECT,INSERT ON jobs TO bodhinox_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON webhook_receipts TO bodhinox_worker;

CREATE UNIQUE INDEX idx_contacts_account_phone_normalized ON contacts(account_id,phone_normalized) WHERE phone_normalized <> '';
CREATE UNIQUE INDEX idx_contacts_account_wa_user_id ON contacts(account_id,wa_user_id) WHERE wa_user_id IS NOT NULL;
CREATE UNIQUE INDEX idx_conversations_account_contact ON conversations(account_id,contact_id);
CREATE UNIQUE INDEX idx_messages_conversation_message_id ON messages(conversation_id,message_id);
CREATE UNIQUE INDEX idx_one_active_run_per_contact ON flow_runs(account_id,contact_id) WHERE status='active';
CREATE UNIQUE INDEX idx_broadcast_recipients_wamid ON broadcast_recipients(whatsapp_message_id) WHERE whatsapp_message_id IS NOT NULL;
CREATE UNIQUE INDEX message_templates_account_name_language_key ON message_templates(account_id,name,language);
CREATE UNIQUE INDEX whatsapp_config_phone_number_id_key ON whatsapp_config(phone_number_id);
CREATE INDEX whatsapp_config_verify_hash_idx ON whatsapp_config(verify_token_hash) WHERE verify_token_hash IS NOT NULL;
CREATE INDEX ai_knowledge_chunks_fts_idx ON ai_knowledge_chunks USING gin(fts);
CREATE INDEX ai_knowledge_chunks_embedding_idx ON ai_knowledge_chunks USING hnsw(embedding vector_cosine_ops);
CREATE INDEX jobs_claim_idx ON jobs(run_at,lease_until) WHERE status IN ('pending','running');
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);
CREATE INDEX auth_sessions_expires_idx ON auth_sessions(expires_at) WHERE revoked_at IS NULL;
CREATE INDEX auth_refresh_session_idx ON auth_refresh_tokens(session_id);
CREATE INDEX auth_verifications_user_idx ON auth_verifications(user_id);
CREATE INDEX idx_automation_pending_due ON automation_pending_executions(run_at) WHERE status='pending';
CREATE INDEX idx_automation_pending_awaiting_reply ON automation_pending_executions(account_id,contact_id) WHERE status='awaiting_reply';
CREATE INDEX idx_flow_runs_active_advanced ON flow_runs(last_advanced_at) WHERE status='active';
CREATE INDEX idx_flows_active_trigger ON flows(account_id,trigger_type) WHERE status='active';
CREATE INDEX idx_automations_account_active_trigger ON automations(account_id,trigger_type) WHERE is_active;
CREATE INDEX idx_notifications_user_created ON notifications(account_id,user_id,created_at DESC);
CREATE INDEX outbox_cursor_idx ON outbox_events(account_id,created_at,id);
CREATE INDEX messages_account_provider_idx ON messages(account_id,message_id);
CREATE INDEX messages_conversation_time_idx ON messages(account_id,conversation_id,created_at,id);
CREATE INDEX contacts_account_created_idx ON contacts(account_id,created_at,id);
CREATE INDEX broadcast_recipients_status_idx ON broadcast_recipients(account_id,broadcast_id,status);
CREATE INDEX automation_steps_order_idx ON automation_steps(account_id,automation_id,parent_step_id,position);
CREATE INDEX flow_nodes_flow_idx ON flow_nodes(account_id,flow_id);
CREATE INDEX flow_events_history_idx ON flow_run_events(account_id,flow_run_id,created_at);

-- Stronger same-parent checks within a tenant prevent inconsistent relation payloads.
ALTER TABLE pipeline_stages ADD CONSTRAINT pipeline_stages_pipeline_identity UNIQUE(account_id,pipeline_id,id);
ALTER TABLE deals ADD CONSTRAINT deals_stage_pipeline_fkey FOREIGN KEY(account_id,pipeline_id,stage_id)
  REFERENCES pipeline_stages(account_id,pipeline_id,id);
ALTER TABLE messages ADD CONSTRAINT messages_conversation_identity UNIQUE(account_id,conversation_id,id);
ALTER TABLE message_reactions ADD CONSTRAINT reactions_message_conversation_fkey FOREIGN KEY(account_id,conversation_id,message_id)
  REFERENCES messages(account_id,conversation_id,id) ON DELETE CASCADE;
ALTER TABLE automation_steps ADD CONSTRAINT automation_steps_parent_identity UNIQUE(account_id,automation_id,id);
ALTER TABLE automation_steps ADD CONSTRAINT automation_steps_same_parent_fkey FOREIGN KEY(account_id,automation_id,parent_step_id)
  REFERENCES automation_steps(account_id,automation_id,id) ON DELETE CASCADE;
ALTER TABLE auth_refresh_tokens ADD CONSTRAINT auth_refresh_session_identity UNIQUE(session_id,id);
ALTER TABLE auth_refresh_tokens ADD CONSTRAINT auth_refresh_replacement_family_fkey FOREIGN KEY(session_id,replacement_id)
  REFERENCES auth_refresh_tokens(session_id,id) ON DELETE SET NULL(replacement_id);

CREATE FUNCTION update_updated_at_column() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN NEW.updated_at=now(); RETURN NEW; END $$;
DO $$ DECLARE t record; BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='updated_at'
  LOOP EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()', t.table_name); END LOOP;
END $$;

-- Member profile ids are shared across memberships; assignment checks membership, not home profile account.
CREATE FUNCTION check_deal_assignment() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF NEW.assigned_to IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM profiles p JOIN account_memberships m ON m.user_id=p.user_id WHERE p.id=NEW.assigned_to AND m.account_id=NEW.account_id)
  THEN RAISE EXCEPTION 'Assignee is not an account member' USING ERRCODE='23503'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deal_assignment_membership BEFORE INSERT OR UPDATE OF assigned_to,account_id ON deals FOR EACH ROW EXECUTE FUNCTION check_deal_assignment();

CREATE FUNCTION notify_conversation_assigned() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE contact_name text; actor_name text;
BEGIN
  IF NEW.assigned_agent_id IS NULL OR NEW.assigned_agent_id=app_user_id() THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN RETURN NEW; END IF;
  SELECT COALESCE(NULLIF(name,''),phone) INTO contact_name FROM contacts WHERE id=NEW.contact_id AND account_id=NEW.account_id;
  SELECT full_name INTO actor_name FROM profiles WHERE user_id=app_user_id();
  INSERT INTO notifications(account_id,user_id,type,conversation_id,contact_id,actor_user_id,title,body)
  VALUES(NEW.account_id,NEW.assigned_agent_id,'conversation_assigned',NEW.id,NEW.contact_id,app_user_id(),
    'New conversation assigned',COALESCE(actor_name,'Someone')||' assigned you a conversation with '||COALESCE(contact_name,'a contact'));
  RETURN NEW;
END $$;
CREATE TRIGGER on_conversation_assigned AFTER INSERT OR UPDATE OF assigned_agent_id ON conversations FOR EACH ROW EXECUTE FUNCTION notify_conversation_assigned();

CREATE FUNCTION emit_domain_outbox_event() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE tenant uuid; recipient uuid; new_row jsonb; old_row jsonb;
BEGIN
  IF TG_OP='DELETE' THEN old_row=to_jsonb(OLD); tenant=OLD.account_id;
  ELSIF TG_OP='INSERT' THEN new_row=to_jsonb(NEW); tenant=NEW.account_id;
  ELSE old_row=to_jsonb(OLD); new_row=to_jsonb(NEW); tenant=NEW.account_id; END IF;
  -- Tenant deletion cascades must not recreate outbox children under a deleted parent.
  IF NOT EXISTS(SELECT 1 FROM accounts WHERE id=tenant) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_TABLE_NAME='notifications' THEN recipient=COALESCE(new_row,old_row)->>'user_id'; END IF;
  INSERT INTO outbox_events(account_id,recipient_user_id,event_type,payload)
  VALUES(tenant,recipient,TG_TABLE_NAME||'.'||TG_OP,
    jsonb_build_object('table',TG_TABLE_NAME,'eventType',TG_OP,'new',new_row,'old',old_row));
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['messages','conversations','message_reactions','notifications','member_presence','contacts','deals','broadcast_recipients','broadcasts']
  LOOP EXECUTE format('CREATE TRIGGER domain_outbox AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION emit_domain_outbox_event()',t); END LOOP;
END $$;

CREATE FUNCTION claim_ai_reply_slot(conversation_id uuid,max_replies integer) RETURNS boolean LANGUAGE sql SECURITY INVOKER AS $$
  WITH claimed AS (UPDATE conversations SET ai_reply_count=ai_reply_count+1 WHERE id=conversation_id
    AND NOT ai_autoreply_disabled AND ai_reply_count < LEAST(GREATEST(max_replies,0),20) RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM claimed)
$$;
CREATE FUNCTION bump_conversation_on_inbound(p_conversation_id uuid,p_last_message_text text) RETURNS void LANGUAGE sql SECURITY INVOKER AS $$
  UPDATE conversations SET unread_count=COALESCE(unread_count,0)+1,last_message_text=p_last_message_text,last_message_at=now(),updated_at=now() WHERE id=p_conversation_id
$$;
CREATE FUNCTION increment_automation_execution_count(p_automation_id uuid) RETURNS void LANGUAGE sql SECURITY INVOKER AS $$
  UPDATE automations SET execution_count=execution_count+1,last_executed_at=now() WHERE id=p_automation_id
$$;
CREATE FUNCTION increment_flow_execution_count(p_flow_id uuid) RETURNS void LANGUAGE sql SECURITY INVOKER AS $$
  UPDATE flows SET execution_count=execution_count+1,last_executed_at=now() WHERE id=p_flow_id
$$;
CREATE FUNCTION record_webhook_failure(endpoint_id uuid,max_failures integer) RETURNS void LANGUAGE sql SECURITY INVOKER AS $$
  UPDATE webhook_endpoints SET failure_count=failure_count+1,is_active=CASE WHEN failure_count+1>=max_failures THEN false ELSE is_active END WHERE id=endpoint_id
$$;
CREATE FUNCTION match_ai_knowledge_fts(p_account_id uuid,p_query text,p_match_count integer)
RETURNS TABLE(id uuid,content text,rank real) LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT c.id,c.content,ts_rank(c.fts,plainto_tsquery('simple',p_query)) AS rank
  FROM ai_knowledge_chunks c WHERE c.account_id=p_account_id AND c.fts @@ plainto_tsquery('simple',p_query)
  ORDER BY rank DESC LIMIT LEAST(GREATEST(p_match_count,0),100)
$$;
CREATE FUNCTION match_ai_knowledge_semantic(p_account_id uuid,p_query_embedding text,p_match_count integer)
RETURNS TABLE(id uuid,content text,distance real) LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT c.id,c.content,(c.embedding <=> p_query_embedding::vector(1536))::real FROM ai_knowledge_chunks c
  WHERE c.account_id=p_account_id AND c.embedding IS NOT NULL
  ORDER BY c.embedding <=> p_query_embedding::vector(1536) LIMIT LEAST(GREATEST(p_match_count,0),100)
$$;
CREATE FUNCTION touch_presence(p_status text DEFAULT 'online') RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF app_user_id() IS NULL OR app_account_id() IS NULL THEN RAISE EXCEPTION 'Unauthorized' USING ERRCODE='42501'; END IF;
  INSERT INTO member_presence(user_id,account_id,status,last_seen_at) VALUES(app_user_id(),app_account_id(),p_status,now())
  ON CONFLICT(account_id,user_id) DO UPDATE SET status=EXCLUDED.status,last_seen_at=now();
END $$;

CREATE FUNCTION create_broadcast_with_recipients(p_account_id uuid,p_user_id uuid,p_name text,p_template_name text,
  p_template_language text,p_total_recipients integer,p_contact_ids uuid[],p_template_params jsonb[] DEFAULT NULL)
RETURNS TABLE(broadcast_id uuid,recipient_id uuid,contact_id uuid) LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE v_broadcast_id uuid;
BEGIN
  IF p_account_id IS DISTINCT FROM app_account_id() THEN RAISE EXCEPTION 'Tenant mismatch' USING ERRCODE='42501'; END IF;
  IF COALESCE(cardinality(p_contact_ids),0) <> p_total_recipients THEN RAISE EXCEPTION 'Recipient count mismatch' USING ERRCODE='22023'; END IF;
  INSERT INTO broadcasts(account_id,user_id,name,template_name,template_language,status,total_recipients)
  VALUES(p_account_id,p_user_id,p_name,p_template_name,p_template_language,'sending',p_total_recipients) RETURNING id INTO v_broadcast_id;
  RETURN QUERY WITH ins AS (
    INSERT INTO broadcast_recipients(account_id,broadcast_id,contact_id,status,template_params)
    SELECT p_account_id,v_broadcast_id,t.cid,'pending',t.prm FROM unnest(p_contact_ids,p_template_params) AS t(cid,prm)
    RETURNING broadcast_recipients.id,broadcast_recipients.contact_id
  ) SELECT v_broadcast_id,ins.id,ins.contact_id FROM ins;
END $$;

-- Only this fixed routing projection is enumerable without tenant context.
CREATE FUNCTION resolve_whatsapp_routing(p_phone_number_id text)
RETURNS TABLE(account_id uuid,user_id uuid,verify_token text) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=public,pg_temp AS $$
  SELECT w.account_id,w.user_id,w.verify_token FROM whatsapp_config w WHERE w.phone_number_id=p_phone_number_id
$$;
CREATE FUNCTION crm_resolve_whatsapp_account(p_phone_number_id text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT w.account_id FROM whatsapp_config w WHERE w.phone_number_id=p_phone_number_id
$$;
CREATE FUNCTION crm_resolve_api_key(p_key_hash text)
RETURNS TABLE(id uuid,account_id uuid,scopes text[],revoked_at timestamptz,expires_at timestamptz,created_by uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT k.id,k.account_id,k.scopes,k.revoked_at,k.expires_at,k.created_by FROM api_keys k WHERE k.key_hash=p_key_hash
$$;
CREATE FUNCTION crm_verify_webhook_token(p_hash text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM whatsapp_config w WHERE w.verify_token_hash=p_hash)
$$;
-- FORCE RLS prevents owner bypass too; a dedicated owner policy grants this one definer projection.
DO $$ BEGIN
  EXECUTE format('CREATE POLICY migration_owner ON whatsapp_config FOR SELECT TO %I USING (true)',current_user);
  EXECUTE format('CREATE POLICY migration_owner ON api_keys FOR SELECT TO %I USING (true)',current_user);
END $$;

-- Revoke default function execution: only trusted runtime roles receive the explicit callable surface.
DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND NOT EXISTS
      (SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.classid='pg_proc'::regclass AND d.deptype='e')
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature); END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION app_account_id(),app_user_id(),app_write_allowed(text) TO bodhinox_app,bodhinox_auth,bodhinox_worker;
GRANT EXECUTE ON FUNCTION update_updated_at_column(),check_deal_assignment(),notify_conversation_assigned(),emit_domain_outbox_event() TO bodhinox_app,bodhinox_auth,bodhinox_worker;
GRANT EXECUTE ON FUNCTION claim_ai_reply_slot(uuid,integer),bump_conversation_on_inbound(uuid,text),
  increment_automation_execution_count(uuid),increment_flow_execution_count(uuid),record_webhook_failure(uuid,integer),
  match_ai_knowledge_fts(uuid,text,integer),match_ai_knowledge_semantic(uuid,text,integer),touch_presence(text),
  create_broadcast_with_recipients(uuid,uuid,text,text,text,integer,uuid[],jsonb[]) TO bodhinox_app,bodhinox_worker;
GRANT EXECUTE ON FUNCTION resolve_whatsapp_routing(text) TO bodhinox_worker;
GRANT EXECUTE ON FUNCTION crm_resolve_whatsapp_account(text),crm_resolve_api_key(text),crm_verify_webhook_token(text) TO bodhinox_worker;
