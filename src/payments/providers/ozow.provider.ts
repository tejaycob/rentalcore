// src/payments/providers/ozow.provider.ts
//
// South Africa: Instant EFT only — this is the dominant way SA renters
// actually pay recurring bills, confirmed via search showing Ozow as
// "the price leader for South African merchants whose customer base
// prefers bank transfer over cards." I have NOT seen Ozow's real API
// reference in this session. Their integration is documented to be
// hosted-checkout / redirect-based (the customer picks their bank,
// authenticates, and is redirected back) — that part is a reasonable
// inference from how every Instant EFT provider in South Africa works,
// but the exact request/response field names below are placeholders.
// Get Ozow's actual API docs from their merchant dashboard before
// writing this for real.

import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import {
  PaymentProvider, PaymentMethod, CreatePaymentParams,
  PaymentSession, PaymentWebhookResult, PaymentStatus,
} from '../payment-provider.interface';
import { CompanyPaymentConfigRepository } from '../company-payment-config.repository';
import { PaymentsRepository } from '../payments.repository';

// TODO: confirm against Ozow's real API documentation.
const OZOW_BASE_URL = 'https://api.ozow.com/v1';

@Injectable()
export class OzowProvider implements PaymentProvider {
  readonly providerName = 'ozow' as const;
  readonly supportedMethods: PaymentMethod[] = ['eft'];

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

    const apiKey = await this.configs.getSecretKey(params.invoiceId, this.providerName);

    // TODO: confirm real endpoint path and request field names. Instant
    // EFT providers in SA typically require a site/merchant code in
    // addition to an API key — confirm whether Ozow needs that too.
    const res = await fetch(`${OZOW_BASE_URL}/transactions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: params.amount,
        currency: params.currency,
        reference: internalPaymentId,
        successUrl: params.returnUrl,
        cancelUrl: params.returnUrl,
      }),
    });

    if (!res.ok) {
      await this.payments.markFailed(internalPaymentId, { httpStatus: res.status });
      throw new Error(`Ozow transaction request failed: ${res.status}`);
    }

    // TODO: confirm real response shape.
    const body = await res.json() as { transactionId: string; paymentRequestUrl: string };

    await this.payments.attachProviderReference(internalPaymentId, body.transactionId);

    return {
      internalPaymentId,
      providerPaymentId: body.transactionId,
      redirectUrl: body.paymentRequestUrl,
      status: 'pending',
    };
  }

  async handleWebhook(rawBody: Buffer, headers: Record<string, string>): Promise<PaymentWebhookResult> {
    // TODO: confirm real signature scheme. Some SA Instant EFT providers
    // sign a concatenated field string with a shared hash key rather than
    // HMAC over the raw body — this is a common enough variant in this
    // market that it's worth explicitly checking rather than assuming
    // the HMAC pattern used elsewhere in this file.
    const signature = headers['x-ozow-signature'];
    if (!signature) {
      throw new Error('Missing Ozow webhook signature header — confirm real header name and scheme');
    }

    const webhookSecret = await this.configs.getWebhookSecret(this.providerName);
    const expected = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
      throw new Error('Ozow webhook signature verification failed');
    }

    // TODO: confirm real payload shape.
    const event = JSON.parse(rawBody.toString('utf8')) as {
      transactionId: string; status: string; amount: number; currencyCode: string;
    };

    const internalPaymentId = await this.payments.findInternalIdByProviderReference(
      this.providerName,
      event.transactionId,
    );

    return {
      internalPaymentId,
      status: this.mapStatus(event.status),
      amount: event.amount,
      currency: event.currencyCode,
      rawPayload: event as unknown as Record<string, unknown>,
    };
  }

  async checkStatus(providerPaymentId: string): Promise<PaymentStatus> {
    const apiKey = await this.configs.getSecretKeyByProviderReference(providerPaymentId);

    // TODO: confirm real status-check endpoint.
    const res = await fetch(`${OZOW_BASE_URL}/transactions/${providerPaymentId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) return 'pending';
    const body = await res.json() as { status: string };
    return this.mapStatus(body.status);
  }

  private mapStatus(providerStatus: string): PaymentStatus {
    // TODO: confirm Ozow's real status string values.
    switch (providerStatus) {
      case 'Complete':
      case 'success':   return 'succeeded';
      case 'Cancelled':
      case 'Error':      return 'failed';
      case 'Refunded':   return 'refunded';
      default:           return 'pending';
    }
  }
}
