# Rental SaaS — backend payment layer

This is the payments subsystem from the architecture/schema discussion:
database schema, the `PaymentProvider` abstraction, and one real + three
honestly-flagged adapter skeletons for Mozambique, Angola, and South
Africa.

**Read `PAYMENT_PROVIDERS_STATUS.md` first.** It draws the exact line
between what's verified against real provider documentation (Paystack,
the schema, the interface) and what's a structurally-correct skeleton
still needing confirmation against real vendor docs (Paysuite, AppyPay,
Ozow).

## What's here

```
db/migrations/001_initial_schema.sql   — full schema: companies, users,
                                          properties, units, leases,
                                          invoices, payments, double-entry
                                          ledger, maintenance tickets,
                                          subscriptions, RLS policies

src/i18n/
  i18n.types.ts                        — Locale type + compile-time key-path checking
  i18n.service.ts                      — t(key, locale, vars?) resolver
  locales/en.ts, locales/pt.ts         — translation resources, namespaced
                                          by domain (status words like
                                          'pending' collide across tables
                                          if not namespaced)

src/notifications/
  email.service.ts                     — locale comes from the RECIPIENT's
                                          own users.locale, never the
                                          company's country default

src/payments/
  payment-provider.interface.ts        — the contract every country adapter implements
  payment-provider.factory.ts          — picks the right adapter per company + method
  payment-webhooks.controller.ts       — the ONLY place that finalizes a payment
  payments.repository.ts               — data access for the payments table
  company-payment-config.repository.ts — resolves per-company provider credentials
  providers/
    paystack.provider.ts               — verified (South Africa, cards)
    paysuite.provider.ts               — skeleton, needs confirming (Mozambique)
    appypay.provider.ts                — skeleton, needs confirming (Angola)
    ozow.provider.ts                   — skeleton, needs confirming (South Africa, EFT)

src/ledger/ledger.service.ts           — posts real double-entry pairs
src/crypto/secrets.service.ts          — AES-256-GCM credential encryption (dev-grade; swap master key source for real KMS in production)
```

## Language

Product UI (web admin + mobile app) supports both Portuguese and
English — the user picks at signup, stored in `users.locale` (`'pt'` or
`'en'`). Database enums and code stay English internally regardless of
which locale a given user sees, so adding a third language later is a
new `locales/xx.ts` file, never a schema migration. See
`src/i18n/i18n.types.ts` — the `satisfies TranslationKeys` check on
`pt.ts` means a missing or mistyped translation key fails the build
instead of shipping a blank string.

## What's NOT here yet

This is the payments + i18n slice only — not the full NestJS app.
Missing: auth module (including the signup-flow UI that asks the user to
pick a locale — the backend supports it, but nothing prompts for it
yet), the tenancy guard middleware (sets `app.company_id` per request —
referenced in the schema's RLS policy comments but not yet implemented
as code), leases/properties/units CRUD modules, the maintenance ticket
module, and the React web + React Native clients. Those follow the same
module-per-domain pattern established here.

## Before running this for real

1. `npm install`
2. Set `ENCRYPTION_MASTER_KEY` (32 random bytes, base64-encoded —
   `openssl rand -base64 32`) and a Postgres connection string in your
   environment.
3. Run the migration against a real Postgres instance.
4. For Paysuite/AppyPay/Ozow: do the verification steps in
   `PAYMENT_PROVIDERS_STATUS.md` before any of those three see real money.
# rentalcore
