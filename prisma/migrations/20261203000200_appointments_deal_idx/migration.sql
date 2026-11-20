-- Bookings of a deal.
CREATE INDEX CONCURRENTLY appointments_deal_idx ON appointments (account_id, deal_id) WHERE deal_id IS NOT NULL;
