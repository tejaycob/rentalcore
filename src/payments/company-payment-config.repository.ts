// src/payments/company-payment-config.repository.ts
//
// Resolves provider configuration (which provider, which credentials) for
// a company. Credentials are stored encrypted in the database
// (company_payment_configs.encrypted_credentials) and decrypted here,
// not in the adapters — adapters only ever see a plaintext key in memory
// for the duration of one request, never persisted or logged.

import { Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { decrypt } from '../crypto/secrets.service'; // app-level KMS wrapper — not included here

export interface CompanyPaymentConfig {
  provider: 'paysuite' | 'appypay' | 'ozow' | 'paystack';
  paymentMethodScope: 'all' | 'wallet' | 'card';
  isLive: boolean;
}

@Injectable()
export class CompanyPaymentConfigRepository {
  constructor(private readonly pool: Pool) {}

  async findActiveForCompany(companyId: string): Promise<CompanyPaymentConfig[]> {
    const result = await this.pool.query<{
      provider: CompanyPaymentConfig['provider'];
      payment_method_scope: CompanyPaymentConfig['paymentMethodScope'];
      is_live: boolean;
    }>(
      `SELECT provider, payment_method_scope, is_live
       FROM company_payment_configs
       WHERE company_id = $1 AND active = true`,
      [companyId],
    );
    return result.rows.map(r => ({
      provider: r.provider,
      paymentMethodScope: r.payment_method_scope,
      isLive: r.is_live,
    }));
  }

  /** Looks up the secret key for a given invoice's company + provider.
   *  Goes through the invoice rather than taking companyId directly so
   *  callers (the adapters) don't need a separate lookup just to find
   *  which company an invoice belongs to. */
  async getSecretKey(invoiceId: string, provider: CompanyPaymentConfig['provider']): Promise<string> {
    const result = await this.pool.query<{ encrypted_credentials: Buffer }>(
      `SELECT cpc.encrypted_credentials
       FROM company_payment_configs cpc
       JOIN invoices i ON i.company_id = cpc.company_id
       WHERE i.id = $1 AND cpc.provider = $2 AND cpc.active = true`,
      [invoiceId, provider],
    );
    if (result.rows.length === 0) {
      throw new Error(`No active ${provider} config found for invoice ${invoiceId}`);
    }
    const credentials = JSON.parse(decrypt(result.rows[0].encrypted_credentials)) as { secretKey: string };
    return credentials.secretKey;
  }

  /** Used by checkStatus(), which only has the provider's own reference,
   *  not an invoiceId — resolves through the payments table instead. */
  async getSecretKeyByProviderReference(providerPaymentId: string): Promise<string> {
    const result = await this.pool.query<{ encrypted_credentials: Buffer }>(
      `SELECT cpc.encrypted_credentials
       FROM company_payment_configs cpc
       JOIN payments p ON p.company_id = cpc.company_id
       WHERE p.provider_payment_id = $1 AND cpc.active = true`,
      [providerPaymentId],
    );
    if (result.rows.length === 0) {
      throw new Error(`No active config found for provider reference '${providerPaymentId}'`);
    }
    const credentials = JSON.parse(decrypt(result.rows[0].encrypted_credentials)) as { secretKey: string };
    return credentials.secretKey;
  }

  /** Webhook secrets are typically account-wide rather than per-invoice,
   *  so this takes only the provider name. If a provider issues a
   *  per-company webhook secret instead (confirm per-vendor), this needs
   *  a companyId parameter added — check this against each provider's
   *  real webhook setup flow. */
  async getWebhookSecret(provider: CompanyPaymentConfig['provider']): Promise<string> {
    const result = await this.pool.query<{ encrypted_credentials: Buffer }>(
      `SELECT encrypted_credentials FROM company_payment_configs
       WHERE provider = $1 AND active = true LIMIT 1`,
      [provider],
    );
    if (result.rows.length === 0) {
      throw new Error(`No active config found for provider ${provider}`);
    }
    const credentials = JSON.parse(decrypt(result.rows[0].encrypted_credentials)) as { webhookSecret: string };
    return credentials.webhookSecret;
  }
}
