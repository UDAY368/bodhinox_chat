SET LOCAL lock_timeout = '5s';

-- Deals remember when they closed and, optionally, why they were lost. Additive.
-- - closed_at: set by the database when a deal becomes won or lost, kept while it stays
--   closed, cleared when it is reopened. Only the trigger below decides it, so the board,
--   automations and any other writer agree.
-- - lost_reason: a short optional note (200 characters) kept only while the deal is lost.
-- Existing closed deals take closed_at from updated_at (or created_at when that is empty):
-- the best record of when they closed. The backfill is one UPDATE of closed deals only; each
-- row also writes its usual deals.UPDATE outbox event.
ALTER TABLE deals ADD COLUMN closed_at timestamptz;
ALTER TABLE deals ADD COLUMN lost_reason text;
ALTER TABLE deals ADD CONSTRAINT deals_lost_reason_length CHECK (lost_reason IS NULL OR char_length(lost_reason) <= 200) NOT VALID;

UPDATE deals SET closed_at = COALESCE(updated_at, created_at, now())
  WHERE status IN ('won','lost') AND closed_at IS NULL;

CREATE FUNCTION deals_closed_state() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF COALESCE(NEW.status,'open') IN ('won','lost') THEN
    IF TG_OP = 'INSERT' OR COALESCE(OLD.status,'open') IS DISTINCT FROM NEW.status THEN
      NEW.closed_at := now();
    ELSE
      NEW.closed_at := COALESCE(OLD.closed_at, now());
    END IF;
  ELSE
    NEW.closed_at := NULL;
  END IF;
  IF COALESCE(NEW.status,'open') = 'lost' THEN
    NEW.lost_reason := NULLIF(btrim(NEW.lost_reason), '');
  ELSE
    NEW.lost_reason := NULL;
  END IF;
  RETURN NEW;
END $$;

-- additive-exception: CREATE TRIGGER takes a brief SHARE ROW EXCLUSIVE lock on deals, bounded by the 5 s lock_timeout; no rewrite or scan.
CREATE TRIGGER deals_closed_state BEFORE INSERT OR UPDATE ON deals FOR EACH ROW EXECUTE FUNCTION deals_closed_state();
