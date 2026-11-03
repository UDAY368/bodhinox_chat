-- Phase 8: money customers pay a workspace (never SaaS billing: invoices,
-- invoice_sequences and lib/billing are untouched). One row per captured or
-- recorded payment, refunds with a send-once lifecycle, and the exception
-- queue for anything that must not settle silently. Additive.
--
-- Every financial effect is written by the worker (lib/payments/settle.ts,
-- refunds.ts, offline.ts) after an authoritative fetch with the tenant's keys;
-- the app role only reads.

-- ================================================================ payment links (additive)
ALTER TABLE payment_links
  ADD COLUMN appointment_id uuid,
  -- The tenant's Razorpay key id when the link was created, stamped by the
  -- trigger below (any supplied value is overwritten). Settling a link whose
  -- key differs from the connected one opens merchant_changed.
  ADD COLUMN provider_key_id text CHECK (provider_key_id IS NULL OR char_length(provider_key_id) BETWEEN 1 AND 100);
ALTER TABLE payment_links ADD CONSTRAINT payment_links_appointment_fkey FOREIGN KEY (account_id, appointment_id)
  REFERENCES appointments(account_id, id) ON DELETE SET NULL (appointment_id);
CREATE INDEX payment_links_appointment_idx ON payment_links (account_id, appointment_id) WHERE appointment_id IS NOT NULL;

CREATE FUNCTION payment_links_stamp_key() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.provider_key_id := (SELECT p.key_id FROM payment_providers p
    WHERE p.account_id = NEW.account_id AND p.provider = NEW.provider);
  RETURN NEW;
END $$;
CREATE TRIGGER payment_links_stamp_key BEFORE INSERT ON payment_links
  FOR EACH ROW EXECUTE FUNCTION payment_links_stamp_key();

-- ================================================================ customer payments
CREATE TABLE customer_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('razorpay','offline')),
  provider_payment_id text CHECK (provider_payment_id IS NULL OR provider_payment_id ~ '^pay_[A-Za-z0-9]{1,40}$'),
  -- The webhook payload's merchant account id, for audit only.
  provider_account_id text CHECK (provider_account_id IS NULL OR char_length(provider_account_id) <= 64),
  payment_link_id uuid,
  order_id uuid,
  appointment_id uuid,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL CHECK (status IN ('authorized','captured','failed')),
  method text CHECK (method IS NULL OR char_length(method) <= 32),
  offline_reference text CHECK (offline_reference IS NULL OR char_length(offline_reference) <= 100),
  recorded_by uuid,
  captured_at timestamptz,
  refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  settlement text NOT NULL DEFAULT 'pending' CHECK (settlement IN ('pending','settled','exception','unattached')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  -- One row per gateway payment, however many times its webhook arrives.
  UNIQUE (account_id, provider_payment_id),
  CHECK (refunded_minor <= amount_minor),
  CHECK ((source = 'razorpay') = (provider_payment_id IS NOT NULL)),
  CHECK (source = 'offline' OR offline_reference IS NULL),
  FOREIGN KEY (account_id, payment_link_id) REFERENCES payment_links(account_id, id) ON DELETE SET NULL (payment_link_id),
  FOREIGN KEY (account_id, order_id) REFERENCES orders(account_id, id) ON DELETE SET NULL (order_id),
  FOREIGN KEY (account_id, appointment_id) REFERENCES appointments(account_id, id) ON DELETE SET NULL (appointment_id)
);
CREATE INDEX customer_payments_created_idx ON customer_payments (account_id, created_at DESC);
CREATE INDEX customer_payments_order_idx ON customer_payments (account_id, order_id) WHERE order_id IS NOT NULL;
CREATE INDEX customer_payments_appointment_idx ON customer_payments (account_id, appointment_id) WHERE appointment_id IS NOT NULL;
CREATE INDEX customer_payments_link_idx ON customer_payments (account_id, payment_link_id) WHERE payment_link_id IS NOT NULL;
CREATE INDEX customer_payments_pending_idx ON customer_payments (account_id, created_at) WHERE settlement = 'pending';

-- ================================================================ refunds
-- requested -> sending -> pending -> processed | failed; an ambiguous send is
-- 'unknown' and is reconciled, never re-sent automatically.
CREATE TABLE customer_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  payment_id uuid NOT NULL,
  order_id uuid,
  appointment_id uuid,
  source text NOT NULL CHECK (source IN ('bodhinox','external')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reason_code text NOT NULL CHECK (reason_code IN ('customer_request','out_of_stock','return','duplicate','cancelled','other')),
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  status text NOT NULL CHECK (status IN ('requested','sending','pending','processed','failed','unknown')),
  provider_refund_id text CHECK (provider_refund_id IS NULL OR provider_refund_id ~ '^rfnd_[A-Za-z0-9]{1,40}$'),
  -- A code only, never provider text.
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9_]{1,64}$'),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 20),
  -- Razorpay refund ids of earlier attempts: a late report about one of them
  -- never changes the live attempt (a processed one is surfaced instead).
  superseded_provider_refund_ids text[] NOT NULL DEFAULT '{}' CHECK (cardinality(superseded_provider_refund_ids) <= 20),
  requested_by uuid,
  restock boolean NOT NULL DEFAULT false,
  -- FK to order_returns is added by 20261107101500_order_lifecycle.
  return_id uuid,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, provider_refund_id),
  FOREIGN KEY (account_id, payment_id) REFERENCES customer_payments(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, order_id) REFERENCES orders(account_id, id) ON DELETE SET NULL (order_id),
  FOREIGN KEY (account_id, appointment_id) REFERENCES appointments(account_id, id) ON DELETE SET NULL (appointment_id)
);
CREATE INDEX customer_refunds_payment_idx ON customer_refunds (account_id, payment_id);
CREATE INDEX customer_refunds_order_idx ON customer_refunds (account_id, order_id) WHERE order_id IS NOT NULL;
CREATE INDEX customer_refunds_open_idx ON customer_refunds (account_id, updated_at)
  WHERE status IN ('requested','sending','pending','unknown');
CREATE INDEX customer_refunds_created_idx ON customer_refunds (account_id, created_at DESC);

-- ================================================================ exceptions
CREATE TABLE payment_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('late_payment_no_stock','late_payment_slot_lost','payment_on_closed_order',
    'duplicate_payment','amount_mismatch','currency_mismatch','merchant_changed','payment_unmatched',
    'refund_unknown','refund_failed')),
  -- What the exception is about, e.g. payment:<id>, refund:<id>, link:<id>.
  subject_key text NOT NULL CHECK (subject_key ~ '^[a-z_]{1,16}:[A-Za-z0-9_-]{1,64}$'),
  order_id uuid,
  payment_id uuid,
  refund_id uuid,
  appointment_id uuid,
  payment_link_id uuid,
  -- A code only, never customer or provider text.
  detail text CHECK (detail IS NULL OR detail ~ '^[a-z0-9_]{1,64}$'),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution text CHECK (resolution IS NULL OR resolution IN ('refunded','restocked','accepted','dismissed')),
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  CHECK ((status = 'resolved') = (resolution IS NOT NULL AND resolved_at IS NOT NULL)),
  FOREIGN KEY (account_id, order_id) REFERENCES orders(account_id, id) ON DELETE SET NULL (order_id),
  FOREIGN KEY (account_id, payment_id) REFERENCES customer_payments(account_id, id) ON DELETE SET NULL (payment_id),
  FOREIGN KEY (account_id, refund_id) REFERENCES customer_refunds(account_id, id) ON DELETE SET NULL (refund_id),
  FOREIGN KEY (account_id, appointment_id) REFERENCES appointments(account_id, id) ON DELETE SET NULL (appointment_id),
  FOREIGN KEY (account_id, payment_link_id) REFERENCES payment_links(account_id, id) ON DELETE SET NULL (payment_link_id)
);
CREATE UNIQUE INDEX payment_exceptions_open_key ON payment_exceptions (account_id, kind, subject_key) WHERE status = 'open';
CREATE INDEX payment_exceptions_status_idx ON payment_exceptions (account_id, status, created_at DESC);
CREATE INDEX payment_exceptions_order_idx ON payment_exceptions (account_id, order_id) WHERE order_id IS NOT NULL;

-- ================================================================ RLS
-- Agents and above read; only the worker writes. Viewers read nothing.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['customer_payments','customer_refunds','payment_exceptions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT TO bodhinox_app,bodhinox_worker USING (account_id=app_account_id() AND app_write_allowed(%L))', t, 'agent');
    EXECUTE format('CREATE POLICY worker_write ON %I FOR ALL TO bodhinox_worker USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id())', t);
    EXECUTE format('GRANT SELECT ON %I TO bodhinox_app', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO bodhinox_worker', t);
    EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()', t);
  END LOOP;
END $$;
