// src/payments/payment-provider.factory.ts
//
// Resolves which concrete adapter handles a given company + payment method,
// based on the company_payment_configs table. This is the only place in
// the codebase that knows "Mozambique = Paysuite" — every other module
// just calls resolveProvider() and gets back something implementing
// PaymentProvider.

import { Injectable } from '@nestjs/common';
import { PaymentProvider, PaymentMethod } from './payment-provider.interface';
import { PaysuiteProvider } from './providers/paysuite.provider';
import { AppyPayProvider } from './providers/appypay.provider';
import { OzowProvider } from './providers/ozow.provider';
import { PaystackProvider } from './providers/paystack.provider';
import { CompanyPaymentConfigRepository } from './company-payment-config.repository';

@Injectable()
export class PaymentProviderFactory {
  constructor(
    private readonly configs: CompanyPaymentConfigRepository,
    private readonly paysuite: PaysuiteProvider,
    private readonly appypay: AppyPayProvider,
    private readonly ozow: OzowProvider,
    private readonly paystack: PaystackProvider,
  ) {}

  /**
   * Resolves the adapter to use for a specific payment attempt.
   * Most companies (Mozambique, Angola) have exactly one active config
   * and this returns it regardless of method. South African companies
   * have two configs (wallet scope unused there, but card vs eft scope
   * does apply) — method picks between Ozow and Paystack.
   */
  async resolveForPayment(companyId: string, method: PaymentMethod): Promise<PaymentProvider> {
    const configs = await this.configs.findActiveForCompany(companyId);

    if (configs.length === 0) {
      throw new Error(`No active payment provider configured for company ${companyId}`);
    }

    // Single-provider countries: one config covers every method.
    if (configs.length === 1) {
      return this.instantiate(configs[0].provider);
    }

    // Multi-provider countries (South Africa today): pick by scope.
    const scope = method === 'card' ? 'card' : 'wallet';
    const match = configs.find(c => c.paymentMethodScope === scope || c.paymentMethodScope === 'all');

    if (!match) {
      throw new Error(`No provider configured for method '${method}' on company ${companyId}`);
    }

    return this.instantiate(match.provider);
  }

  /** Used by webhook routes, which know the provider from the URL path
   *  (e.g. /webhooks/paysuite) before they know which company is involved. */
  forProviderName(name: PaymentProvider['providerName']): PaymentProvider {
    return this.instantiate(name);
  }

  private instantiate(name: PaymentProvider['providerName']): PaymentProvider {
    switch (name) {
      case 'paysuite':  return this.paysuite;
      case 'appypay':   return this.appypay;
      case 'ozow':      return this.ozow;
      case 'paystack':  return this.paystack;
    }
  }
}
