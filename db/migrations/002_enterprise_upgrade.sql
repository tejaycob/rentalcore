-- =====================================================================
-- RentalCore (System A) — migration 002: enterprise upgrade
--
-- Applies to: ~/Developer/rentalcore, database `rentalcore`.
-- NOT for System B (~/Projects/rentcore) — different schema entirely.
--
-- Adds: per-company currency wiring, rent due day + due-date maths,
-- a data-driven late-fee engine, tenant identity/verification fields,
-- deposit lifecycle, utilities + meter readings, and a document vault.
--
-- Design rules followed here:
--   * Non-destructive. Nothing is dropped or rewritten; every change is
--     additive, and every new "delete" is a soft delete (deleted_at).
--   * Policy is DATA, not code. Late-fee tiers live in a table so they
--     can differ per company (MZ vs ZA vs AO) and be changed without a
--     migration or a redeploy.
--   * Safe to run on a database that already has live leases: every new
--     column is either nullable or has a default, so existing rows stay
--     valid.
--
-- Apply inside a transaction. See the header of section 0 for a
-- rehearsal command that applies and rolls back without committing.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. Guard: refuse to run twice
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'leases' AND column_name = 'rent_due_day') THEN
    RAISE EXCEPTION 'Migration 002 appears to have been applied already (leases.rent_due_day exists). Aborting.';
  END IF;
END $$;


-- =====================================================================
-- 1. CURRENCY
--
-- One currency per client company is the model: Magalela reports in MZN,
-- ETM South Africa in ZAR, an Angolan entity in AOA. Because a company
-- never mixes currencies, there is no cross-currency aggregation and
-- therefore no FX rate table — totals are always summed within a single
-- currency, which is what makes the dashboard figures meaningful.
--
-- Property and lease overrides exist for the rare case (a company that
-- genuinely holds one asset abroad). Resolution order is:
--   lease.currency -> property.currency -> company.currency
-- =====================================================================

ALTER TABLE companies
  ADD CONSTRAINT companies_currency_check
  CHECK (currency IN ('MZN','ZAR','AOA','USD','EUR'));

ALTER TABLE properties
  ADD COLUMN currency TEXT
    CHECK (currency IS NULL OR currency IN ('MZN','ZAR','AOA','USD','EUR'));

ALTER TABLE leases
  ADD COLUMN currency TEXT
    CHECK (currency IS NULL OR currency IN ('MZN','ZAR','AOA','USD','EUR'));

COMMENT ON COLUMN properties.currency IS
  'Optional override. NULL means inherit companies.currency.';
COMMENT ON COLUMN leases.currency IS
  'Optional override. NULL means inherit property, then company.';

-- Resolves the effective currency for a lease in one place, so the API
-- and any report cannot disagree about it.
CREATE OR REPLACE FUNCTION lease_currency(p_lease_id UUID) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(l.currency, p.currency, c.currency)
  FROM leases l
  JOIN units u      ON u.id = l.unit_id
  JOIN properties p ON p.id = u.property_id
  JOIN companies c  ON c.id = l.company_id
  WHERE l.id = p_lease_id;
$$;


-- =====================================================================
-- 2. RENT DUE DAY + DUE-DATE MATHS
--
-- The ETM Mozambique contract says rent is paid in advance, due by day
-- 05 of each month. That is independent of the lease start date: a lease
-- starting on the 21st still bills on the 5th.
--
-- Long-term rentals are billed in whole months, so there is no
-- proration. companies.proration_method is recorded anyway, defaulting
-- to 'none', so a future client who prorates can be supported by
-- changing a row rather than shipping a migration.
-- =====================================================================

ALTER TABLE leases
  ADD COLUMN rent_due_day SMALLINT NOT NULL DEFAULT 5
    CHECK (rent_due_day BETWEEN 1 AND 31);

ALTER TABLE companies
  ADD COLUMN proration_method TEXT NOT NULL DEFAULT 'none'
    CHECK (proration_method IN ('none','actual_days','thirty_day_month'));

COMMENT ON COLUMN leases.rent_due_day IS
  'Day of month rent falls due, independent of start_date. Clamped to the last day for short months — see invoice_due_date().';

-- Clamps to the last day of the month, so a due day of 31 becomes the
-- 28th/29th in February instead of erroring or silently rolling into
-- March. Without this, "overdue" is wrong for four months of the year.
CREATE OR REPLACE FUNCTION invoice_due_date(p_period TEXT, p_due_day SMALLINT)
RETURNS DATE
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_month_start DATE;
  v_last_day    SMALLINT;
BEGIN
  v_month_start := to_date(p_period || '-01', 'YYYY-MM-DD');
  v_last_day    := EXTRACT(DAY FROM (date_trunc('month', v_month_start)
                                     + INTERVAL '1 month - 1 day'))::SMALLINT;
  RETURN v_month_start + (LEAST(p_due_day, v_last_day) - 1);
END $$;


-- =====================================================================
-- 3. LATE-FEE ENGINE
--
-- ETM's Mozambique contract:
--   * delay of  5–15 days -> 20% of rent
--   * delay of 15–30 days -> penalty "acrescida em 30% sobre o valor da
--     renda"
--   * delay over 30 days  -> grounds for unilateral termination
--
-- [A CONFIRMAR] The tier-2 wording is ambiguous between a 50% total
-- (20% + 30%) and a flat 30%. The seed below uses 50%, since "sobre o
-- valor da renda" anchors the 30% to the rent rather than to the fine.
-- This is a SEEDED ROW, not a hardcoded rule — if the intended reading
-- is 30%, change it with:
--     UPDATE late_fee_policies SET percent_of_rent = 30.00
--      WHERE tier = 2 AND company_id = '<id>';
-- No migration, no redeploy.
--
-- Day counting: min_days_late is measured from the invoice due_date, so
-- with a due day of 5, tier 1 begins to bite on day 10 of the month.
-- =====================================================================

CREATE TABLE late_fee_policies (
  id               UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tier             SMALLINT NOT NULL,
  min_days_late    SMALLINT NOT NULL,
  max_days_late    SMALLINT,               -- NULL = open ended
  percent_of_rent  NUMERIC(5,2) NOT NULL DEFAULT 0,
  terminable       BOOLEAN NOT NULL DEFAULT false,
  description      TEXT,
  active           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, tier),
  CHECK (max_days_late IS NULL OR max_days_late > min_days_late),
  CHECK (percent_of_rent >= 0 AND percent_of_rent <= 1000)
);

CREATE INDEX idx_late_fee_policies_company ON late_fee_policies(company_id) WHERE active;

COMMENT ON TABLE late_fee_policies IS
  'Late-payment penalty tiers, per company. Data not code, so MZ/ZA/AO can differ and rules change without a deploy.';

-- Seed every existing company with the Mozambique contract tiers.
INSERT INTO late_fee_policies (company_id, tier, min_days_late, max_days_late, percent_of_rent, terminable, description)
SELECT c.id, 1,  5, 15,  20.00, false, 'Atraso de 5 a 15 dias — multa de 20% sobre o valor da renda'
FROM companies c
UNION ALL
SELECT c.id, 2, 15, 30,  50.00, false, 'Atraso de 15 a 30 dias — multa acrescida [A CONFIRMAR: 50% total ou 30%]'
FROM companies c
UNION ALL
SELECT c.id, 3, 30, NULL, 50.00, true,  'Atraso superior a 30 dias — rescisão unilateral do contrato'
FROM companies c;

-- Invoice-level penalty state.
ALTER TABLE invoices
  ADD COLUMN late_fee_amount      DECIMAL(12,2) NOT NULL DEFAULT 0
    CHECK (late_fee_amount >= 0),
  ADD COLUMN late_fee_tier        SMALLINT,
  ADD COLUMN days_late            INTEGER,
  ADD COLUMN late_fee_calculated_at TIMESTAMPTZ;

-- Kept as a stored generated column so no caller can ever forget to add
-- the penalty when totalling an invoice.
ALTER TABLE invoices
  ADD COLUMN amount_total DECIMAL(12,2)
    GENERATED ALWAYS AS (amount_due + late_fee_amount) STORED;

COMMENT ON COLUMN invoices.amount_total IS
  'amount_due + late_fee_amount, maintained by Postgres. Always bill from this, never from amount_due alone.';

-- Returns the penalty that applies to a given lateness, per company
-- policy. Returns no row when nothing applies (paid on time, or within
-- the grace window before tier 1).
CREATE OR REPLACE FUNCTION calculate_late_fee(
  p_company_id UUID,
  p_rent       DECIMAL,
  p_days_late  INTEGER
)
RETURNS TABLE (tier SMALLINT, percent_of_rent NUMERIC, fee_amount DECIMAL, terminable BOOLEAN)
LANGUAGE sql STABLE AS $$
  SELECT p.tier,
         p.percent_of_rent,
         ROUND(p_rent * p.percent_of_rent / 100.0, 2)::DECIMAL,
         p.terminable
  FROM late_fee_policies p
  WHERE p.company_id = p_company_id
    AND p.active
    AND p_days_late >= p.min_days_late
    AND (p.max_days_late IS NULL OR p_days_late < p.max_days_late)
  ORDER BY p.tier DESC
  LIMIT 1;
$$;


-- =====================================================================
-- 4. TENANT IDENTITY & VERIFICATION
--
-- Required for valid Mozambican invoicing (NUIT) and for any legal
-- action (BI / Passport / DIRE). Employment and next-of-kin details are
-- risk mitigation: who to call if the tenant vanishes.
-- =====================================================================

ALTER TABLE users
  ADD COLUMN id_type   TEXT
    CHECK (id_type IS NULL OR id_type IN ('BI','Passport','DIRE','NUIT','Other')),
  ADD COLUMN id_number TEXT,
  ADD COLUMN nuit      TEXT,
  ADD COLUMN employer_name TEXT,
  ADD COLUMN occupation    TEXT,
  ADD COLUMN work_phone    TEXT,
  ADD COLUMN emergency_contact_name         TEXT,
  ADD COLUMN emergency_contact_relationship TEXT,
  ADD COLUMN emergency_contact_phone        TEXT;

-- An emergency contact that rings the tenant's own phone is useless.
-- NULLs pass, so this only fires when both are actually provided.
ALTER TABLE users
  ADD CONSTRAINT users_emergency_phone_differs
  CHECK (emergency_contact_phone IS NULL
         OR phone IS NULL
         OR emergency_contact_phone <> phone);

CREATE INDEX idx_users_nuit ON users(nuit) WHERE nuit IS NOT NULL;

COMMENT ON COLUMN users.nuit IS
  'Mozambican taxpayer number. Required on a valid factura — invoices cannot be issued to a tenant without it.';


-- =====================================================================
-- 5. DEPOSIT LIFECYCLE
--
-- The tenant's refund bank details are the TENANT's private data, so
-- they are stored encrypted at the application layer exactly like
-- payment provider credentials (see crypto/secrets.service.ts).
-- The company's OWN bank details in section 7 are deliberately
-- plaintext — those get printed on every invoice.
-- =====================================================================

ALTER TABLE leases
  ADD COLUMN deposit_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (deposit_status IN ('pending','paid','held','refunded','forfeited')),
  ADD COLUMN deposit_paid_at     TIMESTAMPTZ,
  ADD COLUMN deposit_refunded_at TIMESTAMPTZ,
  ADD COLUMN deposit_refund_amount DECIMAL(12,2)
    CHECK (deposit_refund_amount IS NULL OR deposit_refund_amount >= 0),
  ADD COLUMN deposit_refund_bank_encrypted BYTEA;

COMMENT ON COLUMN leases.deposit_refund_bank_encrypted IS
  'Tenant bank details for deposit refund. AES-256-GCM at the app layer — never write plaintext here.';


-- =====================================================================
-- 6. UTILITIES, METERS, LEASE ADMIN
-- =====================================================================

ALTER TABLE leases
  ADD COLUMN utilities_water       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN utilities_electricity BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN utilities_wifi        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN utilities_trash       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN notice_period_days SMALLINT NOT NULL DEFAULT 30
    CHECK (notice_period_days >= 0),
  ADD COLUMN next_review_date DATE,
  ADD COLUMN rent_discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0
    CHECK (rent_discount_amount >= 0),
  ADD COLUMN rent_discount_reason TEXT;

COMMENT ON COLUMN leases.rent_discount_amount IS
  'Agreed reduction against headline rent (e.g. tenant-funded improvements). Invoices bill rent_amount - rent_discount_amount.';
COMMENT ON COLUMN leases.next_review_date IS
  'Annual rent review date, so the system flags it rather than relying on memory.';

-- Meter readings are a history, not a single value: move-in, move-out
-- and any reading in between, never overwritten.
CREATE TABLE meter_readings (
  id           UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  unit_id      UUID NOT NULL REFERENCES units(id),
  lease_id     UUID REFERENCES leases(id),
  meter_type   TEXT NOT NULL CHECK (meter_type IN ('electricity','water','gas')),
  reading      NUMERIC(14,3) NOT NULL CHECK (reading >= 0),
  reading_at   DATE NOT NULL DEFAULT CURRENT_DATE,
  context      TEXT NOT NULL DEFAULT 'periodic'
    CHECK (context IN ('move_in','move_out','periodic')),
  notes        TEXT,
  recorded_by  UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_meter_readings_unit  ON meter_readings(unit_id, meter_type, reading_at DESC);
CREATE INDEX idx_meter_readings_lease ON meter_readings(lease_id) WHERE lease_id IS NOT NULL;


-- =====================================================================
-- 7. COMPANY INVOICING / PAYMENT DETAILS
--
-- These are the landlord's own details, printed on every invoice so the
-- tenant knows where to pay. Plaintext is correct here — this
-- information is published to tenants by design.
-- =====================================================================

ALTER TABLE companies
  ADD COLUMN bank_name            TEXT,
  ADD COLUMN bank_account_name    TEXT,
  ADD COLUMN bank_account_number  TEXT,
  ADD COLUMN bank_nib             TEXT,
  ADD COLUMN payment_instructions TEXT,
  ADD COLUMN invoice_footer       TEXT;

COMMENT ON COLUMN companies.bank_nib IS
  'NIB for Mozambican bank transfers. Printed on invoices — intentionally not encrypted.';


-- =====================================================================
-- 8. DOCUMENT VAULT
--
-- Metadata only. Files live in object storage (R2/S3) and are served
-- via short-lived signed URLs; identity documents must never sit in the
-- database or behind a public URL.
--
-- Soft delete only, per the never-destructive rule.
-- =====================================================================

CREATE TABLE documents (
  id            UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('lease','user','unit','property','invoice','payment','ticket')),
  entity_id     UUID NOT NULL,
  doc_type      TEXT NOT NULL CHECK (doc_type IN
                  ('lease_signed','id_document','proof_of_payment','inspection','invoice_pdf','statement','other')),
  storage_key   TEXT NOT NULL,
  filename      TEXT NOT NULL,
  mime_type     TEXT,
  size_bytes    BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
  uploaded_by   UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

CREATE INDEX idx_documents_entity  ON documents(entity_type, entity_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_documents_company ON documents(company_id) WHERE deleted_at IS NULL;

COMMENT ON COLUMN documents.storage_key IS
  'Object storage key. Never a public URL — issue a short-lived signed URL per request.';


-- =====================================================================
-- 9. ROW LEVEL SECURITY for the new tables
--
-- Matches the pattern in 001. Note these policies are inert while the
-- app connects as the table owner (Postgres exempts owners from RLS
-- unless FORCE ROW LEVEL SECURITY is set). They are here so that
-- switching to a non-owner application role later is a one-line change
-- rather than a security review. Isolation today is the explicit
-- company_id filter in every service query.
-- =====================================================================

ALTER TABLE late_fee_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter_readings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents         ENABLE ROW LEVEL SECURITY;

CREATE POLICY company_isolation ON late_fee_policies
  USING (company_id = current_company_id());
CREATE POLICY company_isolation ON meter_readings
  USING (company_id = current_company_id());
CREATE POLICY company_isolation ON documents
  USING (company_id = current_company_id());


-- =====================================================================
-- 10. updated_at triggers for the new tables
-- =====================================================================

CREATE TRIGGER trg_updated_at BEFORE UPDATE ON late_fee_policies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON meter_readings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- =====================================================================
-- 11. Backfill existing leases with sane defaults
--
-- Existing rows already picked up rent_due_day = 5 from the column
-- default. Set the annual review date one year from lease start so the
-- review flag is meaningful immediately rather than NULL everywhere.
-- =====================================================================

UPDATE leases
   SET next_review_date = start_date + INTERVAL '1 year'
 WHERE next_review_date IS NULL;

COMMIT;
