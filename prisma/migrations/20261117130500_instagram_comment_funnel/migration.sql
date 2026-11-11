-- Instagram Phase 2 (Stage 3): the per-post and per-flow funnel of a comment
-- (Instagram › Insights).
--
-- Each instagram_comment_events row is one comment (the top of the funnel).
-- Its later steps already have columns: the private reply (private_reply_status,
-- private_reply_at) and the "Opening DM" tap (opted_in_at). This adds the
-- rest, each the first time it happened in the run the comment started
-- (flow_run_id), set once and never cleared:
--   link_clicked_at   a tracked link in that run was opened
--   lead_captured_at  the run collected an email or phone number
--   followed_at       the follow gate saw the person follow the account
-- The worker sets them inside withTenant (src/lib/instagram/comment-funnel.ts);
-- grants are table-level (app SELECT, worker SELECT/INSERT/UPDATE), so the new
-- columns need none, and RLS is unchanged. The lookups by run and by date use
-- the indexes built CONCURRENTLY by 20261117130600 and 20261117130700.
-- Additive: nullable columns.
SET LOCAL lock_timeout = '5s';

ALTER TABLE instagram_comment_events ADD COLUMN link_clicked_at timestamptz;
ALTER TABLE instagram_comment_events ADD COLUMN lead_captured_at timestamptz;
ALTER TABLE instagram_comment_events ADD COLUMN followed_at timestamptz;
