-- WhatsApp opt-in record: when and how a contact agreed to business-initiated
-- (template / marketing) messages, next to the existing opt-out
-- (opted_out_at, opt_out_source). START or an agent's opt-in stamps it and
-- clears the opt-out; STOP sets the opt-out and leaves the last opt-in as
-- history. NULL means no opt-in has been recorded.
--
-- Additive: two nullable columns, covered by the existing table grants and
-- row-level security on contacts.
SET LOCAL lock_timeout = '5s';

ALTER TABLE contacts
  ADD COLUMN opted_in_at timestamptz,
  ADD COLUMN opt_in_source text CHECK (opt_in_source IN ('keyword','agent','api','import'));
