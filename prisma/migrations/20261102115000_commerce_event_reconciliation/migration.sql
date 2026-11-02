-- Phase 6 review: commerce event consent snapshot and reconciliation. Additive.
--
-- marketing_consent: the store's record-time consent, so the send-time re-check
-- (lib/commerce/event-rules) applies the same rule when the template's category
-- changes during the delay. (Whether the event created the contact is already
-- kept in created_contact_id.)
--
-- resolution / resolved_at / resolved_by: an admin's decision on an event that
-- needs attention (a failed send, or one whose outcome is unknown) after
-- checking the chat. Recording it never sends anything.
ALTER TABLE commerce_events
  ADD COLUMN marketing_consent boolean,
  ADD COLUMN resolution text CHECK (resolution IN ('sent','not_sent')),
  ADD COLUMN resolved_at timestamptz,
  ADD COLUMN resolved_by uuid;

-- A resolution is complete, and leaves the event 'sent' (confirmed delivered)
-- or 'failed' (confirmed not delivered).
ALTER TABLE commerce_events ADD CONSTRAINT commerce_events_resolution_state_check CHECK (
  (resolution IS NULL) = (resolved_at IS NULL)
  AND (resolution IS NULL OR resolved_by IS NOT NULL)
  AND (resolution IS NULL OR status = CASE resolution WHEN 'sent' THEN 'sent' ELSE 'failed' END)
);

-- The "needs attention" list.
CREATE INDEX commerce_events_attention_idx ON commerce_events(account_id, created_at DESC)
  WHERE resolved_at IS NULL AND (status = 'failed' OR (status = 'scheduled' AND reason = 'outcome_unknown'));

-- Admins may resolve an open attention row once, as themselves, and change
-- nothing else: column grants limit the columns, the policy limits the rows.
GRANT UPDATE (status, resolution, resolved_at, resolved_by) ON commerce_events TO bodhinox_app;
CREATE POLICY admin_resolve ON commerce_events FOR UPDATE TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin') AND resolved_at IS NULL
    AND (status = 'failed' OR (status = 'scheduled' AND reason = 'outcome_unknown')))
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('admin')
    AND resolved_at IS NOT NULL AND resolved_by = app_user_id());
