-- Instagram Phase 3 (Stage 4): validate the checks that
-- 20261117190200_instagram_connection_kind added NOT VALID. VALIDATE CONSTRAINT
-- holds SHARE UPDATE EXCLUSIVE, so reads and writes continue during the scan.
-- Every existing row holds the constant default instagram_login with no Page id,
-- which passes. Additive.
SET LOCAL lock_timeout = '5s';

ALTER TABLE instagram_accounts VALIDATE CONSTRAINT instagram_accounts_connection_kind_check;
ALTER TABLE instagram_accounts VALIDATE CONSTRAINT instagram_accounts_facebook_page_check;
