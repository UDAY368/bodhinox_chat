-- Phase 6 review fixes. Additive only.
--
-- 1. Contact provenance. commerce_events.created_contact_id names the contact a
--    store event created (resolveContact in lib/commerce/event-rules), so a
--    Shopify GDPR redaction can erase the contacts the integration itself made
--    from store data. It is kept when the event's contact_id is cleared.
ALTER TABLE commerce_events ADD COLUMN created_contact_id uuid;
ALTER TABLE commerce_events ADD CONSTRAINT commerce_events_created_contact_fkey
  FOREIGN KEY (account_id, created_contact_id) REFERENCES contacts(account_id, id) ON DELETE SET NULL (created_contact_id);
CREATE INDEX commerce_events_created_contact_idx ON commerce_events(account_id, created_contact_id)
  WHERE created_contact_id IS NOT NULL;
-- Redaction checks whether a contact is still referenced by another event; this
-- also serves the contact_id foreign key when a contact is deleted.
CREATE INDEX commerce_events_contact_idx ON commerce_events(account_id, contact_id)
  WHERE contact_id IS NOT NULL;

-- 2. One shopify_stores row per (workspace, shop) instead of one per workspace.
--    Connecting a different shop keeps the old shop's row (uninstalled, token
--    cleared) so Shopify's later customers/redact and shop/redact for it still
--    find this workspace. At most one installed row per workspace, and a shop
--    stays installed in at most one workspace (shopify_stores_active_domain_key).
ALTER TABLE shopify_stores DROP CONSTRAINT shopify_stores_account_id_key;
ALTER TABLE shopify_stores ADD CONSTRAINT shopify_stores_account_shop_key UNIQUE (account_id, shop_domain);
CREATE UNIQUE INDEX shopify_stores_active_account_key ON shopify_stores(account_id) WHERE uninstalled_at IS NULL;
