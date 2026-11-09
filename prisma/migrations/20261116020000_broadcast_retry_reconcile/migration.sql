-- Campaign retry and reconciliation (audit 2026-11-10, findings 11 and 12).
--
-- broadcast_recipients.retry_generation: bumped once per "Retry failed" request
-- for a row Meta accepted and a status webhook later failed. A non-zero value is
-- part of the row's outbound-intent key (broadcastIntentKey), so the retry is a
-- real new send instead of a replay of the old accepted intent.
--
-- broadcast_recipients.outcome_uncertain_at: set when a send's outcome is
-- unknown (timeout, network error, 5xx). Such a row is left out of "Retry
-- failed" until staff reconcile it as sent or not sent on the campaign page
-- (POST /api/whatsapp/broadcast/[id]/reconcile, audited). Never cleared
-- automatically. Rows marked uncertain before this column existed are
-- recognised by their error text and flagged by the next resume.
--
-- broadcasts.retry_request_id: the last "Retry failed" request a worker pass
-- applied, so a requeued or retried pass of the same request never bumps the
-- generation (and so never resends) twice.
--
-- Additive: nullable or constant-default columns are catalogue-only changes
-- (no table rewrite); lock_timeout bounds the brief ACCESS EXCLUSIVE lock.
SET LOCAL lock_timeout = '5s';

ALTER TABLE broadcast_recipients ADD COLUMN retry_generation integer NOT NULL DEFAULT 0;
ALTER TABLE broadcast_recipients ADD COLUMN outcome_uncertain_at timestamptz;
ALTER TABLE broadcasts ADD COLUMN retry_request_id uuid;
