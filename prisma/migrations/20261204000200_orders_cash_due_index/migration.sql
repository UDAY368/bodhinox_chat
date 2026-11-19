-- The orders list's "Cash due" filter (src/lib/commerce/orders.ts CASH_DUE) reads the workspace's unpaid
-- cash-on-delivery and manual orders newest first, a page at a time. Those are a small part of all orders,
-- so a partial index on exactly that predicate keeps the filter and its count off the full order list.
-- Built CONCURRENTLY so orders stay writable while it builds.
--
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block. If a deploy is interrupted mid-build, PostgreSQL leaves an INVALID index;
-- drop it (DROP INDEX CONCURRENTLY orders_cash_due_idx) and mark the migration rolled back before re-running.
CREATE INDEX CONCURRENTLY orders_cash_due_idx ON orders (account_id, created_at DESC, id DESC)
  WHERE paid_at IS NULL AND refund_state = 'none'
    AND ((payment_method = 'cod' AND status IN ('confirmed', 'dispatched', 'fulfilled'))
      OR (source = 'manual' AND payment_method = 'online' AND status = 'confirmed'));
