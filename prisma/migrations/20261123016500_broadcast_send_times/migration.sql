-- Campaigns list: when a campaign actually started sending and when it
-- finished (sent or failed), instead of when its row was created.
--
--   broadcasts.started_at   first move into 'sending' (kept across pause/resume).
--   broadcasts.finished_at  last move into 'sent' or 'failed'; cleared when a
--                           campaign goes back to 'sending' (resume, retry failed).
--
-- Set by a BEFORE trigger, so every status writer (schedule, send now, resume,
-- dispatcher settle, reconcile) records them without code changes. Existing
-- rows are backfilled first from their recipients' send times, falling back to
-- the schedule time / creation time and the last update.
--
-- Additive: two nullable columns covered by the table's existing grants and RLS.
SET LOCAL lock_timeout = '5s';

ALTER TABLE broadcasts
  ADD COLUMN started_at timestamptz,
  ADD COLUMN finished_at timestamptz;

UPDATE broadcasts b SET
  started_at = COALESCE(
    (SELECT min(r.sent_at) FROM broadcast_recipients r WHERE r.account_id = b.account_id AND r.broadcast_id = b.id),
    b.scheduled_at, b.created_at),
  finished_at = CASE WHEN b.status IN ('sent', 'failed') THEN COALESCE(
    (SELECT max(r.sent_at) FROM broadcast_recipients r WHERE r.account_id = b.account_id AND r.broadcast_id = b.id),
    b.updated_at) END
WHERE b.status IN ('sending', 'paused', 'sent', 'failed');

CREATE FUNCTION broadcasts_send_times() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'sending' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'sending') THEN
    NEW.started_at := COALESCE(NEW.started_at, now());
    NEW.finished_at := NULL;
  ELSIF NEW.status IN ('sent', 'failed') AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    NEW.started_at := COALESCE(NEW.started_at, now());
    NEW.finished_at := now();
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER broadcasts_send_times BEFORE INSERT OR UPDATE OF status ON broadcasts -- additive-exception: row trigger; lock_timeout bounds the brief SHARE ROW EXCLUSIVE wait
  FOR EACH ROW EXECUTE FUNCTION broadcasts_send_times();
