-- Standardisation batch 5: worker lanes. lane_key groups jobs that must run one at a time and in
-- order (one conversation's inbound.actions, one chat's WhatsApp webhook deliveries). The worker's
-- claim skips a job whose key already has a running job or an older due job, and the run holds a
-- transaction-level advisory lock on the key (src/lib/jobs/queue.ts). Null for every other job.
-- A nullable column without a default is a catalog-only change: no table rewrite.
SET LOCAL lock_timeout = '5s';

ALTER TABLE jobs ADD COLUMN lane_key text;
