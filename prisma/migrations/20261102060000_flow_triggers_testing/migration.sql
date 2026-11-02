-- Phase 4.3: template-reply flow trigger, testing-only drafts and WhatsApp ice breakers.
ALTER TABLE flows DROP CONSTRAINT IF EXISTS flows_trigger_type_check;
ALTER TABLE flows ADD CONSTRAINT flows_trigger_type_check
  CHECK (trigger_type IN ('keyword', 'first_inbound_message', 'manual', 'template_reply'));

-- While a flow is a draft it runs only for these numbers (digits only, up to 3).
ALTER TABLE flows ADD COLUMN test_numbers TEXT[] NOT NULL DEFAULT '{}'
  CONSTRAINT flows_test_numbers_check CHECK (cardinality(test_numbers) <= 3);

-- Prompts shown when a customer opens a new chat; synced to Meta.
ALTER TABLE whatsapp_config ADD COLUMN ice_breakers TEXT[] NOT NULL DEFAULT '{}'
  CONSTRAINT whatsapp_config_ice_breakers_check CHECK (cardinality(ice_breakers) <= 4);
ALTER TABLE whatsapp_config ADD COLUMN ice_breakers_synced_at TIMESTAMPTZ;
