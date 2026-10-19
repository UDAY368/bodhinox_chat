-- Provider timestamps have second precision. Preserve insertion order for ties.
ALTER TABLE messages ADD COLUMN arrival_sequence BIGINT GENERATED ALWAYS AS IDENTITY;
CREATE INDEX idx_messages_customer_arrival ON messages(account_id, conversation_id, created_at DESC, arrival_sequence DESC) WHERE sender_type = 'customer';
