# Payment system — what's verified vs. what needs confirming

This file exists so nobody mistakes a structurally-correct skeleton for a
production-ready integration. Read this before touching `src/payments/`.

## Verified against real, current documentation

- **Database schema** (`db/migrations/001_initial_schema.sql`) — pure
  design, no vendor dependency. Safe to build on as-is.
- **`PaymentProvider` interface** — the contract every adapter implements.
  This shape is correct regardless of vendor specifics.
- **`PaystackProvider`** — webhook signature scheme (`x-paystack-signature`,
  HMAC-SHA512 over the raw body) is confirmed from Paystack's public
  webhook documentation. The `transaction/initialize` and
  `transaction/verify` endpoint *names* follow Paystack's well-known REST
  conventions, but I have not fetched their current field-by-field
  reference in this session — re-check `https://paystack.com/docs/api/transaction/`
  before going live, specifically the exact request/response keys.

## NOT verified — every TODO comment in these files is a real gap

- **`PaysuiteProvider`** (Mozambique — M-Pesa, e-Mola, mKesh, cards)
- **`AppyPayProvider`** (Angola — Multicaixa Express, UNITEL Money, cards)
- **`OzowProvider`** (South Africa — Instant EFT)

For all three: their official documentation either blocks automated
access (`paysuite.tech/docs` returned a robots-disallowed error when I
tried to fetch it) or simply didn't surface in search results with
enough technical detail. What I wrote is **structurally correct** — the
class implements `PaymentProvider` properly, the control flow (create
local row → call provider → verify webhook → reconcile) is sound — but
the literal things that must match a real vendor contract byte-for-byte
are placeholders:

- Exact base URL and endpoint paths
- Exact request body field names and casing
- Exact response body field names
- Exact webhook signature header name and algorithm
- Exact status string values the provider uses

## Before going live with any of the three unverified adapters

1. Sign up for a sandbox/test account directly with the provider.
2. Pull their actual API reference — Paysuite's is at `paysuite.tech/docs`
   but needs a logged-in session or direct request to their support team
   to access, since it blocks generic crawlers.
3. Replace every `// TODO: confirm` line against that real reference.
4. Run an actual test transaction through their sandbox and log the raw
   webhook payload your endpoint receives — compare it against what the
   adapter expects.
5. Only then flip `company_payment_configs.is_live` to `true` for that
   company.

## The one rule that holds regardless of which adapters are finished

The mobile app's "Pay rent" button only ever calls
`POST /payments/create`, which returns a `PaymentSession`. It never
marks an invoice paid itself. Only `PaymentWebhooksController`, after a
verified signature, does that — and the ledger only gets posted to from
that same controller. This is true even for the unverified adapters,
because it's enforced by where the code lives, not by each adapter's
internal correctness. A wrong field name will make a payment fail to
reconcile (visible, loud, safe); it cannot make the system silently
credit money that was never actually received.
