-- Stage 5 (5D): keep a timed pause honest whichever path writes bot_paused.
--
-- Stage 5 added conversations.bot_paused_until and bot_paused_by (5A). Only
-- the 5D pause paths (src/lib/inbox/automation-pause.ts) know those columns;
-- older writers (AI handoff, catalogue, forms, storefront, payment links, the
-- flow engine, the browser's resume button) set or clear bot_paused alone.
-- Without this trigger such a write could leave a stale time behind: a pause
-- set by an older writer would inherit an expired bot_paused_until and read
-- as "not paused" at once, and a resume would leave the time on the row.
--
-- So, whenever an UPDATE names bot_paused:
--   * bot_paused = false clears bot_paused_until and bot_paused_by;
--   * bot_paused = true means "until resumed" (bot_paused_until NULL), the
--     behaviour before Stage 5, unless the writer is a 5D pause path, which
--     marks its transaction with app.pause_explicit = 'on' and keeps the
--     until and author it set.
-- Fires only for UPDATEs that list bot_paused, never for other conversation writes.
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION conversations_pause_reset() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.bot_paused IS NOT TRUE THEN
    NEW.bot_paused_until := NULL;
    NEW.bot_paused_by := NULL;
  ELSIF COALESCE(current_setting('app.pause_explicit', true), '') <> 'on' THEN
    NEW.bot_paused_until := NULL;
  END IF;
  RETURN NEW;
END $$;

-- additive-exception: CREATE TRIGGER takes a brief SHARE ROW EXCLUSIVE lock on conversations, bounded by the 5 s lock_timeout; no rewrite or scan.
CREATE TRIGGER conversations_pause_reset BEFORE UPDATE OF bot_paused ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_pause_reset();
