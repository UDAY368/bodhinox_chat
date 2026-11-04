-- Phase 12: prefix lookups of a flow run's outbound intents
-- (idempotency_key LIKE '<account>:<prefix>:<run>:%') for run inspection.
-- The existing UNIQUE(idempotency_key) index uses the default collation and
-- cannot serve LIKE prefixes; text_pattern_ops can.
--
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block. If a deploy is interrupted mid-build,
-- PostgreSQL leaves an INVALID index; drop it (DROP INDEX CONCURRENTLY
-- outbound_intents_key_prefix_idx) and mark the migration rolled back
-- (prisma migrate resolve --rolled-back 20261110100400_outbound_intents_key_prefix_index)
-- before re-running.
CREATE INDEX CONCURRENTLY outbound_intents_key_prefix_idx
  ON outbound_intents (idempotency_key text_pattern_ops);
