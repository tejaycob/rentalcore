// src/payments/providers/paysuite.provider.ts
//
// Mozambique: M-Pesa, e-Mola, mKesh, Ponto24, and cards — all through one
// Paysuite account (paysuite.co.mz). Confirmed from their public marketing
// page that they offer a REST API with webhooks and a single dashboard
// covering all these methods. Their detailed API reference lives at
// paysuite.tech/docs, which blocks automated fetching — I have NOT seen
// their actual endpoint paths, exact request/response field names, or
// webhook signature scheme. Every TODO below is a real gap, not a style
// choice — get their API reference from their dashboard/support before
// writing the request bodies for real, and replace the placeholders.
//
// What IS safe to treat as correct: the shape of this class (it correctly
// implements PaymentProvider), and the general flow — STK-push-style
// wallet methods need a phone number and prompt the customer directly,
// no redirect URL involved; card payments on Paysuite likely use a
// hosted page similar to Paystack's, but confirm this.

import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import {
  PaymentProvider, PaymentMethod, CreatePaymentParams,
  PaymentSession, PaymentWebhookResult, PaymentStatus,
} from '../payment-provider.interface';
import { CompanyPaymentConfigRepository } from '../company-payment-config.repository';
import { PaymentsRepository } from '../payments.repository';

// TODO: confirm against paysuite.tech/docs — placeholder, unverified.
const PAYSUITE_BASE_URL = 'https://api.paysuite.co.mz/v1';

@Injectable()
export class PaysuiteProvider implements PaymentProvider {
  readonly providerName = 'paysuite' as const;
  readonly supportedMethods: PaymentMethod[] = ['mpesa', 'emola', 'mkesh', 'card'];

  constructor(
    private readonly configs: CompanyPaymentConfigRepository,
    private readonly payments: PaymentsRepository,
  ) {}

  async createPayment(params: CreatePaymentParams): Promise<PaymentSession> {
    const internalPaymentId = await this.payments.createInitiated({
      invoiceId: params.invoiceId,
      provider: this.providerName,
      method: params.method,
      amount: params.amount,
      currency: params.currency,
    });

    if ((params.method === 'mpesa' || params.method === 'emola' || params.method === 'mkesh')
        && !params.payerPhoneNumber) {
      throw new Error(`payerPhoneNumber is required for ${params.method} via Paysuite`);
    }

    const apiKey = await this.configs.getSecretKey(params.invoiceId, this.providerName);

    // TODO: confirm exact endpoint path, auth header name, and request
    // field names against the real Paysuite API reference. This body
    // shape is a reasonable guess based on how STK-push aggregators in
    // this region typically work (Paysuite, M-Pesa Daraja, similar
    // providers all follow this rough shape) — it is NOT verified against
    // Paysuite's actual contract.
    const res = await fetch(`${PAYSUITE_BASE_URL}/payments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        method: params.method,
        amount: params.amount,
        currency: params.currency,
        phone: params.payerPhoneNumber,
        reference: internalPaymentId,
        callback_url: params.returnUrl,
      }),
    });

    if (!res.ok) {
      await this.payments.markFailed(internalPaymentId, { httpStatus: res.status });
      throw new Error(`Paysuite payment request failed: ${res.status}`);
    }

    // TODO: confirm actual response shape.
    const body = await res.json() as { id: string; checkout_url?: string };

    await this.payments.attachProviderReference(internalPaymentId, body.id);

    return {
      internalPaymentId,
      providerPaymentId: body.id,
      // Wallet methods (M-Pesa/e-Mola/mKesh) prompt on the customer's own
      // phone — no redirect needed. Card likely uses a hosted checkout —
      // confirm whether checkout_url is the real field name.
      redirectUrl: params.method === 'card' ? (body.checkout_url ?? null) : null,
      status: 'pending',
    };
  }

  async handleWebhook(rawBody: Buffer, headers: Record<string, string>): Promise<PaymentWebhookResult> {
    // TODO: confirm the real signature header name and algorithm with
    // Paysuite support before going live. This implementation assumes
    // an HMAC-SHA256 scheme over the raw body using a shared webhook
    // secret, which is the most common pattern among regional
    // aggregators — but it is UNVERIFIED for Paysuite specifically.
    // Do not deploy this signature check as-is without confirming.
    const signature = headers['x-paysuite-signature'];
    if (!signature) {
      throw new Error('Missing Paysuite webhook signature header — confirm real header name');
    }

    const webhookSecret = await this.configs.getWebhookSecret(this.providerName);
    const expected = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
      throw new Error('Paysuite webhook signature verification failed');
    }

    // TODO: confirm real event payload shape.
    const event = JSON.parse(rawBody.toString('utf8')) as {
      id: string; status: string; amount: number; currency: string;
    };

    const internalPaymentId = await this.payments.findInternalIdByProviderReference(
      this.providerName,
      event.id,
    );

    return {
      internalPaymentId,
      status: this.mapStatus(event.status),
      amount: event.amount,
      currency: event.currency,
      rawPayload: event as unknown as Record<string, unknown>,
    };
  }

  async checkStatus(providerPaymentId: string): Promise<PaymentStatus> {
    const apiKey = await this.configs.getSecretKeyByProviderReference(providerPaymentId);

    // TODO: confirm real status-check endpoint path.
    const res = await fetch(`${PAYSUITE_BASE_URL}/payments/${providerPaymentId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) return 'pending';
    const body = await res.json() as { status: string };
    return this.mapStatus(body.status);
  }

  private mapStatus(providerStatus: string): PaymentStatus {
    // TODO: confirm Paysuite's real status string values — these are
    // placeholders based on common conventions, not verified.
    switch (providerStatus) {
      case 'completed':
      case 'success':    return 'succeeded';
      case 'failed':
      case 'cancelled':  return 'failed';
      case 'refunded':   return 'refunded';
      default:           return 'pending';
    }
  }
}
