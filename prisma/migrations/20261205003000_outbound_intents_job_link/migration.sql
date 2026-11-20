-- Standardisation batch 5, item 6: the "needs review" list for uncertain sends.
-- dispatchOnce records the job that claimed a send, so an admin's "send again" can queue that
-- job once more after the uncertain intent is retired. Nullable, no default and no foreign key
-- (jobs are pruned): a catalogue-only change that takes a brief lock bounded by lock_timeout.
SET LOCAL lock_timeout = '5s';

ALTER TABLE outbound_intents ADD COLUMN job_id uuid;
