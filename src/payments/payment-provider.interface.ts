// src/payments/payment-provider.interface.ts
//
// Every country's real payment rail (Paysuite for Mozambique, AppyPay for
// Angola, Ozow + Paystack for South Africa) implements this same contract.
// Application code — invoice generation, the mobile "Pay rent" button, the
// ledger — only ever talks to this interface. It never knows which real
// provider is behind it.
//
// This is the boundary referenced in the architecture diagram: one
// internal contract, swappable adapters per country.

export type PaymentMethod =
  | 'mpesa' | 'emola' | 'mkesh'        // Mozambique wallets (via Paysuite)
  | 'multicaixa' | 'unitel_money'      // Angola (via AppyPay)
  | 'eft'                              // South Africa bank transfer (via Ozow)
  | 'card';                            // any country, card rails differ underneath

export type PaymentStatus = 'initiated' | 'pending' | 'succeeded' | 'failed' | 'refunded';

export interface PaymentSession {
  /** Our own payments.id — created before calling the provider, so we always
   *  have a row to reconcile against even if the provider call never completes. */
  internalPaymentId: string;
  /** Provider's reference for this attempt. Null until the provider responds. */
  providerPaymentId: string | null;
  /** Where to send the customer, if the provider flow is redirect-based
   *  (Ozow, Paystack checkout). Null for STK-push style flows (Paysuite
   *  M-Pesa/e-Mola, which prompt directly on the phone — no redirect needed). */
  redirectUrl: string | null;
  status: PaymentStatus;
}

export interface PaymentWebhookResult {
  /** Our internal payments.id this event refers to — resolved by matching
   *  providerPaymentId against the payments table, never trusted blindly
   *  from the payload. */
  internalPaymentId: string;
  status: PaymentStatus;
  amount: number;
  currency: string;
  /** The raw payload, stored as-is in payments.raw_webhook_payload for
   *  audit/dispute purposes. Every adapter must capture this. */
  rawPayload: Record<string, unknown>;
}

export interface CreatePaymentParams {
  invoiceId: string;
  amount: number;
  currency: string;
  method: PaymentMethod;
  /** Required for STK-push style wallet flows where the provider prompts
   *  the customer's own phone directly (Paysuite). Optional for redirect
   *  flows (Ozow, Paystack) where the customer enters it on a hosted page. */
  payerPhoneNumber?: string;
  payerEmail?: string;
  /** Used to build the redirect-back URL for hosted checkout flows. */
  returnUrl?: string;
}

export interface PaymentProvider {
  readonly providerName: 'paysuite' | 'appypay' | 'ozow' | 'paystack';

  /** Which payment methods this concrete provider actually handles.
   *  Used by the factory below to pick the right adapter when a company
   *  has more than one configured (South Africa: Ozow for 'eft', Paystack
   *  for 'card'). */
  readonly supportedMethods: PaymentMethod[];

  /**
   * Starts a payment attempt. MUST create the local `payments` row
   * (status: 'initiated') before calling the external provider, so a
   * crashed request still leaves a row to reconcile, rather than money
   * potentially moving with zero record on our side.
   */
  createPayment(params: CreatePaymentParams): Promise<PaymentSession>;

  /**
   * Verifies the webhook signature using this provider's specific scheme,
   * then parses the payload into our normalized shape. MUST throw if
   * signature verification fails — callers must never process an
   * unverified payload. MUST be safe to call twice with the same payload
   * (idempotent) since providers retry webhook delivery on timeout.
   */
  handleWebhook(rawBody: Buffer, headers: Record<string, string>): Promise<PaymentWebhookResult>;

  /**
   * Active reconciliation: ask the provider directly "what actually
   * happened to payment X" rather than trusting client-reported success
   * or a webhook that may never arrive. Used by a periodic job that
   * sweeps 'initiated'/'pending' payments older than N minutes.
   */
  checkStatus(providerPaymentId: string): Promise<PaymentStatus>;
}
