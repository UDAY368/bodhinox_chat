-- Set while a run waits on something with its own deadline (a payment
-- link's expiry). The stale sweep and the inline timeout check count a
-- run's age from the later of last_advanced_at, delay_until and this, so a
-- run is never timed out while the link it waits on can still be paid.
ALTER TABLE flow_runs ADD COLUMN wait_until TIMESTAMPTZ;
