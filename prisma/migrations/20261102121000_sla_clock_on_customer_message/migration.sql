-- The first-response SLA clock starts when the customer writes, not when a
-- conversation row is created. Conversations opened by the business (template,
-- commerce, flow or automation sends) have no customer waiting, so creating
-- them must not set first_response_due_at.
--
-- sync_conversation_lifecycle is unchanged except that its final SLA branch now
-- runs on UPDATE only (reopen, unassign, bot pause keep restarting the clock).
-- messages_customer_sla starts it on a customer message instead.

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

-- A customer message starts the clock of an open cycle that is not bot-owned,
-- has no first response yet and no running clock. Once set (or answered) the
-- WHERE clause matches nothing, so later customer messages do not move it.
-- The UPDATE touches only first_response_due_at, which is outside the
-- conversation_lifecycle column list, so that trigger does not fire again.
CREATE FUNCTION start_conversation_first_response_clock() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  UPDATE conversations c SET first_response_due_at = now() + make_interval(mins => s.sla_first_response_minutes)
  FROM workspace_inbox_settings s
  WHERE c.account_id = NEW.account_id AND c.id = NEW.conversation_id
    AND s.account_id = c.account_id AND s.sla_first_response_minutes IS NOT NULL
    AND c.status <> 'closed' AND c.lifecycle_state NOT IN ('bot', 'resolved')
    AND c.first_responded_at IS NULL AND c.first_response_due_at IS NULL;
  RETURN NULL;
END $$;
CREATE TRIGGER messages_customer_sla AFTER INSERT ON messages
  FOR EACH ROW WHEN (NEW.sender_type = 'customer') EXECUTE FUNCTION start_conversation_first_response_clock();
