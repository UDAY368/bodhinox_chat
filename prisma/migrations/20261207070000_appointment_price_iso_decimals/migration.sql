SET LOCAL lock_timeout = '5s';

-- Appointment prices in ISO 4217 minor units, like every other money column.
--
-- The staff Bookings screens converted typed prices with the browser's Intl decimal places, which are
-- 0 for 17 currencies whose ISO 4217 exponent is 2 (or 3 for IQD). Every reader (the public booking
-- page, payment links, customer messages) reads ISO minor units, so in those currencies a staff price
-- of "1000" was stored as 1000 and read as 10.00. From this release the staff screens use the ISO
-- table too (src/components/appointments/shared.ts), and this migration rescales what was stored.
--
-- Rescaled: every service price, and the price snapshot of appointments with no payment link yet
-- (payment_status 'none'). Appointments whose payment is pending, paid or refunded keep their snapshot,
-- so it still matches the payment record; staff review those (query in docs/deployment/railway.md).
-- Currencies where the two tables agree (INR, USD, JPY, KWD, ...) are untouched. It runs once, as every
-- migration does; no app code writes these columns during the migration's lock.
-- If it aborts on lock_timeout: prisma migrate resolve --rolled-back 20261207070000_appointment_price_iso_decimals.

UPDATE appointment_services
SET price_minor = price_minor * CASE WHEN currency = 'IQD' THEN 1000 ELSE 100 END
WHERE price_minor IS NOT NULL
  AND currency IN ('AFN','ALL','COP','HUF','IDR','IQD','IRR','KPW','LAK','LBP','MGA','MMK','PKR','SLL','SOS','SYP','YER');

UPDATE appointments
SET price_minor = price_minor * CASE WHEN currency = 'IQD' THEN 1000 ELSE 100 END
WHERE price_minor IS NOT NULL
  AND payment_status = 'none'
  AND currency IN ('AFN','ALL','COP','HUF','IDR','IQD','IRR','KPW','LAK','LBP','MGA','MMK','PKR','SLL','SOS','SYP','YER');
