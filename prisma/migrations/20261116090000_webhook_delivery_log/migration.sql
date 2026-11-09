-- Outbound webhooks: disable an endpoint only after sustained failure, say why,
-- and keep a short delivery log the workspace admins can read (audit #14/#40).
--
-- Before: every failed attempt (5 per event, all within ~30 s) bumped
-- failure_count and 15 disabled the endpoint, so a one-minute receiver restart
-- switched it off with no notice. Now record_webhook_attempt():
--   * logs each attempt in webhook_deliveries (event, delivery id, attempt,
--     outcome, HTTP status, a short error code; never the payload), keeping the
--     newest 100 rows per endpoint and nothing older than 30 days;
--   * on success clears the streak (failure_count, failing_since);
--   * on failure disables the endpoint only when it has failed at least
--     p_min_failures times in a row AND has been failing for at least
--     p_disable_after_minutes, then stamps disabled_at / disabled_reason and
--     returns true so the caller can notify the admins (in-app, type
--     webhook_disabled).
-- record_webhook_failure(uuid,integer) stays for the release still serving.
--
-- Additive: three nullable columns, a new table, a new function and a superset
-- of the notifications type check (NOT VALID; 20261116090001 validates it).
SET LOCAL lock_timeout = '5s';

ALTER TABLE webhook_endpoints ADD COLUMN failing_since timestamptz;
ALTER TABLE webhook_endpoints ADD COLUMN disabled_at timestamptz;
ALTER TABLE webhook_endpoints ADD COLUMN disabled_reason text;

CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  endpoint_id uuid NOT NULL,
  event text NOT NULL CHECK (char_length(event) <= 64),
  delivery_id text CHECK (char_length(delivery_id) <= 64),
  attempt integer NOT NULL CHECK (attempt >= 1),
  outcome text NOT NULL CHECK (outcome IN ('delivered','failed')),
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  error text CHECK (char_length(error) <= 64 AND error ~ '^[a-z0-9_]+$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, endpoint_id) REFERENCES webhook_endpoints(account_id, id) ON DELETE CASCADE
);
-- The admin log (newest first per endpoint) and the per-endpoint retention trim.
CREATE INDEX webhook_deliveries_endpoint_idx ON webhook_deliveries (account_id, endpoint_id, created_at DESC);

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY admin_read ON webhook_deliveries FOR SELECT TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin'));
CREATE POLICY worker_all ON webhook_deliveries FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT ON webhook_deliveries TO bodhinox_app;
GRANT SELECT, INSERT, DELETE ON webhook_deliveries TO bodhinox_worker;

-- SECURITY INVOKER: RLS scopes every statement to the caller's tenant, so an
-- endpoint id from another workspace finds no row and changes nothing.
CREATE FUNCTION record_webhook_attempt(p_endpoint_id uuid, p_event text, p_delivery_id text, p_attempt integer,
  p_delivered boolean, p_http_status integer, p_error text, p_min_failures integer, p_disable_after_minutes integer)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  endpoint record;
  should_disable boolean := false;
BEGIN
  SELECT id, account_id, is_active, failure_count, failing_since INTO endpoint
    FROM webhook_endpoints WHERE id = p_endpoint_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO webhook_deliveries(account_id, endpoint_id, event, delivery_id, attempt, outcome, http_status, error)
    VALUES (endpoint.account_id, endpoint.id, left(p_event, 64), left(p_delivery_id, 64), GREATEST(p_attempt, 1),
      CASE WHEN p_delivered THEN 'delivered' ELSE 'failed' END, NULLIF(p_http_status, 0),
      CASE WHEN p_delivered THEN NULL ELSE p_error END);
  IF p_delivered THEN
    UPDATE webhook_endpoints SET failure_count = 0, failing_since = NULL, last_delivery_at = now()
      WHERE id = endpoint.id;
  ELSE
    should_disable := endpoint.is_active
      AND endpoint.failure_count + 1 >= p_min_failures
      AND COALESCE(endpoint.failing_since, now()) <= now() - make_interval(mins => p_disable_after_minutes);
    UPDATE webhook_endpoints SET
        failure_count = failure_count + 1,
        failing_since = COALESCE(failing_since, now()),
        is_active = CASE WHEN should_disable THEN false ELSE is_active END,
        disabled_at = CASE WHEN should_disable THEN now() ELSE disabled_at END,
        disabled_reason = CASE WHEN should_disable THEN 'sustained_failure' ELSE disabled_reason END
      WHERE id = endpoint.id;
  END IF;
  -- Bounded log: the newest 100 attempts per endpoint, none older than 30 days.
  DELETE FROM webhook_deliveries d WHERE d.account_id = endpoint.account_id AND d.endpoint_id = endpoint.id
    AND (d.created_at < now() - interval '30 days' OR d.id IN (
      SELECT k.id FROM webhook_deliveries k WHERE k.account_id = endpoint.account_id AND k.endpoint_id = endpoint.id
      ORDER BY k.created_at DESC OFFSET 100));
  RETURN should_disable;
END
$$;
REVOKE ALL ON FUNCTION record_webhook_attempt(uuid,text,text,integer,boolean,integer,text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_webhook_attempt(uuid,text,text,integer,boolean,integer,text,integer,integer) TO bodhinox_worker;

-- Superset of 20261110101100_notifications_notice_type plus webhook_disabled.
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check; -- additive-exception: replaced in this statement pair by a superset check, NOT VALID
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'whatsapp_number_health', 'payment_received',
    'assigned_message', 'mention', 'sla_breach', 'campaign_finished', 'template_rejected', 'billing',
    'appointment_booked', 'appointment_cancelled', 'appointment_rescheduled',
    'low_stock', 'payment_exception', 'instagram_account_health', 'automation_notice',
    'webhook_disabled')) NOT VALID;
