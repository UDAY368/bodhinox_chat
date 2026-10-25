ALTER TABLE accounts ADD COLUMN reply_target_minutes integer NOT NULL DEFAULT 5
  CHECK (reply_target_minutes BETWEEN 1 AND 1440);

-- Both read-only conversation projections and operational queues use these lookups.
CREATE INDEX IF NOT EXISTS messages_successful_reply_idx
  ON messages(account_id, conversation_id, created_at DESC)
  WHERE sender_type IN ('agent','bot') AND status IN ('sent','delivered','read')
    AND content_type NOT IN ('template','system');
