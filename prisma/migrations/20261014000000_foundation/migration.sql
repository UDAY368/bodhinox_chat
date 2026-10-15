-- Bodhinox Chat reviewed PostgreSQL baseline. Source: 46 upstream migrations.

-- Tenant child keys and identity boundaries are deliberate foundation additions.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  avatar_url TEXT,
  role TEXT DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id),
  beta_features TEXT[]
    NOT NULL
    DEFAULT ARRAY[]::TEXT[],
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  account_role TEXT NOT NULL CHECK (account_role IN ('owner','admin','agent','viewer')),
  UNIQUE (account_id, id)
);

CREATE TABLE contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  phone TEXT NOT NULL,
  name TEXT,
  email TEXT,
  company TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  phone_normalized TEXT
  GENERATED ALWAYS AS (regexp_replace(phone, '\D', '', 'g')) STORED,
  wa_user_id TEXT,
  wa_parent_user_id TEXT,
  wa_username TEXT,
  UNIQUE (account_id, id)
);

CREATE TABLE tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#3b82f6',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  UNIQUE (account_id, id)
);

CREATE TABLE contact_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL,
  tag_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(contact_id, tag_id),
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  UNIQUE (account_id, id)
);

CREATE TABLE custom_fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  field_name TEXT NOT NULL,
  field_type TEXT NOT NULL DEFAULT 'text',
  field_options JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  UNIQUE (account_id, id)
);

CREATE TABLE contact_custom_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL,
  custom_field_id UUID NOT NULL,
  value TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(contact_id, custom_field_id),
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  UNIQUE (account_id, id)
);

CREATE TABLE contact_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL,
  user_id UUID NOT NULL,
  note_text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  UNIQUE (account_id, id)
);

CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  contact_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'closed')),
  assigned_agent_id UUID,
  last_message_text TEXT,
  last_message_at TIMESTAMPTZ,
  unread_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  ai_autoreply_disabled boolean NOT NULL DEFAULT false,
  ai_reply_count integer NOT NULL DEFAULT 0,
  ai_handoff_summary text,
  UNIQUE (account_id, id)
);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('customer', 'agent', 'bot')),
  sender_id UUID,
  content_type TEXT NOT NULL DEFAULT 'text' CHECK (content_type IN ('text','image','document','audio','video','location','template','interactive')),
  content_text TEXT,
  media_url TEXT,
  template_name TEXT,
  message_id TEXT,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sending', 'sent', 'delivered', 'read', 'failed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  reply_to_message_id UUID,
  interactive_reply_id TEXT,
  ai_generated boolean NOT NULL DEFAULT false,
  interactive_payload JSONB,
  media_type TEXT,
  error_code INTEGER,
  error_title TEXT,
  error_details TEXT,
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  UNIQUE (account_id, id)
);

CREATE TABLE whatsapp_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  phone_number_id TEXT NOT NULL,
  waba_id TEXT,
  access_token TEXT NOT NULL,
  verify_token TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('connected', 'disconnected')),
  connected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  registered_at TIMESTAMPTZ,
  subscribed_apps_at TIMESTAMPTZ,
  last_registration_error TEXT,
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  mirror_inbound_media BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (account_id),
  verify_token_hash TEXT CHECK (verify_token_hash IS NULL OR verify_token_hash ~ '^[0-9a-f]{64}$'),
  UNIQUE (account_id, id)
);

CREATE TABLE message_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Marketing' CHECK (category IN ('Marketing', 'Utility', 'Authentication')),
  language TEXT DEFAULT 'en_US',
  header_type TEXT CHECK (header_type IN ('text', 'image', 'video', 'document')),
  header_content TEXT,
  body_text TEXT NOT NULL,
  footer_text TEXT,
  buttons JSONB,
  status TEXT DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING','APPROVED','REJECTED','PAUSED','DISABLED','IN_APPEAL','PENDING_DELETION')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  sample_values JSONB,
  meta_template_id TEXT,
  rejection_reason TEXT,
  quality_score TEXT CHECK (quality_score IS NULL OR quality_score IN ('GREEN','YELLOW','RED')),
  header_handle TEXT,
  header_media_url TEXT,
  submission_error TEXT,
  last_submitted_at TIMESTAMPTZ,
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  CHECK (buttons IS NULL OR (jsonb_typeof(buttons) = 'array' AND jsonb_array_length(buttons) <= 10)),
  UNIQUE (account_id, id)
);

CREATE TABLE pipelines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  UNIQUE (account_id, id)
);

CREATE TABLE pipeline_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id UUID NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT '#3b82f6',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  UNIQUE (account_id, id)
);

CREATE TABLE deals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  pipeline_id UUID NOT NULL,
  stage_id UUID NOT NULL,
  contact_id UUID,
  conversation_id UUID,
  title TEXT NOT NULL,
  value NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  notes TEXT,
  expected_close_date DATE,
  status TEXT DEFAULT 'open' CHECK (status IN ('open','won','lost')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  assigned_to UUID,
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  UNIQUE (account_id, id)
);

CREATE TABLE broadcasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  template_name TEXT NOT NULL,
  template_language TEXT NOT NULL DEFAULT 'en_US',
  template_variables JSONB,
  audience_filter JSONB,
  scheduled_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed')),
  total_recipients INTEGER DEFAULT 0,
  sent_count INTEGER DEFAULT 0,
  delivered_count INTEGER DEFAULT 0,
  read_count INTEGER DEFAULT 0,
  replied_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  delivery_locked_at TIMESTAMPTZ,
  UNIQUE (account_id, id)
);

CREATE TABLE broadcast_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id UUID NOT NULL,
  contact_id UUID,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'replied', 'failed')),
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  replied_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  whatsapp_message_id TEXT,
  template_params JSONB,
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  UNIQUE (account_id, id)
);

CREATE TABLE automations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  trigger_type TEXT NOT NULL,
  trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  execution_count INTEGER NOT NULL DEFAULT 0,
  last_executed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  UNIQUE (account_id, id)
);

CREATE TABLE automation_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id UUID NOT NULL,
  parent_step_id UUID,
  branch TEXT CHECK (branch IN ('yes', 'no')),
  step_type TEXT NOT NULL,
  step_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  position INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  UNIQUE (account_id, id)
);

CREATE TABLE automation_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id UUID NOT NULL,
  user_id UUID NOT NULL,
  contact_id UUID,
  trigger_event TEXT NOT NULL,
  steps_executed JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  UNIQUE (account_id, id)
);

CREATE TABLE automation_pending_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id UUID NOT NULL,
  user_id UUID NOT NULL,
  contact_id UUID,
  log_id UUID,
  parent_step_id UUID,
  branch TEXT CHECK (branch IN ('yes', 'no')),
  next_step_position INTEGER NOT NULL,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','awaiting_reply','expired','superseded')),
  run_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  UNIQUE (account_id, id)
);

CREATE TABLE message_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('customer', 'agent')),
  actor_id UUID,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, actor_type, actor_id),
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  UNIQUE (account_id, id)
);

CREATE TABLE flows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'archived')),
  trigger_type TEXT NOT NULL
    CHECK (trigger_type IN ('keyword', 'first_inbound_message', 'manual')),
  trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  entry_node_id TEXT,
  fallback_policy JSONB NOT NULL DEFAULT
    '{"on_unknown_reply":"reprompt","max_reprompts":2,"on_timeout_hours":24,"on_exhaust":"handoff"}'::jsonb,
  execution_count INTEGER NOT NULL DEFAULT 0,
  last_executed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  UNIQUE (account_id, id)
);

CREATE TABLE flow_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id UUID NOT NULL,
  node_key TEXT NOT NULL,
  node_type TEXT NOT NULL CHECK (node_type IN ('start','send_buttons','send_list','send_message','send_media','collect_input','condition','set_tag','handoff','http_fetch','end')),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  position_x INTEGER NOT NULL DEFAULT 0,
  position_y INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (flow_id, node_key),
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  UNIQUE (account_id, id)
);

CREATE TABLE flow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id UUID NOT NULL,
  user_id UUID NOT NULL,
  contact_id UUID,
  conversation_id UUID,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
    'active',           
    'completed',        
    'handed_off',       
    'timed_out',        
    'paused_by_agent',  
    'failed'            
  )),
  current_node_key TEXT,
  last_prompt_message_id UUID,
  vars JSONB NOT NULL DEFAULT '{}'::jsonb,
  reprompt_count INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_advanced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  end_reason TEXT,
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  UNIQUE (account_id, id)
);

CREATE TABLE flow_run_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_run_id UUID NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'started',
    'node_entered',
    'message_sent',
    'reply_received',
    'fallback_fired',
    'handoff',
    'timeout',
    'error',
    'completed'
  )),
  node_key TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  UNIQUE (account_id, id)
);

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  default_currency TEXT NOT NULL DEFAULT 'USD' CHECK (default_currency ~ '^[A-Z]{3}$')
);

CREATE TABLE account_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role <> 'owner'),
  created_by_user_id UUID,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_by_user_id UUID,
  UNIQUE (account_id, id)
);

CREATE TABLE member_presence (
  user_id UUID NOT NULL,
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  status       TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'away')),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id)
);

CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  created_by   uuid,
  name         text NOT NULL,
  key_prefix   text NOT NULL,
  key_hash     text NOT NULL UNIQUE,
  scopes       text[] NOT NULL DEFAULT '{}',
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)
);

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  user_id UUID NOT NULL,
  type TEXT NOT NULL DEFAULT 'conversation_assigned'
    CHECK (type IN ('conversation_assigned')),
  conversation_id UUID,
  contact_id UUID,
  actor_user_id UUID,
  title TEXT NOT NULL,
  body TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, id)
);

CREATE TABLE webhook_endpoints (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  created_by       uuid,
  url              text NOT NULL,
  secret           text NOT NULL,
  events           text[] NOT NULL DEFAULT '{}',
  is_active        boolean NOT NULL DEFAULT true,
  last_delivery_at timestamptz,
  failure_count    integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)
);

CREATE TABLE ai_configs (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  created_by                        uuid,
  provider TEXT NOT NULL CHECK (provider IN ('openai','anthropic','openai_compatible')),
  model                             text NOT NULL,
  api_key                           text NOT NULL,
  system_prompt                     text,
  is_active                         boolean NOT NULL DEFAULT false,
  auto_reply_enabled                boolean NOT NULL DEFAULT false,
  auto_reply_max_per_conversation   integer NOT NULL DEFAULT 3
                                      CHECK (auto_reply_max_per_conversation BETWEEN 1 AND 20),
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now(),
  embeddings_api_key text,
  handoff_agent_id uuid,
  base_url text,
  CHECK (provider <> 'openai_compatible' OR (base_url IS NOT NULL AND btrim(base_url) <> '')),
  UNIQUE (account_id, id)
);

CREATE TABLE ai_knowledge_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  created_by  uuid,
  title       text NOT NULL,
  content     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)
);

CREATE TABLE ai_knowledge_chunks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL,
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  chunk_index  integer NOT NULL DEFAULT 0,
  content      text NOT NULL,
  fts          tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  embedding    vector(1536),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)
);

CREATE TABLE ai_usage_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  conversation_id   uuid,
  mode              text NOT NULL CHECK (mode IN ('auto_reply', 'draft')),
  provider TEXT NOT NULL CHECK (provider IN ('openai','anthropic','openai_compatible')),
  model             text NOT NULL,
  prompt_tokens     integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  total_tokens      integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)
);

CREATE TABLE quick_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  user_id UUID NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'interactive')),
  content_text TEXT,
  interactive_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, id)
);

CREATE TABLE auth_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  email_verified_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  account_id UUID NOT NULL,
  csrf_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  mfa_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)
);

CREATE TABLE auth_refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  replacement_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE auth_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify','reset')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE TABLE account_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  user_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','agent','viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id,user_id),
  UNIQUE (account_id, id)
);

CREATE TABLE auth_rate_limits (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  reset_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE auth_mfa_factors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE,
  secret_encrypted TEXT NOT NULL,
  verified_at TIMESTAMPTZ,
  last_used_step BIGINT,
  recovery_hashes TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  tenant_id UUID,
  payload JSONB NOT NULL DEFAULT '{}',
  dedupe_key TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE webhook_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE outbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  recipient_user_id UUID,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)
);

CREATE TABLE outbound_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  conversation_id UUID,
  provider_message_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','dispatching','accepted','unknown','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  UNIQUE (account_id, id)
);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID,
  user_id UUID,
  action TEXT NOT NULL,
  resource_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)
);

CREATE TABLE media_objects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  uploaded_by UUID,
  object_key TEXT NOT NULL,
  bucket TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
  original_name TEXT,
  conversation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE(account_id,bucket,object_key),
  UNIQUE (account_id, id)
);

ALTER TABLE profiles ADD CONSTRAINT profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE CASCADE;

ALTER TABLE profiles ADD CONSTRAINT profiles_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE contacts ADD CONSTRAINT contacts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE CASCADE;

ALTER TABLE contacts ADD CONSTRAINT contacts_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE tags ADD CONSTRAINT tags_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE CASCADE;

ALTER TABLE tags ADD CONSTRAINT tags_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE contact_tags ADD CONSTRAINT contact_tags_contact_id_fkey FOREIGN KEY (account_id, contact_id) REFERENCES contacts (account_id, id) ON DELETE CASCADE;

ALTER TABLE contact_tags ADD CONSTRAINT contact_tags_tag_id_fkey FOREIGN KEY (account_id, tag_id) REFERENCES tags (account_id, id) ON DELETE CASCADE;

ALTER TABLE contact_tags ADD CONSTRAINT contact_tags_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE custom_fields ADD CONSTRAINT custom_fields_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE CASCADE;

ALTER TABLE custom_fields ADD CONSTRAINT custom_fields_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE contact_custom_values ADD CONSTRAINT contact_custom_values_contact_id_fkey FOREIGN KEY (account_id, contact_id) REFERENCES contacts (account_id, id) ON DELETE CASCADE;

ALTER TABLE contact_custom_values ADD CONSTRAINT contact_custom_values_custom_field_id_fkey FOREIGN KEY (account_id, custom_field_id) REFERENCES custom_fields (account_id, id) ON DELETE CASCADE;

ALTER TABLE contact_custom_values ADD CONSTRAINT contact_custom_values_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE contact_notes ADD CONSTRAINT contact_notes_contact_id_fkey FOREIGN KEY (account_id, contact_id) REFERENCES contacts (account_id, id) ON DELETE CASCADE;

ALTER TABLE contact_notes ADD CONSTRAINT contact_notes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE CASCADE;

ALTER TABLE contact_notes ADD CONSTRAINT contact_notes_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE conversations ADD CONSTRAINT conversations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE CASCADE;

ALTER TABLE conversations ADD CONSTRAINT conversations_contact_id_fkey FOREIGN KEY (account_id, contact_id) REFERENCES contacts (account_id, id) ON DELETE CASCADE;

ALTER TABLE conversations ADD CONSTRAINT conversations_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE messages ADD CONSTRAINT messages_conversation_id_fkey FOREIGN KEY (account_id, conversation_id) REFERENCES conversations (account_id, id) ON DELETE CASCADE;

ALTER TABLE messages ADD CONSTRAINT messages_reply_to_message_id_fkey FOREIGN KEY (account_id, reply_to_message_id) REFERENCES messages (account_id, id) ON DELETE SET NULL (reply_to_message_id);

ALTER TABLE messages ADD CONSTRAINT messages_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE whatsapp_config ADD CONSTRAINT whatsapp_config_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE CASCADE;

ALTER TABLE whatsapp_config ADD CONSTRAINT whatsapp_config_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE message_templates ADD CONSTRAINT message_templates_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE CASCADE;

ALTER TABLE message_templates ADD CONSTRAINT message_templates_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE pipelines ADD CONSTRAINT pipelines_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE CASCADE;

ALTER TABLE pipelines ADD CONSTRAINT pipelines_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE pipeline_stages ADD CONSTRAINT pipeline_stages_pipeline_id_fkey FOREIGN KEY (account_id, pipeline_id) REFERENCES pipelines (account_id, id) ON DELETE CASCADE;

ALTER TABLE pipeline_stages ADD CONSTRAINT pipeline_stages_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE deals ADD CONSTRAINT deals_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE CASCADE;

ALTER TABLE deals ADD CONSTRAINT deals_pipeline_id_fkey FOREIGN KEY (account_id, pipeline_id) REFERENCES pipelines (account_id, id) ON DELETE CASCADE;

ALTER TABLE deals ADD CONSTRAINT deals_stage_id_fkey FOREIGN KEY (account_id, stage_id) REFERENCES pipeline_stages (account_id, id) ON DELETE NO ACTION;

ALTER TABLE deals ADD CONSTRAINT deals_contact_id_fkey FOREIGN KEY (account_id, contact_id) REFERENCES contacts (account_id, id) ON DELETE SET NULL (contact_id);

ALTER TABLE deals ADD CONSTRAINT deals_conversation_id_fkey FOREIGN KEY (account_id, conversation_id) REFERENCES conversations (account_id, id) ON DELETE NO ACTION;

ALTER TABLE deals ADD CONSTRAINT deals_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES profiles (id) ON DELETE SET NULL;

ALTER TABLE deals ADD CONSTRAINT deals_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE CASCADE;

ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE broadcast_recipients ADD CONSTRAINT broadcast_recipients_broadcast_id_fkey FOREIGN KEY (account_id, broadcast_id) REFERENCES broadcasts (account_id, id) ON DELETE CASCADE;

ALTER TABLE broadcast_recipients ADD CONSTRAINT broadcast_recipients_contact_id_fkey FOREIGN KEY (account_id, contact_id) REFERENCES contacts (account_id, id) ON DELETE SET NULL (contact_id);

ALTER TABLE broadcast_recipients ADD CONSTRAINT broadcast_recipients_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE automations ADD CONSTRAINT automations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE CASCADE;

ALTER TABLE automations ADD CONSTRAINT automations_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE automation_steps ADD CONSTRAINT automation_steps_automation_id_fkey FOREIGN KEY (account_id, automation_id) REFERENCES automations (account_id, id) ON DELETE CASCADE;

ALTER TABLE automation_steps ADD CONSTRAINT automation_steps_parent_step_id_fkey FOREIGN KEY (account_id, parent_step_id) REFERENCES automation_steps (account_id, id) ON DELETE CASCADE;

ALTER TABLE automation_steps ADD CONSTRAINT automation_steps_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE automation_logs ADD CONSTRAINT automation_logs_automation_id_fkey FOREIGN KEY (account_id, automation_id) REFERENCES automations (account_id, id) ON DELETE CASCADE;

ALTER TABLE automation_logs ADD CONSTRAINT automation_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE CASCADE;

ALTER TABLE automation_logs ADD CONSTRAINT automation_logs_contact_id_fkey FOREIGN KEY (account_id, contact_id) REFERENCES contacts (account_id, id) ON DELETE SET NULL (contact_id);

ALTER TABLE automation_logs ADD CONSTRAINT automation_logs_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE automation_pending_executions ADD CONSTRAINT automation_pending_executions_automation_id_fkey FOREIGN KEY (account_id, automation_id) REFERENCES automations (account_id, id) ON DELETE CASCADE;

ALTER TABLE automation_pending_executions ADD CONSTRAINT automation_pending_executions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE CASCADE;

ALTER TABLE automation_pending_executions ADD CONSTRAINT automation_pending_executions_contact_id_fkey FOREIGN KEY (account_id, contact_id) REFERENCES contacts (account_id, id) ON DELETE SET NULL (contact_id);

ALTER TABLE automation_pending_executions ADD CONSTRAINT automation_pending_executions_log_id_fkey FOREIGN KEY (account_id, log_id) REFERENCES automation_logs (account_id, id) ON DELETE CASCADE;

ALTER TABLE automation_pending_executions ADD CONSTRAINT automation_pending_executions_parent_step_id_fkey FOREIGN KEY (account_id, parent_step_id) REFERENCES automation_steps (account_id, id) ON DELETE SET NULL (parent_step_id);

ALTER TABLE automation_pending_executions ADD CONSTRAINT automation_pending_executions_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE message_reactions ADD CONSTRAINT message_reactions_message_id_fkey FOREIGN KEY (account_id, message_id) REFERENCES messages (account_id, id) ON DELETE CASCADE;

ALTER TABLE message_reactions ADD CONSTRAINT message_reactions_conversation_id_fkey FOREIGN KEY (account_id, conversation_id) REFERENCES conversations (account_id, id) ON DELETE CASCADE;

ALTER TABLE message_reactions ADD CONSTRAINT message_reactions_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE flows ADD CONSTRAINT flows_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE CASCADE;

ALTER TABLE flows ADD CONSTRAINT flows_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE flow_nodes ADD CONSTRAINT flow_nodes_flow_id_fkey FOREIGN KEY (account_id, flow_id) REFERENCES flows (account_id, id) ON DELETE CASCADE;

ALTER TABLE flow_nodes ADD CONSTRAINT flow_nodes_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_flow_id_fkey FOREIGN KEY (account_id, flow_id) REFERENCES flows (account_id, id) ON DELETE CASCADE;

ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE CASCADE;

ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_contact_id_fkey FOREIGN KEY (account_id, contact_id) REFERENCES contacts (account_id, id) ON DELETE SET NULL (contact_id);

ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_conversation_id_fkey FOREIGN KEY (account_id, conversation_id) REFERENCES conversations (account_id, id) ON DELETE SET NULL (conversation_id);

ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_last_prompt_message_id_fkey FOREIGN KEY (account_id, last_prompt_message_id) REFERENCES messages (account_id, id) ON DELETE SET NULL (last_prompt_message_id);

ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE flow_run_events ADD CONSTRAINT flow_run_events_flow_run_id_fkey FOREIGN KEY (account_id, flow_run_id) REFERENCES flow_runs (account_id, id) ON DELETE CASCADE;

ALTER TABLE flow_run_events ADD CONSTRAINT flow_run_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE accounts ADD CONSTRAINT accounts_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES auth_users (id) ON DELETE RESTRICT;

ALTER TABLE account_invitations ADD CONSTRAINT account_invitations_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE account_invitations ADD CONSTRAINT account_invitations_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES auth_users (id) ON DELETE SET NULL;

ALTER TABLE account_invitations ADD CONSTRAINT account_invitations_accepted_by_user_id_fkey FOREIGN KEY (accepted_by_user_id) REFERENCES auth_users (id) ON DELETE SET NULL;

ALTER TABLE member_presence ADD CONSTRAINT member_presence_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE CASCADE;

ALTER TABLE member_presence ADD CONSTRAINT member_presence_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE api_keys ADD CONSTRAINT api_keys_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE api_keys ADD CONSTRAINT api_keys_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth_users (id) ON DELETE SET NULL;

ALTER TABLE notifications ADD CONSTRAINT notifications_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE notifications ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE CASCADE;

ALTER TABLE notifications ADD CONSTRAINT notifications_conversation_id_fkey FOREIGN KEY (account_id, conversation_id) REFERENCES conversations (account_id, id) ON DELETE CASCADE;

ALTER TABLE notifications ADD CONSTRAINT notifications_contact_id_fkey FOREIGN KEY (account_id, contact_id) REFERENCES contacts (account_id, id) ON DELETE SET NULL (contact_id);

ALTER TABLE notifications ADD CONSTRAINT notifications_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES auth_users (id) ON DELETE SET NULL;

ALTER TABLE webhook_endpoints ADD CONSTRAINT webhook_endpoints_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE webhook_endpoints ADD CONSTRAINT webhook_endpoints_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth_users (id) ON DELETE SET NULL;

ALTER TABLE ai_configs ADD CONSTRAINT ai_configs_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE ai_configs ADD CONSTRAINT ai_configs_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth_users (id) ON DELETE SET NULL;

ALTER TABLE ai_configs ADD CONSTRAINT ai_configs_handoff_agent_id_fkey FOREIGN KEY (handoff_agent_id) REFERENCES auth_users (id) ON DELETE SET NULL;

ALTER TABLE ai_knowledge_documents ADD CONSTRAINT ai_knowledge_documents_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE ai_knowledge_documents ADD CONSTRAINT ai_knowledge_documents_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth_users (id) ON DELETE SET NULL;

ALTER TABLE ai_knowledge_chunks ADD CONSTRAINT ai_knowledge_chunks_document_id_fkey FOREIGN KEY (account_id, document_id) REFERENCES ai_knowledge_documents (account_id, id) ON DELETE CASCADE;

ALTER TABLE ai_knowledge_chunks ADD CONSTRAINT ai_knowledge_chunks_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE ai_usage_log ADD CONSTRAINT ai_usage_log_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE ai_usage_log ADD CONSTRAINT ai_usage_log_conversation_id_fkey FOREIGN KEY (account_id, conversation_id) REFERENCES conversations (account_id, id) ON DELETE SET NULL (conversation_id);

ALTER TABLE quick_replies ADD CONSTRAINT quick_replies_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE quick_replies ADD CONSTRAINT quick_replies_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE CASCADE;

ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE CASCADE;

ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE auth_refresh_tokens ADD CONSTRAINT auth_refresh_tokens_session_id_fkey FOREIGN KEY (session_id) REFERENCES auth_sessions (id) ON DELETE CASCADE;

ALTER TABLE auth_refresh_tokens ADD CONSTRAINT auth_refresh_tokens_replacement_id_fkey FOREIGN KEY (replacement_id) REFERENCES auth_refresh_tokens (id) ON DELETE SET NULL;

ALTER TABLE auth_verifications ADD CONSTRAINT auth_verifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE CASCADE;

ALTER TABLE account_memberships ADD CONSTRAINT account_memberships_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE account_memberships ADD CONSTRAINT account_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE CASCADE;

ALTER TABLE auth_mfa_factors ADD CONSTRAINT auth_mfa_factors_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE CASCADE;

ALTER TABLE jobs ADD CONSTRAINT jobs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_recipient_user_id_fkey FOREIGN KEY (recipient_user_id) REFERENCES auth_users (id) ON DELETE CASCADE;

ALTER TABLE outbound_intents ADD CONSTRAINT outbound_intents_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE outbound_intents ADD CONSTRAINT outbound_intents_conversation_id_fkey FOREIGN KEY (account_id, conversation_id) REFERENCES conversations (account_id, id) ON DELETE SET NULL (conversation_id);

ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE SET NULL;

ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_users (id) ON DELETE SET NULL;

ALTER TABLE media_objects ADD CONSTRAINT media_objects_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

ALTER TABLE media_objects ADD CONSTRAINT media_objects_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES auth_users (id) ON DELETE SET NULL;

ALTER TABLE media_objects ADD CONSTRAINT media_objects_conversation_id_fkey FOREIGN KEY (account_id, conversation_id) REFERENCES conversations (account_id, id) ON DELETE SET NULL (conversation_id);

ALTER TABLE conversations ADD CONSTRAINT conversations_assigned_agent_id_membership_fkey FOREIGN KEY (account_id, assigned_agent_id) REFERENCES account_memberships (account_id, user_id) ON DELETE SET NULL (assigned_agent_id);

ALTER TABLE ai_configs ADD CONSTRAINT ai_configs_handoff_agent_id_membership_fkey FOREIGN KEY (account_id, handoff_agent_id) REFERENCES account_memberships (account_id, user_id) ON DELETE SET NULL (handoff_agent_id);

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


CREATE OR REPLACE FUNCTION public._bcast_bump(bid UUID, col TEXT, delta INT)
RETURNS VOID AS $$
BEGIN
  IF col NOT IN ('sent_count','delivered_count','read_count','replied_count','failed_count') THEN RAISE EXCEPTION 'Invalid broadcast counter'; END IF;
  EXECUTE format(
    'UPDATE broadcasts SET %I = GREATEST(0, %I + $1), updated_at = NOW() WHERE id = $2',
    col, col
  ) USING delta, bid;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER SET search_path = public;

CREATE OR REPLACE FUNCTION public._bcast_cols_for_status(s TEXT)
RETURNS TEXT[] AS $$
BEGIN
  
  IF s = 'pending' THEN RETURN ARRAY[]::TEXT[]; END IF;
  IF s = 'sent'      THEN RETURN ARRAY['sent_count']; END IF;
  IF s = 'delivered' THEN RETURN ARRAY['sent_count','delivered_count']; END IF;
  IF s = 'read'      THEN RETURN ARRAY['sent_count','delivered_count','read_count']; END IF;
  IF s = 'replied'   THEN RETURN ARRAY['sent_count','delivered_count','read_count','replied_count']; END IF;
  IF s = 'failed'    THEN RETURN ARRAY['failed_count']; END IF;
  RETURN ARRAY[]::TEXT[];
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.broadcast_recipient_aggregate_trigger()
RETURNS TRIGGER AS $$
DECLARE
  old_cols TEXT[];
  new_cols TEXT[];
  c TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    new_cols := _bcast_cols_for_status(NEW.status);
    FOREACH c IN ARRAY new_cols LOOP
      PERFORM _bcast_bump(NEW.broadcast_id, c, 1);
    END LOOP;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    old_cols := _bcast_cols_for_status(OLD.status);
    FOREACH c IN ARRAY old_cols LOOP
      PERFORM _bcast_bump(OLD.broadcast_id, c, -1);
    END LOOP;
    RETURN OLD;
  END IF;

  
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    old_cols := _bcast_cols_for_status(OLD.status);
    new_cols := _bcast_cols_for_status(NEW.status);
    
    FOREACH c IN ARRAY old_cols LOOP
      PERFORM _bcast_bump(NEW.broadcast_id, c, -1);
    END LOOP;
    FOREACH c IN ARRAY new_cols LOOP
      PERFORM _bcast_bump(NEW.broadcast_id, c, 1);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER SET search_path = public;

CREATE OR REPLACE FUNCTION public.recompute_broadcast_counts(bid UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE broadcasts b SET
    sent_count      = agg.sent_count,
    delivered_count = agg.delivered_count,
    read_count      = agg.read_count,
    replied_count   = agg.replied_count,
    failed_count    = agg.failed_count,
    updated_at      = NOW()
  FROM (
    SELECT
      COUNT(*) FILTER (WHERE status IN ('sent','delivered','read','replied')) AS sent_count,
      COUNT(*) FILTER (WHERE status IN ('delivered','read','replied'))        AS delivered_count,
      COUNT(*) FILTER (WHERE status IN ('read','replied'))                    AS read_count,
      COUNT(*) FILTER (WHERE status = 'replied')                              AS replied_count,
      COUNT(*) FILTER (WHERE status = 'failed')                               AS failed_count
    FROM broadcast_recipients
    WHERE broadcast_id = bid
  ) agg
  WHERE b.id = bid;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER SET search_path = public;

CREATE OR REPLACE FUNCTION public.filter_contacts_by_tags(
  p_tag_ids UUID[],
  p_search TEXT DEFAULT NULL,
  p_limit INT DEFAULT 25,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (contact contacts, total_count BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH matched AS (
    
    
    SELECT DISTINCT c.id, c.created_at
    FROM contacts c
    JOIN contact_tags ct ON ct.contact_id = c.id
    WHERE ct.tag_id = ANY(p_tag_ids)
      AND (
        p_search IS NULL
        OR c.name ILIKE '%' || p_search || '%'
        OR c.phone ILIKE '%' || p_search || '%'
        OR c.email ILIKE '%' || p_search || '%'
      )
  ),
  page AS (
    
    
    SELECT id, count(*) OVER() AS total_count
    FROM matched
    ORDER BY created_at DESC, id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT c AS contact, page.total_count
  FROM page
  JOIN contacts c ON c.id = page.id
  ORDER BY c.created_at DESC, c.id;
$$;

CREATE TRIGGER broadcast_recipient_aggregate AFTER INSERT OR UPDATE OR DELETE ON broadcast_recipients FOR EACH ROW EXECUTE FUNCTION broadcast_recipient_aggregate_trigger();

REVOKE ALL ON FUNCTION _bcast_bump(uuid,text,integer),_bcast_cols_for_status(text),broadcast_recipient_aggregate_trigger(),recompute_broadcast_counts(uuid),filter_contacts_by_tags(uuid[],text,integer,integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION _bcast_bump(uuid,text,integer),_bcast_cols_for_status(text),broadcast_recipient_aggregate_trigger(),recompute_broadcast_counts(uuid),filter_contacts_by_tags(uuid[],text,integer,integer) TO bodhinox_app,bodhinox_worker;
