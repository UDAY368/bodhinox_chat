SET LOCAL lock_timeout = '5s';

-- Wake open live-update streams (/api/events) when outbox rows commit, instead of every stream
-- polling outbox_events every 2 s. One notification per account per inserting statement; the
-- payload is the account id only (no row content). NOTIFY is delivered at commit, so a rolled-back
-- change never wakes anyone. Streams still read outbox_events by cursor and fall back to polling
-- when the listener (src/lib/realtime/outbox-listener.ts) is down.
CREATE FUNCTION notify_outbox_accounts() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE tenant uuid;
BEGIN
  FOR tenant IN SELECT DISTINCT account_id FROM inserted_outbox LOOP
    PERFORM pg_notify('bodhinox_outbox', tenant::text);
  END LOOP;
  RETURN NULL;
END $$;

CREATE TRIGGER outbox_events_notify AFTER INSERT ON outbox_events
  REFERENCING NEW TABLE AS inserted_outbox
  FOR EACH STATEMENT EXECUTE FUNCTION notify_outbox_accounts(); -- additive-exception: CREATE TRIGGER takes a brief SHARE ROW EXCLUSIVE lock on outbox_events, bounded by the 5 s lock_timeout; no rewrite or scan.

GRANT EXECUTE ON FUNCTION notify_outbox_accounts() TO bodhinox_app,bodhinox_auth,bodhinox_worker;
