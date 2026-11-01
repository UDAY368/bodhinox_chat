-- Contact consent: an opted-out contact receives no marketing (broadcasts,
-- scheduled automations, template steps); a blocked contact receives no
-- automated messages at all. NULL means "not opted out" / "not blocked".
ALTER TABLE contacts
  ADD COLUMN opted_out_at timestamptz,
  ADD COLUMN opt_out_source text CHECK (opt_out_source IN ('keyword','agent','api','import')),
  ADD COLUMN blocked_at timestamptz;
