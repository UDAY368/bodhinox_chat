-- Phase 9 analytics: when the AI agent last handed a conversation to a person.
-- Additive and nullable (no table rewrite, no backfill). Set together with
-- ai_handoff_summary by the auto-reply handoff and deliberately NOT cleared
-- when AI is resumed, so a past handoff stays in the range it happened in.
-- Handoffs from before this column existed have no time and are not counted.
-- A later handoff on the same conversation overwrites the time.
ALTER TABLE conversations ADD COLUMN ai_handoff_at timestamptz;
