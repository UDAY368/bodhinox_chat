SET LOCAL lock_timeout = '5s';

-- Ads gaps, phase 3: ad review feedback, automated rules and A/B variants. Additive.
-- meta_ad_objects.review_feedback: Meta's reason for a rejected (or limited)
-- ad, from the hourly campaign sync, shown to members.
-- meta_ad_rules: admin rules such as "pause an ad set when cost per result is
-- above 200 over the last 3 days (after spending at least 500)"; the worker
-- checks them hourly against stored insights. A pause goes through the
-- existing change pipeline (meta_ad_changes: one outbound intent, read-back,
-- budget cap), as the admin who made the rule while they are still an admin.
-- meta_ad_rule_actions: each object is acted on at most once per rule per day.
-- meta_ad_drafts.variant_of: a variant ad (A/B test) made in an existing draft's
-- ad set; it starts at the creative step with the source's campaign and ad set.

ALTER TABLE meta_ad_objects ADD COLUMN review_feedback text;
ALTER TABLE meta_ad_objects ADD CONSTRAINT meta_ad_objects_review_feedback_check
  CHECK (char_length(review_feedback) <= 1000) NOT VALID;
ALTER TABLE meta_ad_objects VALIDATE CONSTRAINT meta_ad_objects_review_feedback_check;

CREATE TABLE meta_ad_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  level text NOT NULL CHECK (level IN ('campaign','adset','ad')),
  metric text NOT NULL CHECK (metric IN ('cost_per_result','spend','ctr','cpm')),
  operator text NOT NULL CHECK (operator IN ('gt','lt')),
  threshold numeric(18,4) NOT NULL CHECK (threshold >= 0 AND threshold < 1000000000000),
  window_days int NOT NULL CHECK (window_days IN (1,3,7)),
  min_spend numeric(18,4) NOT NULL DEFAULT 0 CHECK (min_spend >= 0 AND min_spend < 1000000000000),
  action text NOT NULL CHECK (action IN ('pause','notify')),
  enabled boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)
);
CREATE INDEX meta_ad_rules_enabled ON meta_ad_rules(account_id) WHERE enabled;

CREATE TABLE meta_ad_rule_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  rule_id uuid NOT NULL,
  object_id text NOT NULL CHECK (object_id ~ '^\d{1,32}$'),
  object_name text CHECK (char_length(object_name) <= 400),
  action text NOT NULL CHECK (action IN ('pause','notify')),
  outcome text NOT NULL CHECK (outcome IN ('queued','notified','skipped')),
  value numeric(18,4),
  day date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, rule_id) REFERENCES meta_ad_rules(account_id, id) ON DELETE CASCADE,
  UNIQUE (rule_id, object_id, day)
);
CREATE INDEX meta_ad_rule_actions_recent ON meta_ad_rule_actions(account_id, created_at DESC);

ALTER TABLE meta_ad_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_ad_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON meta_ad_rules FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
-- Writes run as the worker after the route's admin, membership and CSRF checks, or in the rules job.
CREATE POLICY worker_write ON meta_ad_rules FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT ON meta_ad_rules TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON meta_ad_rules TO bodhinox_worker;

ALTER TABLE meta_ad_rule_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_ad_rule_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON meta_ad_rule_actions FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY worker_write ON meta_ad_rule_actions FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT ON meta_ad_rule_actions TO bodhinox_app;
GRANT SELECT, INSERT ON meta_ad_rule_actions TO bodhinox_worker;

ALTER TABLE meta_ad_drafts ADD COLUMN variant_of uuid;
ALTER TABLE meta_ad_drafts ADD CONSTRAINT meta_ad_drafts_variant_fkey
  FOREIGN KEY (account_id, variant_of) REFERENCES meta_ad_drafts(account_id, id) ON DELETE SET NULL (variant_of) NOT VALID;
ALTER TABLE meta_ad_drafts VALIDATE CONSTRAINT meta_ad_drafts_variant_fkey;
