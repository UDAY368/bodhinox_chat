CREATE INDEX CONCURRENTLY contacts_owner_idx ON contacts (account_id, owner_id) WHERE owner_id IS NOT NULL;
