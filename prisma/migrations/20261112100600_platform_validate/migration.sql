-- Phase 14: validate the plan-version foreign key 20261112100100_plan_versions
-- added NOT VALID. VALIDATE CONSTRAINT holds SHARE UPDATE EXCLUSIVE on
-- account_subscriptions, so billing keeps writing during the scan; every
-- backfilled pin points at a version 1 row. Additive.
SET LOCAL lock_timeout = '5s';
ALTER TABLE account_subscriptions VALIDATE CONSTRAINT account_subscriptions_plan_version_fkey;
