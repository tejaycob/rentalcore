# Installation guide — Rental SaaS backend

This covers the payments + i18n slice that exists today: database schema,
the `PaymentProvider` abstraction, one verified adapter (Paystack), three
honestly-flagged skeleton adapters (Paysuite, AppyPay, Ozow), and the
NestJS wiring that makes it an actual bootable app.

**Not included yet**, and so not covered here: auth, the tenancy guard,
leases/properties/units CRUD, the React web app, the React Native app.
See `README.md` → "What's NOT here yet" for the current boundary.

---

## Prerequisites

| Tool | Minimum version | Get it from |
|---|---|---|
| Node.js | 18.18+ (20+ recommended) | https://nodejs.org |
| npm | 9+ (ships with Node) | — |
| PostgreSQL | 14+ | https://www.postgresql.org/download, or a managed instance (Supabase, Railway, RDS) |
| Git | any | https://git-scm.com |

---

## Step 1 — Get a Postgres database

Any Postgres 14+ instance works — local, Docker, or managed. Two quick options:

**Local via Docker:**
```bash
docker run --name rental-saas-db \
  -e POSTGRES_PASSWORD=devpassword \
  -e POSTGRES_DB=rental_saas \
  -p 5432:5432 -d postgres:16
```

**Or use a managed free tier** (Supabase, Railway, Neon) and copy the
connection string they give you — either way you need one
`DATABASE_URL` by the end of this step.

---

## Step 2 — Run the schema migration

```bash
psql "$DATABASE_URL" -f db/migrations/001_initial_schema.sql
```

If you used the Docker command above, your connection string is:
```bash
psql "postgresql://postgres:devpassword@localhost:5432/rental_saas" \
  -f db/migrations/001_initial_schema.sql
```

This creates all 13 tables, the double-entry ledger constraints, the
Row Level Security policies, and the `current_company_id()` /
`current_user_role()` / `current_user_id()` helper functions the
policies depend on.

> The RLS policies will silently block every query until the tenancy
> guard (not yet built — see README) sets `app.company_id` /
> `app.user_role` / `app.user_id` per request via `SET LOCAL`. Until
> that exists, anything you test manually against this database needs
> to set those session variables yourself in `psql`, e.g.:
> ```sql
> SET LOCAL app.company_id = '00000000-0000-0000-0000-000000000000';
> SET LOCAL app.user_role = 'owner';
> ```

---

## Step 3 — Install dependencies

```bash
cd rental-saas
npm install
```

---

## Step 4 — Configure environment variables

```bash
cp .env.example .env
```

Edit `.env`:

```bash
DATABASE_URL=postgresql://postgres:devpassword@localhost:5432/rental_saas
PORT=3000

# Generate with: openssl rand -base64 32
ENCRYPTION_MASTER_KEY=
```

`ENCRYPTION_MASTER_KEY` must decode to exactly 32 bytes — the command
above produces that. Without it, anything touching
`src/crypto/secrets.service.ts` (which `CompanyPaymentConfigRepository`
depends on) throws immediately on first use.

---

## Step 5 — Run it

```bash
npm run start:dev
```

You should see:
```
Rental SaaS backend listening on port 3000
```

If it crashes instead, the two most likely causes at this stage are:
`DATABASE_URL` unset or unreachable, or `ENCRYPTION_MASTER_KEY` missing
or not valid base64 of exactly 32 bytes.

There is no `GET /` route defined yet — a 404 on the root path is
expected. The real routes that exist right now are the four webhook
endpoints below.

---

## Step 6 — Verify the webhook routes respond

These won't *succeed* yet (no company has payment credentials configured,
and Paysuite/AppyPay/Ozow's signature checks are unverified skeletons —
see `PAYMENT_PROVIDERS_STATUS.md`), but they should respond with a 400
rather than a 404 or a 500 crash, confirming the routing and raw-body
wiring is correct:

```bash
curl -i -X POST http://localhost:3000/webhooks/paystack \
  -H "Content-Type: application/json" \
  -d '{"event":"charge.success","data":{}}'
```

Expected: `400 Bad Request` with a JSON body like
`{"error":"Missing x-paystack-signature header"}`. That 400 is correct
behavior — it means the controller, the raw-body middleware, and the
Paystack adapter's signature check are all wired correctly and rejecting
an unsigned request, exactly as they should.

A `404` here would mean a module failed to register — check the
`npm run start:dev` console output for a NestJS dependency-injection
error, which prints the exact missing provider.

---

## Step 7 — Before connecting any real payment provider

Read `PAYMENT_PROVIDERS_STATUS.md` in full. Specifically, **do not**
flip any company's `company_payment_configs.is_live` to `true`, and
**do not** point a real provider's webhook at this server, until:

1. Paysuite, AppyPay, and Ozow's actual API references have been
   confirmed (every `// TODO: confirm` comment in
   `src/payments/providers/*.provider.ts` resolved against real vendor
   docs — Paysuite's blocks automated access, so request their
   reference directly from their support team).
2. You've run at least one real test transaction through each
   provider's sandbox and compared the actual webhook payload against
   what each adapter expects.

Paystack is the one adapter built against confirmed, current
documentation — safe to test against their real sandbox once you have
a test secret key and webhook secret, encrypted and stored per the
schema's `company_payment_configs` table (no onboarding UI exists yet
to do this for you — it's a direct database insert at this stage).

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `DATABASE_URL is not set` on startup | `.env` not created, or missing that key | Confirm Step 4 — `.env` must exist in the project root; `@nestjs/config` loads it automatically on startup |
| `ENCRYPTION_MASTER_KEY must decode to exactly 32 bytes` | Key wasn't generated correctly | Re-run `openssl rand -base64 32`, paste the full output including any trailing `=` |
| Postgres `permission denied` or RLS silently returns zero rows | Session variables not set | Expected until the tenancy guard exists — see the note in Step 2 |
| `relation "companies" does not exist` | Migration didn't run, or ran against the wrong database | Re-run Step 2, double check `DATABASE_URL` points at the same database |
| Webhook route returns 404 | A module failed to register | Check `npm run start:dev` console for a NestJS DI error naming the missing provider |
