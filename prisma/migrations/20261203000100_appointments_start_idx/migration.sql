-- Schedule reads (Today, Week, List and their paging) by start time across every status.
CREATE INDEX CONCURRENTLY appointments_start_idx ON appointments (account_id, start_at, id);
