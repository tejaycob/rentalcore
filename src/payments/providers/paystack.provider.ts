// src/payments/providers/paystack.provider.ts
//
// Card payments for South African companies. Verified against Paystack's
// public documentation: webhook signature scheme (x-paystack-signature,
// HMAC-SHA512 of the raw body using your secret key) is confirmed from
// https://paystack.com/docs/payments/webhooks/. The transaction
// initialize/verify endpoint shapes below follow Paystack's standard
// REST API conventions, which are stable and documented at
// https://paystack.com/docs/api/transaction/ — confirm field names there
// before going live, since I have not fetched that exact page in this
// session.

import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import {
  PaymentProvider, PaymentMethod, CreatePaymentParams,
  PaymentSession, PaymentWebhookResult, PaymentStatus,
} from '../payment-provider.interface';
import { CompanyPaymentConfigRepository } from '../company-payment-config.repository';
import { PaymentsRepository } from '../payments.repository';

const PAYSTACK_BASE_URL = 'https://api.paystack.co';

@Injectable()
export class PaystackProvider implements PaymentProvider {
  readonly providerName = 'paystack' as const;
  readonly supportedMethods: PaymentMethod[] = ['card'];

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

    const secretKey = await this.configs.getSecretKey(params.invoiceId, this.providerName);

    // Paystack's transaction/initialize endpoint expects amount in the
    // smallest currency unit (cents) — confirm this still holds for ZAR
    // before relying on it; it is true for NGN/GHS in their docs and is
    // documented as the general convention, but verify on the live
    // transaction/initialize reference before shipping.
    const res = await fetch(`${PAYSTACK_BASE_URL}/transaction/initialize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: params.payerEmail,
        amount: Math.round(params.amount * 100),
        currency: params.currency,
        callback_url: params.returnUrl,
        metadata: { internalPaymentId, invoiceId: params.invoiceId },
      }),
    });

    if (!res.ok) {
      await this.payments.markFailed(internalPaymentId, { httpStatus: res.status });
      throw new Error(`Paystack initialize failed: ${res.status}`);
    }

    const body = await res.json() as {
      status: boolean;
      data: { authorization_url: string; reference: string };
    };

    await this.payments.attachProviderReference(internalPaymentId, body.data.reference);

    return {
      internalPaymentId,
      providerPaymentId: body.data.reference,
      redirectUrl: body.data.authorization_url,
      status: 'pending',
    };
  }

  async handleWebhook(rawBody: Buffer, headers: Record<string, string>): Promise<PaymentWebhookResult> {
    const signature = headers['x-paystack-signature'];
    if (!signature) {
      throw new Error('Missing x-paystack-signature header');
    }

    // Verified scheme: HMAC-SHA512 of the raw request body, using the
    // account's secret key. Source: Paystack webhook documentation.
    const secretKey = await this.configs.getWebhookSecret(this.providerName);
    const expected = crypto
      .createHmac('sha512', secretKey)
      .update(rawBody)
      .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
      throw new Error('Paystack webhook signature verification failed');
    }

    const event = JSON.parse(rawBody.toString('utf8')) as {
      event: string;
      data: { reference: string; amount: number; currency: string; status: string };
    };

    const internalPaymentId = await this.payments.findInternalIdByProviderReference(
      this.providerName,
      event.data.reference,
    );

    return {
      internalPaymentId,
      status: this.mapStatus(event.event, event.data.status),
      amount: event.data.amount / 100,
      currency: event.data.currency,
      rawPayload: event as unknown as Record<string, unknown>,
    };
  }

  async checkStatus(providerPaymentId: string): Promise<PaymentStatus> {
    const secretKey = await this.configs.getSecretKeyByProviderReference(providerPaymentId);

    const res = await fetch(`${PAYSTACK_BASE_URL}/transaction/verify/${providerPaymentId}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });

    if (!res.ok) return 'pending';

    const body = await res.json() as { data: { status: string } };
    return this.mapStatus('transaction.verify', body.data.status);
  }

  private mapStatus(event: string, providerStatus: string): PaymentStatus {
    if (providerStatus === 'success') return 'succeeded';
    if (providerStatus === 'failed' || providerStatus === 'abandoned') return 'failed';
    if (providerStatus === 'reversed') return 'refunded';
    return 'pending';
  }
}
