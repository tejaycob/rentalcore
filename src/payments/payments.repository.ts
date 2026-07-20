// src/payments/payments.repository.ts
//
// Thin data-access layer over the `payments` table. Adapters depend on
// this rather than talking to the database directly, so the row-creation
// and status-transition logic lives in exactly one place regardless of
// which provider is involved.

import { Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PaymentMethod, PaymentStatus } from './payment-provider.interface';

interface CreateInitiatedParams {
  invoiceId: string;
  provider: 'paysuite' | 'appypay' | 'ozow' | 'paystack';
  method: PaymentMethod;
  amount: number;
  currency: string;
}

interface PaymentRow {
  id: string;
  invoiceId: string;
  status: PaymentStatus;
  providerPaymentId: string | null;
  amount: number;
  currency: string;
  renterEmail: string;
  renterLocale: 'pt' | 'en';
}

@Injectable()
export class PaymentsRepository {
  constructor(private readonly pool: Pool) {}

  /** Creates the local row BEFORE any external call — see the interface's
   *  doc comment on why this ordering matters. provider_payment_id is
   *  NULL until attachProviderReference() is called once the provider
   *  responds with its own reference. Inserting NULL (not '') matters:
   *  the column has a UNIQUE(provider, provider_payment_id) constraint,
   *  and Postgres never treats two NULLs as equal for uniqueness — so
   *  multiple payments awaiting a provider reference at the same time
   *  don't collide. An empty string would have collided. */
  async createInitiated(params: CreateInitiatedParams): Promise<string> {
    const { invoiceId, provider, method, amount, currency } = params;
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, company_id, provider, provider_payment_id, method, amount, currency, status)
       SELECT $1, i.company_id, $2, NULL, $3, $4, $5, 'initiated'
       FROM invoices i WHERE i.id = $1
       RETURNING id`,
      [invoiceId, provider, method, amount, currency],
    );
    if (result.rows.length === 0) {
      throw new Error(`Cannot create payment: invoice ${invoiceId} not found`);
    }
    return result.rows[0].id;
  }

  async attachProviderReference(internalPaymentId: string, providerPaymentId: string): Promise<void> {
    await this.pool.query(
      `UPDATE payments SET provider_payment_id = $2 WHERE id = $1`,
      [internalPaymentId, providerPaymentId],
    );
  }

  async markFailed(internalPaymentId: string, context: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `UPDATE payments SET status = 'failed', raw_webhook_payload = $2 WHERE id = $1`,
      [internalPaymentId, JSON.stringify(context)],
    );
  }

  async updateStatus(
    internalPaymentId: string,
    status: PaymentStatus,
    rawPayload: Record<string, unknown>,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE payments SET status = $2, raw_webhook_payload = $3 WHERE id = $1`,
      [internalPaymentId, status, JSON.stringify(rawPayload)],
    );
  }

  async findById(internalPaymentId: string): Promise<PaymentRow | null> {
    const result = await this.pool.query<PaymentRow>(
      `SELECT p.id, p.invoice_id AS "invoiceId", p.status, p.provider_payment_id AS "providerPaymentId",
              p.amount, p.currency, u.email AS "renterEmail", u.locale AS "renterLocale"
       FROM payments p
       JOIN invoices i ON i.id = p.invoice_id
       JOIN leases l   ON l.id = i.lease_id
       JOIN users u    ON u.id = l.renter_id
       WHERE p.id = $1`,
      [internalPaymentId],
    );
    return result.rows[0] ?? null;
  }

  /** Resolves our internal payments.id from a provider's own reference —
   *  used by webhook handlers, which only know the provider's ID, never
   *  ours, until this lookup happens. Throws rather than returning null
   *  on no match: a webhook for a payment we never created is either a
   *  bug or a spoofing attempt, and callers should treat it as an error,
   *  not silently proceed with an undefined internalPaymentId. */
  async findInternalIdByProviderReference(
    provider: 'paysuite' | 'appypay' | 'ozow' | 'paystack',
    providerPaymentId: string,
  ): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM payments WHERE provider = $1 AND provider_payment_id = $2`,
      [provider, providerPaymentId],
    );
    if (result.rows.length === 0) {
      throw new Error(
        `No local payment found for ${provider} reference '${providerPaymentId}' — ` +
        `possible spoofed webhook or a payment created outside this flow`,
      );
    }
    return result.rows[0].id;
  }
}
