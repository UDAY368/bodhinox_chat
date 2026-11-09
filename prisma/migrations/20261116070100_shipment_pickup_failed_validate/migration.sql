-- Audit finding 26, part 2: validate shipment_exceptions_kind_pickup_check (added NOT VALID in
-- 20261116070000). VALIDATE takes SHARE UPDATE EXCLUSIVE: reads and writes continue during the scan.
-- If it aborts on lock_timeout: prisma migrate resolve --rolled-back 20261116070100_shipment_pickup_failed_validate.
SET LOCAL lock_timeout = '5s';

ALTER TABLE shipment_exceptions VALIDATE CONSTRAINT shipment_exceptions_kind_pickup_check;
