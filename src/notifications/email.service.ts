// src/notifications/email.service.ts
//
// The locale used for any given email is the RECIPIENT's own
// users.locale — never the company's country, and never a hardcoded
// default. A property company in Mozambique can have a renter who
// chose English at signup; that renter gets English invoices. This is
// the concrete enforcement of "both languages, user picks" from the
// product requirement — it has to live here, not just in the UI layer,
// because emails are generated server-side with no UI involved at all.

import { Injectable } from '@nestjs/common';
import { I18nService } from '../i18n/i18n.service';
import { Locale } from '../i18n/i18n.types';

interface SendInvoiceEmailParams {
  recipientEmail: string;
  recipientLocale: Locale;
  period: string;
  amountDue: number;
  currency: string;
  dueDate: string;
}

interface SendPaymentConfirmedEmailParams {
  recipientEmail: string;
  recipientLocale: Locale;
  amount: number;
  currency: string;
}

@Injectable()
export class EmailService {
  constructor(private readonly i18n: I18nService) {}

  async sendInvoiceEmail(params: SendInvoiceEmailParams): Promise<void> {
    const subject = this.i18n.t('rent.invoiceEmailSubject', params.recipientLocale, {
      period: params.period,
    });
    const statusLabel = this.i18n.t('invoice.status.pending', params.recipientLocale);
    const body = this.buildInvoiceBody(params, statusLabel);
    await this.dispatch(params.recipientEmail, subject, body);
  }

  async sendPaymentConfirmedEmail(params: SendPaymentConfirmedEmailParams): Promise<void> {
    const subject = this.i18n.t('rent.paymentConfirmedSubject', params.recipientLocale);
    const statusLabel = this.i18n.t('payment.status.succeeded', params.recipientLocale);
    const body = `<p>${statusLabel}: ${params.amount} ${params.currency}</p>`;
    await this.dispatch(params.recipientEmail, subject, body);
  }

  private buildInvoiceBody(params: SendInvoiceEmailParams, statusLabel: string): string {
    return `
      <p>${params.period} — ${params.amountDue} ${params.currency}</p>
      <p>${statusLabel} — ${params.dueDate}</p>
    `;
  }

  /** Placeholder dispatch — swap for the real provider (Resend, SES,
   *  whichever this project ends up using) when this module is built out. */
  private async dispatch(to: string, subject: string, html: string): Promise<void> {
    // TODO: wire to real email provider.
    console.log(`[email] to=${to} subject="${subject}"`, html);
  }
}
