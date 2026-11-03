-- Phase 9: analytics and reports.
--
-- Aggregates vs rollups. Reports run plain indexed SQL over the live tables
-- (src/lib/analytics/queries.ts) instead of a daily rollup table filled by a
-- worker. Measured on a local PostgreSQL 18 with 2 workspaces x 1M messages,
-- 100k conversations, 300k campaign recipients and 200k flow runs each, with
-- the three CONCURRENTLY indexes that follow this migration:
--
--   report                 1 day    7 days   90 days   366 days
--   conversation stats     80 ms    136 ms   865 ms    1.6 s
--   agent leaderboard      19 ms     90 ms   1.1 s     2.3 s
--   campaign funnel         3 ms     99 ms   1.2 s     2.6 s
--   flow stats              7 ms     21 ms    72 ms    116 ms
--   AI stats               14 ms     29 ms   134 ms    395 ms
--   template daily          3 ms    148 ms   1.2 s     2.0 s
--
-- Without those indexes the one-day reports took 150-300 ms because every
-- report read all of the workspace's messages. A year on a 1M-message
-- workspace stays well inside the 15 s analytics statement timeout, and live
-- queries need no backfill, no worker and no reconciliation of stale rollups.
-- Revisit with a rollup when a workspace passes ~10M messages a year.
--
-- Rate cards: Meta's per-message prices by category and destination country, a
-- platform catalogue (no tenant data), seeded empty. Every signed-in user may
-- read it for campaign cost estimates; only server code acting for a platform
-- admin (PLATFORM_ADMIN_EMAILS) writes it, through the worker role, like
-- plan_prices.
CREATE TABLE rate_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL CHECK (category IN ('marketing','utility','authentication','service')),
  country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- Price of one message in the currency's minor unit (cents, paise). Meta
  -- quotes fractions of a cent, so this is numeric, not an integer.
  price_minor numeric(14,4) NOT NULL CHECK (price_minor >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category, country_code, currency)
);
GRANT SELECT ON rate_cards TO bodhinox_app, bodhinox_worker;
GRANT INSERT, UPDATE, DELETE ON rate_cards TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON rate_cards
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
