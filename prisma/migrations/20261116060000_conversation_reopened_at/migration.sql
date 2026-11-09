SET LOCAL lock_timeout = '5s';

-- Resolution time for reopened conversations: when a resolved conversation
-- re-opens, the lifecycle trigger now stamps reopened_at (the start of the new
-- cycle) where it already bumps reopened_count, so analytics can time every
-- resolution as resolved_at - coalesce(reopened_at, created_at).
-- Additive: a nullable column without a default is a catalog-only change, and
-- conversations reopened before this migration keep reopened_at NULL (they
-- stay counted but untimed, as before).
ALTER TABLE conversations ADD COLUMN reopened_at timestamptz;

-- sync_conversation_lifecycle as in 20261102121000_sla_clock_on_customer_message,
-- with one added line in the reopen branch.
CREATE OR REPLACE FUNCTION sync_conversation_lifecycle() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE was_resolved boolean := TG_OP = 'UPDATE' AND OLD.lifecycle_state = 'resolved';
  sla integer;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state THEN
    IF NEW.lifecycle_state = 'resolved' THEN NEW.status := 'closed';
    ELSIF NEW.status = 'closed' THEN NEW.status := 'open'; END IF;
  ELSIF TG_OP = 'INSERT' AND NEW.lifecycle_state = 'resolved' THEN
    NEW.status := 'closed';
  END IF;

  IF NEW.status = 'closed' THEN
    NEW.lifecycle_state := 'resolved';
    IF NOT was_resolved THEN NEW.resolved_at := now(); END IF;
    RETURN NEW;
  END IF;

  IF was_resolved THEN
    NEW.reopened_count := OLD.reopened_count + 1;
    NEW.reopened_at := now();
    NEW.resolved_at := NULL;
    NEW.first_responded_at := NULL;
    NEW.first_response_due_at := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    NEW.resolved_at := NULL;
  END IF;

  IF NEW.assigned_agent_id IS NOT NULL THEN NEW.lifecycle_state := 'assigned';
  ELSIF NEW.lifecycle_state IN ('assigned', 'resolved') THEN NEW.lifecycle_state := 'requesting';
  ELSIF NEW.lifecycle_state = 'bot' AND NEW.bot_paused THEN NEW.lifecycle_state := 'requesting';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.lifecycle_state <> 'bot' AND NEW.first_responded_at IS NULL AND NEW.first_response_due_at IS NULL THEN
    SELECT s.sla_first_response_minutes INTO sla FROM workspace_inbox_settings s WHERE s.account_id = NEW.account_id;
    IF sla IS NOT NULL THEN NEW.first_response_due_at := now() + make_interval(mins => sla); END IF;
  END IF;
  RETURN NEW;
END $$;
