-- Audit finding 26: a failed Shiprocket pickup request opens a shipment exception (kind 'pickup_failed')
-- so it reaches the exceptions queue. The kind CHECK is replaced by a superset (every existing row
-- still passes). The new constraint is added NOT VALID and validated in
-- 20261116070100_shipment_pickup_failed_validate; the old one is dropped here, so new rows are always
-- checked by one of the two. Both statements take a brief ACCESS EXCLUSIVE lock on shipment_exceptions,
-- waiting at most 5 s. If it aborts: prisma migrate resolve --rolled-back
-- 20261116070000_shipment_pickup_failed_exception, then re-run.
SET LOCAL lock_timeout = '5s';

ALTER TABLE shipment_exceptions ADD CONSTRAINT shipment_exceptions_kind_pickup_check CHECK (kind IN ('contradiction',
  'create_unknown','awb_unknown','rto','lost_or_damaged','stale_tracking','order_conflict','pickup_failed')) NOT VALID;
ALTER TABLE shipment_exceptions DROP CONSTRAINT shipment_exceptions_kind_check; -- additive-exception: replaced by shipment_exceptions_kind_pickup_check, a superset that adds pickup_failed
