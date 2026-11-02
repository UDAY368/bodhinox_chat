-- One active flow run per conversation, not per contact.
--
-- With several WhatsApp numbers a contact has one conversation per number. The
-- old index (account_id, contact_id) WHERE status='active' let a run waiting on
-- number A's conversation block every flow on number B, and the engine answered
-- that run with B's inbound. The engine now only answers the run on the
-- inbound's own conversation, so the guard against concurrent starts moves to
-- (account_id, contact_id, conversation_id).
--
-- Existing data cannot violate the new index: it is strictly looser than the
-- old one (every active-row tuple was already unique on account_id+contact_id).
-- NULLS NOT DISTINCT keeps legacy rows without a conversation at one active run
-- per contact, exactly as before. Create first, then drop, so the table is never
-- without a guard.
CREATE UNIQUE INDEX idx_one_active_run_per_conversation
  ON flow_runs (account_id, contact_id, conversation_id) NULLS NOT DISTINCT
  WHERE status = 'active';
DROP INDEX idx_one_active_run_per_contact;
