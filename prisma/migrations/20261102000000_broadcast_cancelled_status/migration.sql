-- Phase 2a: a scheduled campaign can be cancelled before it starts.
-- Widens the status check only; existing rows are unaffected.
ALTER TABLE broadcasts DROP CONSTRAINT broadcasts_status_check;
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_status_check
  CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed', 'cancelled'));
