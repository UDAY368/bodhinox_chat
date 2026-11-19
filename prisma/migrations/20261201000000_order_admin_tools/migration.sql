SET LOCAL lock_timeout = '5s';

-- Store plan Phase 8, batch 1: order admin tools. Additive.
-- orders.tags: short labels staff put on an order (at most 10, checked in the app too). The app role may
--   change only this column (and the existing status/note); RLS still limits it to the member's own workspace.
--   It is not one of the columns the priced-order freeze trigger guards.
-- storefront_sessions.is_quote / quote_note: a quote is an ordinary shop session that staff pre-filled for one
--   customer. The note is what staff wrote for the customer (it is sent with the link); expiry is expires_at.
-- If it aborts on lock_timeout: prisma migrate resolve --rolled-back 20261201000000_order_admin_tools.

ALTER TABLE orders ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE orders ADD CONSTRAINT orders_tags_check CHECK (cardinality(tags) <= 10) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT orders_tags_check;
GRANT UPDATE (tags) ON orders TO bodhinox_app;

ALTER TABLE storefront_sessions ADD COLUMN is_quote boolean NOT NULL DEFAULT false;
ALTER TABLE storefront_sessions ADD COLUMN quote_note text;
ALTER TABLE storefront_sessions ADD CONSTRAINT storefront_sessions_quote_note_check
  CHECK (quote_note IS NULL OR (is_quote AND char_length(quote_note) <= 900)) NOT VALID;
ALTER TABLE storefront_sessions VALIDATE CONSTRAINT storefront_sessions_quote_note_check;
