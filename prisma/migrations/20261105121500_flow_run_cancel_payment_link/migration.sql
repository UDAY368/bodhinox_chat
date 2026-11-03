-- A flow run waiting on a payment link can end without the payment: the
-- sweep or an inline check times it out, an agent takes over, the contact
-- sends STOP, the flow is deactivated. The link stayed payable at Razorpay
-- until it expired. This trigger queues a 'payments.cancel_link' job for the
-- link the run was waiting on, in the same transaction as the update that
-- ended the run, whichever code path ran it (engine, sweep, takeover, STOP).
--
-- Only an unpaid 'created' link on the node the run stood on qualifies. A
-- paid, partially paid, expired or unsettled ('creating'/'unknown') link is
-- left alone; the job re-reads the link at Razorpay before cancelling and
-- never cancels one that turns out paid. The dedupe key makes a replayed
-- ending queue nothing new. Ids only in the payload, no customer content.
--
-- SECURITY INVOKER: the role that ended the run is already scoped to its
-- tenant (flow_runs RLS), so it reads that tenant's payment_links and inserts
-- a job for that tenant only (jobs RLS for the app role).
CREATE FUNCTION queue_flow_payment_link_cancel() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
  INSERT INTO jobs(type, tenant_id, payload, dedupe_key)
  SELECT 'payments.cancel_link', l.account_id, jsonb_build_object('linkId', l.id::text),
         'payment-link-cancel:' || l.id::text
  FROM payment_links l
  WHERE l.account_id = NEW.account_id
    AND l.flow_run_id = NEW.id
    AND l.node_key = OLD.current_node_key
    AND l.status = 'created'
  ON CONFLICT (dedupe_key) DO NOTHING;
  RETURN NULL;
END $$;

CREATE TRIGGER flow_runs_cancel_payment_link AFTER UPDATE OF status ON flow_runs
  FOR EACH ROW
  WHEN (OLD.status = 'active' AND NEW.status <> 'active' AND OLD.current_node_key IS NOT NULL)
  EXECUTE FUNCTION queue_flow_payment_link_cancel();
