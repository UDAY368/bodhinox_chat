-- Instagram Phase 2 (Stage 3): AI replies to comments, with an approval queue
-- (owner decision 2). Nothing is posted in public until an admin approves the
-- reply, unless an admin has turned on auto-approve.
--
-- ai_configs gains the workspace switches (the AI settings row; a workspace
-- without one has no AI comments). All default off; the cap defaults to 50
-- replies a day (checked NOT VALID, validated by
-- 20261117130800_instagram_phase2_validate):
--   instagram_ai_comments_enabled       classify comments and draft replies
--   instagram_ai_comments_auto_approve  post drafts without an admin's approval
--   instagram_ai_comments_daily_cap     drafts per workspace per day (1-500)
-- ai_configs is browser read-only (src/lib/data/contracts.ts); its grants are
-- table-level and RLS is unchanged (admins write it through server routes).
--
-- instagram_ai_comment_queue: one row per comment the AI drafted a reply for
-- (UNIQUE per comment event, so a comment is never queued twice). No comment
-- text is stored: staff see the comment read live from Meta (graph.ts
-- getComment), which also refuses hidden or deleted comments. reply_text is the
-- AI's draft, which an admin may edit before approving.
--   status   pending -> approved | rejected (an admin), or pending -> approved
--            with auto_approved (the worker, when auto-approve is on);
--            approved -> sent | unknown | failed (the worker, after posting
--            once through dispatchOnce with the key ig-comment-reply:{commentId},
--            shared with the flow comment-reply step so a comment gets at most
--            one public reply); unknown is an ambiguous outcome surfaced for
--            reconciliation, never retried blindly; pending -> expired (the
--            worker, once a draft is too old to post).
-- Members read the queue. Admins decide only pending rows, only as
-- themselves, only to approved or rejected, and may change only the status,
-- the reply text and the decision fields (column grant). The worker writes
-- everything else. decided_by is audit identity (SET NULL when the user is
-- removed). Additive: a new, empty table, so plain indexes are fine.
SET LOCAL lock_timeout = '5s';

ALTER TABLE ai_configs ADD COLUMN instagram_ai_comments_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE ai_configs ADD COLUMN instagram_ai_comments_auto_approve boolean NOT NULL DEFAULT false;
ALTER TABLE ai_configs ADD COLUMN instagram_ai_comments_daily_cap integer NOT NULL DEFAULT 50;
ALTER TABLE ai_configs ADD CONSTRAINT ai_configs_instagram_ai_comments_daily_cap_check
  CHECK (instagram_ai_comments_daily_cap BETWEEN 1 AND 500) NOT VALID;

CREATE TABLE instagram_ai_comment_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  instagram_account_id uuid NOT NULL,
  comment_event_id uuid NOT NULL,
  comment_id text NOT NULL CHECK (comment_id ~ '^\d{1,32}$'),
  media_id text CHECK (media_id ~ '^\d{1,32}$'),
  sentiment text NOT NULL CHECK (sentiment IN ('positive','neutral','negative')),
  intent text CHECK (intent IN ('praise','question','purchase_intent','complaint','spam','other')),
  reply_text text NOT NULL CHECK (char_length(btrim(reply_text)) BETWEEN 1 AND 2200),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','sent','unknown','failed','expired')),
  auto_approved boolean NOT NULL DEFAULT false,
  decided_by uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  public_reply_id text CHECK (public_reply_id ~ '^\d{1,32}$'),
  error_code text CHECK (error_code ~ '^[a-z0-9_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Every decided row records when; a posted reply records its id.
  CHECK (status IN ('pending','expired') OR decided_at IS NOT NULL),
  CHECK (status <> 'sent' OR public_reply_id IS NOT NULL),
  UNIQUE (account_id, id),
  UNIQUE (account_id, comment_event_id),
  FOREIGN KEY (account_id, instagram_account_id) REFERENCES instagram_accounts(account_id, id),
  FOREIGN KEY (account_id, comment_event_id) REFERENCES instagram_comment_events(account_id, id) ON DELETE CASCADE
);
-- The queue page lists by status, newest first.
CREATE INDEX instagram_ai_comment_queue_status_idx ON instagram_ai_comment_queue (account_id, status, created_at DESC);
-- The daily cap counts a workspace's drafts since midnight.
CREATE INDEX instagram_ai_comment_queue_created_idx ON instagram_ai_comment_queue (account_id, created_at);

ALTER TABLE instagram_ai_comment_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE instagram_ai_comment_queue FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON instagram_ai_comment_queue FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY admin_decide ON instagram_ai_comment_queue FOR UPDATE TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin') AND status = 'pending')
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('admin') AND status IN ('approved','rejected')
    AND decided_by = app_user_id() AND decided_at IS NOT NULL AND NOT auto_approved);
CREATE POLICY worker_write ON instagram_ai_comment_queue FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT ON instagram_ai_comment_queue TO bodhinox_app;
GRANT UPDATE (status, reply_text, decided_by, decided_at) ON instagram_ai_comment_queue TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON instagram_ai_comment_queue TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON instagram_ai_comment_queue FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
