-- Instagram Phase 1 (Stage 2): a comment can start a flow.
--
-- instagram_comment_events (one row per comment, UNIQUE (instagram_account_id,
-- comment_id)) gains:
--   flow_run_id      the run an ig_comment flow started for the comment (the
--                    legacy rule path leaves it null); set by the worker.
--   public_reply_id  the id of the public reply posted under the comment
--                    (dispatch key ig-comment-reply:{commentId}); never text.
--   opted_in_at      when the commenter tapped the "Opening DM" button.
-- Grants are table-level (app SELECT, worker SELECT/INSERT/UPDATE), so the new
-- columns need none; RLS is unchanged.
--
-- The run link is a composite foreign key in the same workspace. It and the id
-- check are added NOT VALID (every existing row is null) and validated by
-- 20261117070700_instagram_phase1_validate. Additive: nullable columns.
SET LOCAL lock_timeout = '5s';

ALTER TABLE instagram_comment_events ADD COLUMN flow_run_id uuid;
ALTER TABLE instagram_comment_events ADD COLUMN public_reply_id text;
ALTER TABLE instagram_comment_events ADD COLUMN opted_in_at timestamptz;
ALTER TABLE instagram_comment_events ADD CONSTRAINT instagram_comment_events_public_reply_id_check
  CHECK (public_reply_id ~ '^\d{1,32}$') NOT VALID;
ALTER TABLE instagram_comment_events ADD CONSTRAINT instagram_comment_events_flow_run_fkey
  FOREIGN KEY (account_id, flow_run_id) REFERENCES flow_runs(account_id, id) ON DELETE SET NULL (flow_run_id) NOT VALID;
