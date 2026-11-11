-- Stage 4C: Conversions API events from Instagram flows. An event row is still
-- queued in the same transaction as the flow step and sent by the worker through
-- an outbound intent, exactly as for WhatsApp. Two additive columns say which
-- channel the event belongs to and which customer message carried the click-to-
-- Direct ad that makes it attributable. Existing rows are WhatsApp (a constant
-- default: no table rewrite). The app role's insert grant is a column list, so
-- it can set neither column; RLS is unchanged. capi_events is small and the
-- constant default satisfies the check for every row, so it is validated here.
SET LOCAL lock_timeout = '5s';

ALTER TABLE capi_events ADD COLUMN channel text NOT NULL DEFAULT 'whatsapp';
ALTER TABLE capi_events ADD CONSTRAINT capi_events_channel_check CHECK (channel IN ('whatsapp', 'instagram')) NOT VALID;
-- Instagram events carry no ad_referrals row: the attributing message is the customer's
-- click-to-Direct ad message (messages.interactive_payload ig.referral). No foreign key,
-- so deleting a message never blocks or rewrites an event already queued or sent.
ALTER TABLE capi_events ADD COLUMN message_id uuid;
ALTER TABLE capi_events VALIDATE CONSTRAINT capi_events_channel_check;
