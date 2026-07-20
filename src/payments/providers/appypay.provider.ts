// src/payments/providers/appypay.provider.ts
//
// Angola: Multicaixa Express, payment-by-reference, UNITEL Money, and
// Visa via EMIS's network, all through one AppyPay account (appypay.ao).
// Confirmed from their public site that they offer "configuração simples
// e rápida" with a REST API. I have NOT seen their actual API reference —
// search results only surfaced their marketing page, not technical docs.
// Every TODO below needs confirming against their real developer
// documentation (request it from AppyPay support if it's not public)
// before this goes live.

import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import {
  PaymentProvider, PaymentMethod, CreatePaymentParams,
  PaymentSession, PaymentWebhookResult, PaymentStatus,
} from '../payment-provider.interface';
import { CompanyPaymentConfigRepository } from '../company-payment-config.repository';
import { PaymentsRepository } from '../payments.repository';

// TODO: confirm against AppyPay's real developer documentation.
const APPYPAY_BASE_URL = 'https://api.appypay.co.ao/v1';

@Injectable()
export class AppyPayProvider implements PaymentProvider {
  readonly providerName = 'appypay' as const;
  readonly supportedMethods: PaymentMethod[] = ['multicaixa', 'unitel_money', 'card'];

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

    // TODO: confirm real endpoint, auth scheme, and field names.
    // Angola's "Pagamento por Referência" pattern (confirmed from the
    // ProxyPay/EMIS ecosystem) generates a reference + entity the
    // customer pays at any Multicaixa ATM or via home banking — similar
    // shape to the Multicaixa reference flow we already built for
    // RentCore in Mozambique, but through EMIS rather than the
    // M-Pesa-style telcos. UNITEL Money (mobile-number based) likely
    // works more like an STK push, similar to Paysuite's wallet flow.
    // Confirm which flow applies to which method before relying on this.
    const res = await fetch(`${APPYPAY_BASE_URL}/charges`, {
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
      }),
    });

    if (!res.ok) {
      await this.payments.markFailed(internalPaymentId, { httpStatus: res.status });
      throw new Error(`AppyPay charge request failed: ${res.status}`);
    }

    // TODO: confirm real response shape — does it return a reference +
    // entity pair (ATM-style) or a hosted checkout URL, and does that
    // differ by method?
    const body = await res.json() as { id: string; reference?: string; entity?: string };

    await this.payments.attachProviderReference(internalPaymentId, body.id);

    return {
      internalPaymentId,
      providerPaymentId: body.id,
      redirectUrl: null, // TODO: confirm — likely null for reference-based flows
      status: 'pending',
    };
  }

  async handleWebhook(rawBody: Buffer, headers: Record<string, string>): Promise<PaymentWebhookResult> {
    // TODO: confirm real signature header name and algorithm with AppyPay.
    const signature = headers['x-appypay-signature'];
    if (!signature) {
      throw new Error('Missing AppyPay webhook signature header — confirm real header name');
    }

    const webhookSecret = await this.configs.getWebhookSecret(this.providerName);
    const expected = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
      throw new Error('AppyPay webhook signature verification failed');
    }

    // TODO: confirm real payload shape.
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

    // TODO: confirm real status-check endpoint.
    const res = await fetch(`${APPYPAY_BASE_URL}/charges/${providerPaymentId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) return 'pending';
    const body = await res.json() as { status: string };
    return this.mapStatus(body.status);
  }

  private mapStatus(providerStatus: string): PaymentStatus {
    // TODO: confirm AppyPay's real status string values.
    switch (providerStatus) {
      case 'paid':
      case 'success':   return 'succeeded';
      case 'failed':
      case 'expired':    return 'failed';
      case 'refunded':   return 'refunded';
      default:           return 'pending';
    }
  }
}
