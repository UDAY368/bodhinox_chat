SET LOCAL lock_timeout = '5s';

-- Store Phase 5: zones (states), weight slabs, a free-shipping threshold and a per-zone COD switch on shipping rates.
-- Every column is nullable or defaulted, so existing rates keep pricing exactly as before.
ALTER TABLE shipping_rates
  ADD COLUMN states text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(states) <= 100 AND array_to_string(states, ',') ~ '^([0-9A-Z][0-9A-Z ]{1,39}(,[0-9A-Z][0-9A-Z ]{1,39})*)?$'),
  ADD COLUMN base_weight_grams integer CHECK (base_weight_grams IS NULL OR base_weight_grams BETWEEN 0 AND 1000000),
  ADD COLUMN step_grams integer CHECK (step_grams IS NULL OR step_grams BETWEEN 1 AND 1000000),
  ADD COLUMN extra_per_step_minor bigint CHECK (extra_per_step_minor IS NULL OR extra_per_step_minor >= 0),
  ADD COLUMN max_weight_grams integer CHECK (max_weight_grams IS NULL OR max_weight_grams BETWEEN 1 AND 100000000),
  ADD COLUMN free_over_minor bigint CHECK (free_over_minor IS NULL OR free_over_minor >= 0),
  ADD COLUMN cod_allowed boolean NOT NULL DEFAULT true,
  ADD CONSTRAINT shipping_rates_slab_complete CHECK ((step_grams IS NULL) = (extra_per_step_minor IS NULL)); -- additive-exception: shipping_rates holds a few rows per workspace and every new column is null or defaulted, so the check scan is instant

GRANT UPDATE (states, base_weight_grams, step_grams, extra_per_step_minor, max_weight_grams, free_over_minor, cod_allowed)
  ON shipping_rates TO bodhinox_app;
