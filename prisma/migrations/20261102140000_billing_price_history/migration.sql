-- Phase 8 review: a price change must not orphan subscriptions on the old provider plan.
--
-- A new provider plan for the same plan + interval adds a row and deactivates
-- the old one instead of overwriting provider_plan_id, so a subscription
-- created on the old provider plan (a checkout started before the change and
-- authorised after it, or any existing subscriber) still maps to our plan.
-- One provider plan maps to exactly one row; at most one row per key is active.
ALTER TABLE plan_prices DROP CONSTRAINT plan_prices_plan_interval_currency_provider_key;
ALTER TABLE plan_prices ADD CONSTRAINT plan_prices_provider_plan_key UNIQUE (provider, provider_plan_id);
CREATE UNIQUE INDEX plan_prices_one_active ON plan_prices(plan, "interval", currency, provider) WHERE active;

-- The provider plan a checkout was created on, so the sweep reconciles a lost
-- answer against that plan even after the price has changed.
ALTER TABLE billing_intents ADD COLUMN provider_plan_id text
  CHECK (char_length(provider_plan_id) BETWEEN 1 AND 64);
