-- Preserve creation-specific fanout flags when a receipt retries before message ingest.
ALTER TABLE contacts ADD COLUMN inbound_created_meta_id text;
ALTER TABLE conversations ADD COLUMN inbound_created_meta_id text;
