-- A WhatsApp number holds at most one linked catalogue.
--
-- connectCatalog() checked this with SELECT-then-INSERT, so two concurrent
-- connects of different catalogues to one number could both commit. The inbox
-- picker then listed products from both while catalogue sends used only the
-- newest, so picking a product from the older one failed. The rule is now a
-- partial unique index; connectCatalog() maps its violation to
-- 'number_has_catalog'. Unlinked catalogues (whatsapp_config_id NULL, e.g.
-- after the number was deleted) are not counted.
--
-- Rows that already break the rule keep the catalogue the send path already
-- used (newest created_at, then id) linked; the older ones are unlinked, not
-- deleted, so their products and history stay and an admin can relink them to
-- another number.
UPDATE whatsapp_catalogs c SET whatsapp_config_id = NULL
  WHERE c.whatsapp_config_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM whatsapp_catalogs n
      WHERE n.account_id = c.account_id AND n.whatsapp_config_id = c.whatsapp_config_id
        AND (n.created_at, n.id) > (c.created_at, c.id));

CREATE UNIQUE INDEX whatsapp_catalogs_one_per_number ON whatsapp_catalogs (account_id, whatsapp_config_id)
  WHERE whatsapp_config_id IS NOT NULL;
