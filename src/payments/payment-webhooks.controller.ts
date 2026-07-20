// src/payments/payment-webhooks.controller.ts
//
// One route per provider, all converging on the same logic: verify
// signature (each adapter's job), then mark the invoice paid and post
// the ledger entries — server-side, never trusting anything the mobile
// app claims. This is the enforcement point for the rule stated earlier:
// the "Pay rent" button only ever starts a payment; this controller is
// the only thing that ever finalizes one.

import { Controller, Post, Req, Res, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { RawBodyRequest } from '@nestjs/common';
import { PaymentProviderFactory } from './payment-provider.factory';
import { PaymentsRepository } from './payments.repository';
import { LedgerService } from '../ledger/ledger.service';
import { EmailService } from '../notifications/email.service';
import { PaymentWebhookResult } from './payment-provider.interface';

@Controller('webhooks')
export class PaymentWebhooksController {
  constructor(
    private readonly providers: PaymentProviderFactory,
    private readonly payments: PaymentsRepository,
    private readonly ledger: LedgerService,
    private readonly email: EmailService,
  ) {}

  @Post('paysuite')
  async paysuite(@Req() req: RawBodyRequest<Request>, @Res() res: Response) {
    return this.handle('paysuite', req, res);
  }

  @Post('appypay')
  async appypay(@Req() req: RawBodyRequest<Request>, @Res() res: Response) {
    return this.handle('appypay', req, res);
  }

  @Post('ozow')
  async ozow(@Req() req: RawBodyRequest<Request>, @Res() res: Response) {
    return this.handle('ozow', req, res);
  }

  @Post('paystack')
  async paystack(@Req() req: RawBodyRequest<Request>, @Res() res: Response) {
    return this.handle('paystack', req, res);
  }

  /**
   * Shared handler. Requires the raw, unparsed request body — signature
   * verification operates on raw bytes, not a JSON-parsed and
   * re-serialized object, since re-serialization can change byte-for-byte
   * formatting and silently break every signature check. This is enabled
   * app-wide via `NestFactory.create(AppModule, { rawBody: true })` in
   * main.ts, which is what populates req.rawBody as a Buffer below —
   * confirmed against NestJS's own documentation for this exact pattern.
   */
  private async handle(
    providerName: 'paysuite' | 'appypay' | 'ozow' | 'paystack',
    req: RawBodyRequest<Request>,
    res: Response,
  ) {
    const provider = this.providers.forProviderName(providerName);

    if (!req.rawBody) {
      // Should be unreachable if main.ts's rawBody:true is configured
      // correctly — surfaced loudly here rather than passing undefined
      // into signature verification, which would fail confusingly deep
      // inside an adapter instead of obviously at the entry point.
      return res.status(HttpStatus.BAD_REQUEST).json({ error: 'Raw request body unavailable' });
    }

    let result: PaymentWebhookResult;
    try {
      result = await provider.handleWebhook(req.rawBody, req.headers as Record<string, string>);
    } catch (err) {
      // Signature failures and malformed payloads return 400, not 401 —
      // we don't want to leak which part of verification failed, and a
      // 4xx (not 5xx) tells the provider not to retry a request that
      // will never succeed.
      return res.status(HttpStatus.BAD_REQUEST).json({ error: (err as Error).message });
    }

    // Idempotency: providers retry on timeout/non-2xx. If we've already
    // recorded a terminal status for this payment, acknowledge and stop —
    // re-running the ledger postings (or re-sending the email) would
    // double-count revenue and spam the renter.
    const existing = await this.payments.findById(result.internalPaymentId);
    if (existing && ['succeeded', 'failed', 'refunded'].includes(existing.status)) {
      return res.status(HttpStatus.OK).json({ received: true, alreadyProcessed: true });
    }

    await this.payments.updateStatus(result.internalPaymentId, result.status, result.rawPayload);

    if (result.status === 'succeeded') {
      await this.ledger.postRentPayment(result.internalPaymentId, result.amount);

      // `existing` is guaranteed non-null here: createInitiated() creates
      // the row before any provider call happens, and handleWebhook()
      // (called above) already throws inside
      // findInternalIdByProviderReference() if no local row matches —
      // so reaching this line at all means the row exists. Asserting it
      // explicitly, rather than silently trusting TypeScript's `!`,
      // means a future change that breaks this invariant fails loudly
      // here instead of crashing confusingly inside EmailService.
      if (!existing) {
        throw new Error(
          `Invariant violated: payment ${result.internalPaymentId} succeeded but has no local row`,
        );
      }

      await this.email.sendPaymentConfirmedEmail({
        recipientEmail: existing.renterEmail,
        recipientLocale: existing.renterLocale,
        amount: existing.amount,
        currency: existing.currency,
      });
    } else if (result.status === 'refunded') {
      await this.ledger.postRefund(result.internalPaymentId, result.amount);
    }
    // 'failed' status: no ledger entry — nothing was actually paid.
    // 'pending': also no entry yet; some providers send an intermediate
    // pending event before the final success/failure.

    return res.status(HttpStatus.OK).json({ received: true });
  }
}
