-- Phase 3: template studio. Carousel, authentication and limited-time-offer
-- template kinds, a location header, and a per-template status history. All additive.

ALTER TABLE message_templates ADD COLUMN template_kind TEXT NOT NULL DEFAULT 'standard'
  CONSTRAINT message_templates_template_kind_check
  CHECK (template_kind IN ('standard', 'carousel', 'authentication', 'limited_time_offer'));
-- Carousel cards (2-10, validated per card in lib/whatsapp/template-validators).
ALTER TABLE message_templates ADD COLUMN cards JSONB
  CONSTRAINT message_templates_cards_check
  CHECK (cards IS NULL OR (jsonb_typeof(cards) = 'array' AND jsonb_array_length(cards) <= 10));
ALTER TABLE message_templates ADD COLUMN auth_options JSONB
  CONSTRAINT message_templates_auth_options_check
  CHECK (auth_options IS NULL OR jsonb_typeof(auth_options) = 'object');
ALTER TABLE message_templates ADD COLUMN lto JSONB
  CONSTRAINT message_templates_lto_check
  CHECK (lto IS NULL OR jsonb_typeof(lto) = 'object');

-- A location header carries no text or media; its coordinates are supplied per send.
ALTER TABLE message_templates DROP CONSTRAINT IF EXISTS message_templates_header_type_check;
ALTER TABLE message_templates ADD CONSTRAINT message_templates_header_type_check
  CHECK (header_type IN ('text', 'image', 'video', 'document', 'location'));

-- Append-only history of every status a template has held, with its source.
CREATE TABLE template_status_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  template_id uuid NOT NULL,
  status text NOT NULL,
  reason text,
  quality_score text,
  source text NOT NULL CHECK (source IN ('draft', 'submit', 'webhook', 'sync', 'edit')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, template_id) REFERENCES message_templates(account_id, id) ON DELETE CASCADE
);
CREATE INDEX template_status_events_history_idx ON template_status_events(account_id, template_id, created_at);
ALTER TABLE template_status_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE template_status_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON template_status_events FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
-- Rows are written alongside a template change, which already needs admin (or the worker).
CREATE POLICY tenant_insert ON template_status_events FOR INSERT TO bodhinox_app,bodhinox_worker
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
GRANT SELECT,INSERT ON template_status_events TO bodhinox_app,bodhinox_worker;
