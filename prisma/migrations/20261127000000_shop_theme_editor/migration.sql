SET LOCAL lock_timeout = '5s';

-- Store plan Phase 2: the theme editor (sections and blocks), menus, footer,
-- store pages, draft and publish, and version history. Additive.
-- shop_storefronts.document: the published content (sections with their
-- blocks, menu, footer, pages and policy notes), validated by the server to a
-- fixed shape; our own React components render it, never customer code.
-- shop_storefronts.draft: the editor's unpublished work (template, brand
-- settings and content together); null means no unpublished changes.
-- Publishing copies the draft into template, theme and document in one
-- transaction and keeps a copy in shop_theme_versions, so an older version
-- can be brought back into the draft.

ALTER TABLE shop_storefronts
  ADD COLUMN document jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(document) = 'object' AND octet_length(document::text) <= 131072),
  ADD COLUMN draft jsonb
    CHECK (draft IS NULL OR (jsonb_typeof(draft) = 'object' AND octet_length(draft::text) <= 131072)),
  ADD COLUMN draft_version integer NOT NULL DEFAULT 0 CHECK (draft_version >= 0),
  ADD COLUMN published_at timestamptz;

-- The app role already reads the table; admins may now write the new columns too.
GRANT UPDATE (document, draft, draft_version, published_at) ON shop_storefronts TO bodhinox_app;

CREATE TABLE shop_theme_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES shop_storefronts(account_id) ON DELETE CASCADE,
  number integer NOT NULL CHECK (number > 0),
  template text NOT NULL CHECK (template IN ('wellness','fashion','beauty','food','grocery','electronics')),
  theme jsonb NOT NULL CHECK (jsonb_typeof(theme) = 'object' AND pg_column_size(theme) <= 8192),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object' AND octet_length(document::text) <= 131072),
  published_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, number)
);

ALTER TABLE shop_theme_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_theme_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON shop_theme_versions FOR SELECT TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY tenant_write ON shop_theme_versions FOR ALL TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
GRANT SELECT, INSERT, DELETE ON shop_theme_versions TO bodhinox_app;
