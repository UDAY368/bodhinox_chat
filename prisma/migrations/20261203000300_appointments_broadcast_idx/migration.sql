-- Bookings credited to a campaign.
CREATE INDEX CONCURRENTLY appointments_broadcast_idx ON appointments (account_id, broadcast_id) WHERE broadcast_id IS NOT NULL;
