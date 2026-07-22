-- =====================================================================
-- RentalCore (System A) — migration 004: platform administration
--
-- Applies to: ~/Developer/rentalcore, database `rentalcore`.
-- Requires 001–003.
--
-- WHAT THIS CHANGES, AND WHY
--
-- Until now every user belonged to exactly one company (users.company_id
-- NOT NULL) and the highest role was 'owner' — owner of ONE client. There
-- was no Teja Solutions level: nobody could see across clients, suspend
-- one, or track who had signed up.
--
-- This adds that layer:
--   * a 'platform_admin' role whose users sit OUTSIDE any company
--   * invite tokens, so clients are provisioned rather than self-serving
--   * subscription state on companies, enforced at login
--
-- Self-serve registration is closed by the application layer in the same
-- release: /auth/register is replaced by /auth/accept-invite.
-- =====================================================================

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'invites') THEN
    RAISE EXCEPTION 'Migration 004 appears to have been applied already.';
  END IF;
END $$;


-- =====================================================================
-- 1. PLATFORM ADMIN ROLE
--
-- A platform admin belongs to no company, so company_id must be nullable.
-- The CHECK below keeps that from becoming a loophole: every row is
-- either attached to a company, or is explicitly a platform admin.
-- Nothing can be neither.
-- =====================================================================

ALTER TABLE users ALTER COLUMN company_id DROP NOT NULL;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('platform_admin','owner','property_manager','accountant','renter'));

ALTER TABLE users
  ADD CONSTRAINT users_company_or_platform
  CHECK (
    (role = 'platform_admin' AND company_id IS NULL)
    OR
    (role <> 'platform_admin' AND company_id IS NOT NULL)
  );

COMMENT ON COLUMN users.company_id IS
  'NULL only for platform_admin — enforced by users_company_or_platform. Every tenant user belongs to exactly one company.';

CREATE INDEX idx_users_platform_admin ON users(email) WHERE role = 'platform_admin';


-- =====================================================================
-- 2. SUBSCRIPTION LIFECYCLE ON COMPANIES
--
-- companies.trial_ends_at already existed but nothing read it. These
-- columns make the state explicit and enforceable at login:
--
--   trialing  -> full access until trial_ends_at
--   active    -> full access until paid_until
--   past_due  -> read-only (they can see their data, not change it)
--   suspended -> no access at all
--
-- Collection is manual for now: you invoice by bank transfer and set
-- paid_until when the money lands. Enforcement is automatic even though
-- collection isn't.
-- =====================================================================

ALTER TABLE companies
  ADD COLUMN subscription_status TEXT NOT NULL DEFAULT 'trialing'
    CHECK (subscription_status IN ('trialing','active','past_due','suspended','cancelled')),
  ADD COLUMN paid_until DATE,
  ADD COLUMN suspended_at TIMESTAMPTZ,
  ADD COLUMN suspended_reason TEXT,
  ADD COLUMN unit_limit INTEGER CHECK (unit_limit IS NULL OR unit_limit > 0),
  ADD COLUMN notes TEXT;

COMMENT ON COLUMN companies.paid_until IS
  'Set manually when payment is received. Past this date the company moves to past_due (read-only).';
COMMENT ON COLUMN companies.unit_limit IS
  'NULL = unlimited. Enforced when creating units, so plan tiers mean something.';
COMMENT ON COLUMN companies.notes IS
  'Platform-admin only. Never exposed to the client.';

-- Existing companies keep working: they are on trial until whatever
-- trial_ends_at already said, defaulting to 30 days from now.
UPDATE companies
   SET trial_ends_at = COALESCE(trial_ends_at, now() + interval '30 days'),
       subscription_status = 'trialing'
 WHERE subscription_status = 'trialing';


-- =====================================================================
-- 3. INVITES
--
-- Replaces self-serve signup. A platform admin invites a client's first
-- owner; a company owner invites their own staff and tenants.
--
-- Only the HASH of the token is stored — the same reasoning as password
-- storage and refresh tokens. A leaked database backup must not hand
-- someone a working invite link.
-- =====================================================================

CREATE TABLE invites (
  id           UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  email        TEXT NOT NULL,
  name         TEXT,
  role         TEXT NOT NULL
    CHECK (role IN ('platform_admin','owner','property_manager','accountant','renter')),
  -- NULL company_id = an invite to become a platform admin
  company_id   UUID REFERENCES companies(id) ON DELETE CASCADE,
  invited_by   UUID REFERENCES users(id),
  expires_at   TIMESTAMPTZ NOT NULL,
  accepted_at  TIMESTAMPTZ,
  accepted_user_id UUID REFERENCES users(id),
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Same shape rule as users: a platform-admin invite has no company.
  CHECK (
    (role = 'platform_admin' AND company_id IS NULL)
    OR
    (role <> 'platform_admin' AND company_id IS NOT NULL)
  )
);

CREATE INDEX idx_invites_email   ON invites(lower(email));
CREATE INDEX idx_invites_company ON invites(company_id) WHERE accepted_at IS NULL AND revoked_at IS NULL;

COMMENT ON COLUMN invites.token_hash IS
  'SHA-256 of the invite token. The raw token exists only in the emailed link.';

CREATE TRIGGER trg_updated_at BEFORE UPDATE ON invites
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- =====================================================================
-- 4. LOGIN AUDIT
--
-- "Who registered and who is actually using it" needs data, not guesses.
-- Every login attempt is recorded, successful or not — which also gives
-- you a brute-force signal for free.
-- =====================================================================

CREATE TABLE login_events (
  id           UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id      UUID REFERENCES users(id),
  company_id   UUID REFERENCES companies(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  success      BOOLEAN NOT NULL,
  failure_reason TEXT,
  ip_address   TEXT,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_login_events_user    ON login_events(user_id, created_at DESC);
CREATE INDEX idx_login_events_company ON login_events(company_id, created_at DESC);
CREATE INDEX idx_login_events_failed  ON login_events(email, created_at DESC) WHERE NOT success;

COMMENT ON TABLE login_events IS
  'Append-only login audit. Feeds the platform console: last seen, active clients, failed-attempt spikes.';


-- =====================================================================
-- 5. PLATFORM OVERVIEW
--
-- One query behind the console, so the list page cannot drift from
-- whatever the API happens to compute that week.
-- =====================================================================

CREATE OR REPLACE VIEW v_platform_companies AS
SELECT c.id,
       c.name,
       c.country_code,
       c.currency,
       c.plan_tier,
       c.subscription_status,
       c.trial_ends_at,
       c.paid_until,
       c.active,
       c.suspended_at,
       c.unit_limit,
       c.created_at,
       (SELECT COUNT(*) FROM users u
         WHERE u.company_id = c.id AND u.active AND u.role <> 'renter')  AS staff_count,
       (SELECT COUNT(*) FROM users u
         WHERE u.company_id = c.id AND u.active AND u.role  = 'renter')  AS tenant_count,
       (SELECT COUNT(*) FROM units un
          JOIN properties p ON p.id = un.property_id
         WHERE p.company_id = c.id)                                      AS unit_count,
       (SELECT COUNT(*) FROM leases l
         WHERE l.company_id = c.id AND l.status = 'active')              AS active_leases,
       (SELECT COALESCE(SUM(i.amount_total), 0) FROM invoices i
         WHERE i.company_id = c.id)                                      AS total_billed,
       (SELECT MAX(le.created_at) FROM login_events le
         WHERE le.company_id = c.id AND le.success)                      AS last_login_at
FROM companies c;

COMMENT ON VIEW v_platform_companies IS
  'Platform console list. Platform-admin only — never expose to tenant users.';

COMMIT;
