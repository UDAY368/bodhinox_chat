-- A contact who is blocked or opts out (STOP, or an agent) gets nothing more
-- from an automation run parked at a wait or a wait-for-reply step: the parked
-- rows expire, and their run log records why, in the statement that sets the
-- flag, whichever path set it (audit
-- finding 49). Running rows are left alone; the resume re-checks the contact.
-- Runs as the updating role under tenant RLS (contacts and
-- automation_pending_executions share the agent write minimum).
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION expire_automation_waits_on_consent() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  -- The run log keeps its status and says why the run stopped (same English
  -- text as LibErrors.engine.contactBlockedWhileWaiting / contactOptedOutWhileWaiting).
  WITH expired AS (
    UPDATE automation_pending_executions SET status='expired'
      WHERE account_id=NEW.account_id AND contact_id=NEW.id AND status IN ('pending','awaiting_reply')
      RETURNING log_id)
  UPDATE automation_logs l SET error_message = CASE WHEN NEW.blocked_at IS NOT NULL
      THEN 'The contact was blocked while this run was waiting, so nothing more was sent'
      ELSE 'The contact opted out (STOP) while this run was waiting, so nothing more was sent' END
    FROM expired e WHERE l.account_id=NEW.account_id AND l.id=e.log_id;
  RETURN NEW;
END $$;

-- additive-exception: CREATE TRIGGER takes a brief SHARE ROW EXCLUSIVE lock on contacts, bounded by the 5 s lock_timeout; no rewrite or scan.
CREATE TRIGGER contacts_expire_automation_waits AFTER UPDATE OF blocked_at, opted_out_at ON contacts
  FOR EACH ROW
  WHEN ((NEW.blocked_at IS NOT NULL AND OLD.blocked_at IS NULL) OR (NEW.opted_out_at IS NOT NULL AND OLD.opted_out_at IS NULL))
  EXECUTE FUNCTION expire_automation_waits_on_consent();
