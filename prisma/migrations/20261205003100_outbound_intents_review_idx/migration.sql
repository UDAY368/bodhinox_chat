-- Standardisation batch 5, item 6: one workspace's uncertain sends, newest first, for the
-- "needs review" list (src/lib/needs-review/review.ts). outbound_intents is never pruned; the
-- partial index holds only the few rows that are 'unknown' or still 'dispatching'.
--
-- A single statement on purpose: CREATE INDEX CONCURRENTLY cannot run inside a transaction
-- block. If a deploy is interrupted mid-build, drop the INVALID index (DROP INDEX CONCURRENTLY
-- outbound_intents_review_idx), mark the migration rolled back
-- (prisma migrate resolve --rolled-back 20261205003100_outbound_intents_review_idx) and re-run.
CREATE INDEX CONCURRENTLY outbound_intents_review_idx
  ON outbound_intents (account_id, created_at DESC) WHERE status IN ('unknown', 'dispatching');
