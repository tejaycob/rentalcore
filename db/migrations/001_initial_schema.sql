-- ============================================================
-- Multi-tenant Rental SaaS — Database Schema v2
-- Updated for multi-country payment provider support
-- (Mozambique, South Africa, Angola — more countries add rows, not tables)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- COMPANIES — the tenant of this SaaS (a real estate company)
-- ============================================================
CREATE TABLE companies (
  id                  UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  name                TEXT NOT NULL,
  country_code        TEXT NOT NULL CHECK (country_code IN ('MZ','ZA','AO')),
  currency            TEXT NOT NULL,  -- 'MZN', 'ZAR', 'AOA'
  tax_id              TEXT,
  address             TEXT,
  email               TEXT,
  phone               TEXT,
  plan_tier           TEXT NOT NULL DEFAULT 'starter' CHECK (plan_tier IN ('starter','growth','scale')),
  trial_ends_at       TIMESTAMPTZ,
  active              BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_companies_country ON companies(country_code);

-- ============================================================
-- PAYMENT PROVIDER CONFIG — which real provider a company uses,
-- keyed by country. This is the row-level switch behind the
-- PaymentProvider interface in code; adding Kenya later means
-- inserting 'KE' here, not touching this table's shape.
-- ============================================================
CREATE TABLE company_payment_configs (
  id                  UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL CHECK (provider IN ('paysuite','appypay','ozow','paystack')),
  -- Card-vs-wallet split only matters where one country needs two
  -- providers (South Africa: Ozow for EFT, Paystack for cards).
  -- For Mozambique/Angola this is always 'all'.
  payment_method_scope TEXT NOT NULL DEFAULT 'all' CHECK (payment_method_scope IN ('all','wallet','card')),
  -- Credentials are stored encrypted at the application layer (see
  -- AGE/pgsodium or app-level KMS) — never plaintext in this column.
  encrypted_credentials BYTEA NOT NULL,
  is_live             BOOLEAN NOT NULL DEFAULT false,
  active              BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(company_id, provider, payment_method_scope)
);

-- ============================================================
-- USERS — covers both apps. 'renter' is the rental tenant;
-- everyone else is staff. Naming is deliberate to avoid the
-- "tenant of the SaaS" vs "tenant who rents" ambiguity.
-- ============================================================
CREATE TABLE users (
  id                  UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  company_id          UUID REFERENCES companies(id) ON DELETE CASCADE,
  role                TEXT NOT NULL CHECK (role IN ('owner','property_manager','accountant','renter')),
  name                TEXT NOT NULL,
  email               TEXT NOT NULL UNIQUE,
  phone               TEXT,
  password_hash       TEXT NOT NULL,
  push_token          TEXT,            -- Expo push token, mobile app only
  locale              TEXT NOT NULL CHECK (locale IN ('pt','en')),
  active              BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_company_id ON users(company_id);
CREATE INDEX idx_users_role       ON users(role);

-- ============================================================
-- REFRESH TOKENS — separate table so a single token revoke
-- doesn't require touching the users row, and so we can list/
-- revoke active sessions per device (mobile app needs this for
-- "log out of all devices").
-- ============================================================
CREATE TABLE refresh_tokens (
  id                  UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash          TEXT NOT NULL UNIQUE,
  device_label        TEXT,            -- "iPhone 14, Maputo" — shown in "active sessions"
  expires_at          TIMESTAMPTZ NOT NULL,
  revoked_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);

-- ============================================================
-- PROPERTIES & UNITS
-- ============================================================
CREATE TABLE properties (
  id                  UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  address             TEXT NOT NULL,
  city                TEXT NOT NULL,
  active              BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_properties_company ON properties(company_id);

CREATE TABLE manager_properties (
  manager_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_id         UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  PRIMARY KEY (manager_id, property_id)
);

CREATE TABLE units (
  id                  UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  property_id         UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  label               TEXT NOT NULL,
  unit_type           TEXT NOT NULL DEFAULT 'apartment',
  base_rent           DECIMAL(12,2) NOT NULL,
  status              TEXT NOT NULL DEFAULT 'vacant' CHECK (status IN ('occupied','vacant','maintenance')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(property_id, label)
);

CREATE INDEX idx_units_property ON units(property_id);
CREATE INDEX idx_units_status   ON units(status);

-- ============================================================
-- LEASES
-- ============================================================
CREATE TABLE leases (
  id                  UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  unit_id             UUID NOT NULL REFERENCES units(id),
  renter_id           UUID NOT NULL REFERENCES users(id),
  start_date          DATE NOT NULL,
  end_date            DATE NOT NULL,
  rent_amount         DECIMAL(12,2) NOT NULL,
  deposit_amount      DECIMAL(12,2) NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','expired','terminated')),
  document_url        TEXT,            -- generated lease PDF, in object storage
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_leases_company ON leases(company_id);
CREATE INDEX idx_leases_renter  ON leases(renter_id);
CREATE INDEX idx_leases_end_date ON leases(end_date);

-- ============================================================
-- LEASE SIGNATURES — split from leases because e-signature
-- has its own lifecycle and provider (DocuSign/HelloSign-style).
-- ============================================================
CREATE TABLE lease_signatures (
  id                  UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  lease_id            UUID NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  signer_user_id       UUID REFERENCES users(id),
  signer_role         TEXT NOT NULL CHECK (signer_role IN ('owner','renter')),
  status              TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','viewed','signed','declined')),
  provider_envelope_id TEXT,           -- external e-sign provider's reference
  signed_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_signatures_lease ON lease_signatures(lease_id);

-- ============================================================
-- INVOICES
-- ============================================================
CREATE TABLE invoices (
  id                  UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  lease_id            UUID NOT NULL REFERENCES leases(id),
  period              TEXT NOT NULL,    -- 'YYYY-MM'
  amount_due          DECIMAL(12,2) NOT NULL,
  due_date            DATE NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','overdue','cancelled')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(lease_id, period)
);

CREATE INDEX idx_invoices_company ON invoices(company_id);
CREATE INDEX idx_invoices_lease   ON invoices(lease_id);
CREATE INDEX idx_invoices_status  ON invoices(status);
CREATE INDEX idx_invoices_due_date ON invoices(due_date);

-- ============================================================
-- PAYMENTS — the provider-facing event log. Renamed from the
-- earlier Stripe-specific draft: provider_payment_id is generic,
-- provider tells you which adapter wrote this row.
-- ============================================================
CREATE TABLE payments (
  id                  UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  invoice_id          UUID NOT NULL REFERENCES invoices(id),
  company_id          UUID NOT NULL REFERENCES companies(id),
  provider            TEXT NOT NULL CHECK (provider IN ('paysuite','appypay','ozow','paystack')),
  provider_payment_id TEXT,    -- external reference from the provider
  method              TEXT NOT NULL,    -- 'mpesa','emola','mkesh','card','eft','multicaixa'
  amount              DECIMAL(12,2) NOT NULL,
  currency            TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('initiated','pending','succeeded','failed','refunded')),
  raw_webhook_payload  JSONB,           -- audit trail of what the provider actually sent
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_payment_id)
);

CREATE INDEX idx_payments_invoice  ON payments(invoice_id);
CREATE INDEX idx_payments_company  ON payments(company_id);
CREATE INDEX idx_payments_status   ON payments(status);

-- ============================================================
-- LEDGER ENTRIES — real double-entry. debit/credit, never a
-- single signed amount. Every invoice that's paid produces a
-- balanced pair of entries; refunds and late fees do the same.
-- ============================================================
CREATE TABLE ledger_entries (
  id                  UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  company_id          UUID NOT NULL REFERENCES companies(id),
  invoice_id          UUID REFERENCES invoices(id),
  payment_id          UUID REFERENCES payments(id),
  entry_type          TEXT NOT NULL CHECK (entry_type IN ('rent_income','late_fee','refund','deposit_held','deposit_returned')),
  account             TEXT NOT NULL,     -- 'accounts_receivable','rent_revenue','cash','refunds_payable'
  debit               DECIMAL(12,2) NOT NULL DEFAULT 0,
  credit              DECIMAL(12,2) NOT NULL DEFAULT 0,
  memo                TEXT,
  posted_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (debit >= 0 AND credit >= 0),
  CHECK (NOT (debit = 0 AND credit = 0))
);

CREATE INDEX idx_ledger_company ON ledger_entries(company_id);
CREATE INDEX idx_ledger_invoice ON ledger_entries(invoice_id);

-- ============================================================
-- MAINTENANCE TICKETS
-- ============================================================
CREATE TABLE maintenance_tickets (
  id                  UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  unit_id             UUID NOT NULL REFERENCES units(id),
  reported_by         UUID NOT NULL REFERENCES users(id),
  assigned_to         UUID REFERENCES users(id),
  title               TEXT NOT NULL,
  description         TEXT,
  priority            TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','cancelled')),
  opened_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at         TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tickets_company ON maintenance_tickets(company_id);
CREATE INDEX idx_tickets_status  ON maintenance_tickets(status);
CREATE INDEX idx_tickets_unit    ON maintenance_tickets(unit_id);

CREATE TABLE ticket_attachments (
  id                  UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  ticket_id           UUID NOT NULL REFERENCES maintenance_tickets(id) ON DELETE CASCADE,
  media_url           TEXT NOT NULL,
  media_type          TEXT NOT NULL CHECK (media_type IN ('photo','video')),
  uploaded_by         UUID NOT NULL REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_attachments_ticket ON ticket_attachments(ticket_id);

-- ============================================================
-- SUBSCRIPTIONS — your SaaS billing of the companies themselves.
-- Separate from the payments table above, which is rent money
-- flowing to the company, not to you.
-- ============================================================
CREATE TABLE subscriptions (
  id                  UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  company_id          UUID NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  plan_tier           TEXT NOT NULL CHECK (plan_tier IN ('starter','growth','scale')),
  status              TEXT NOT NULL DEFAULT 'trialing' CHECK (status IN ('trialing','active','past_due','cancelled')),
  unit_limit          INTEGER NOT NULL DEFAULT 25,
  current_period_end  DATE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- AUDIT LOG
-- ============================================================
CREATE TABLE audit_log (
  id                  UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  company_id          UUID REFERENCES companies(id),
  actor_id            UUID REFERENCES users(id),
  action              TEXT NOT NULL,
  table_name          TEXT,
  record_id           UUID,
  old_data            JSONB,
  new_data            JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_company ON audit_log(company_id);

-- ============================================================
-- ROW LEVEL SECURITY — isolates companies from each other.
-- Every policy resolves through current_setting('app.company_id'),
-- which the NestJS tenancy guard sets per-request via
-- SET LOCAL app.company_id = '<uuid>' at the start of each
-- request's transaction. This is the structural enforcement
-- described in the architecture: a query literally cannot
-- read another company's row even if application code forgets
-- to filter, because Postgres itself blocks it.
-- ============================================================
ALTER TABLE companies              ENABLE ROW LEVEL SECURITY;
ALTER TABLE users                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE properties             ENABLE ROW LEVEL SECURITY;
ALTER TABLE units                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE leases                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE lease_signatures       ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices               ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments               ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries         ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_tickets    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_attachments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log              ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_payment_configs ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION current_company_id() RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.company_id', true)::UUID;
$$;

CREATE OR REPLACE FUNCTION current_user_role() RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.user_role', true);
$$;

CREATE OR REPLACE FUNCTION current_user_id() RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.user_id', true)::UUID;
$$;

CREATE POLICY company_isolation ON companies
  USING (id = current_company_id());

CREATE POLICY users_isolation ON users
  USING (company_id = current_company_id() OR id = current_user_id());

CREATE POLICY properties_isolation ON properties
  USING (company_id = current_company_id());

CREATE POLICY units_isolation ON units
  USING (property_id IN (SELECT id FROM properties WHERE company_id = current_company_id()));

CREATE POLICY leases_isolation_staff ON leases
  USING (company_id = current_company_id() AND current_user_role() IN ('owner','property_manager','accountant'));
CREATE POLICY leases_isolation_renter ON leases
  USING (renter_id = current_user_id());

CREATE POLICY signatures_isolation ON lease_signatures
  USING (lease_id IN (SELECT id FROM leases WHERE company_id = current_company_id())
         OR signer_user_id = current_user_id());

CREATE POLICY invoices_isolation_staff ON invoices
  USING (company_id = current_company_id() AND current_user_role() IN ('owner','property_manager','accountant'));
CREATE POLICY invoices_isolation_renter ON invoices
  USING (lease_id IN (SELECT id FROM leases WHERE renter_id = current_user_id()));

CREATE POLICY payments_isolation_staff ON payments
  USING (company_id = current_company_id() AND current_user_role() IN ('owner','property_manager','accountant'));
CREATE POLICY payments_isolation_renter ON payments
  USING (invoice_id IN (SELECT i.id FROM invoices i JOIN leases l ON l.id = i.lease_id WHERE l.renter_id = current_user_id()));

CREATE POLICY ledger_isolation ON ledger_entries
  USING (company_id = current_company_id() AND current_user_role() IN ('owner','accountant'));

CREATE POLICY tickets_isolation_staff ON maintenance_tickets
  USING (company_id = current_company_id() AND current_user_role() IN ('owner','property_manager'));
CREATE POLICY tickets_isolation_renter ON maintenance_tickets
  USING (reported_by = current_user_id());

CREATE POLICY attachments_isolation ON ticket_attachments
  USING (ticket_id IN (
    SELECT id FROM maintenance_tickets
    WHERE company_id = current_company_id() OR reported_by = current_user_id()
  ));

CREATE POLICY subscriptions_isolation ON subscriptions
  USING (company_id = current_company_id() AND current_user_role() = 'owner');

CREATE POLICY audit_isolation ON audit_log
  USING (company_id = current_company_id() AND current_user_role() = 'owner');

CREATE POLICY payment_configs_isolation ON company_payment_configs
  USING (company_id = current_company_id() AND current_user_role() = 'owner');

-- ============================================================
-- TRIGGERS
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DO $$ DECLARE t TEXT; BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'companies','users','properties','units','leases','invoices',
    'payments','maintenance_tickets','subscriptions','company_payment_configs'
  ]) LOOP
    EXECUTE format('CREATE TRIGGER trg_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
  END LOOP;
END $$;
