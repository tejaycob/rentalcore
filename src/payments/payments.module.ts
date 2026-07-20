// src/payments/payments.module.ts
//
// Wires together everything built in the payments slice: the four
// country adapters, the factory that picks between them, both
// repositories, and the webhook controller. Depends on LedgerModule
// (the controller posts ledger entries on success) and
// NotificationsModule (the controller emails the renter on success).

import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { LedgerModule } from '../ledger/ledger.module';
import { NotificationsModule } from '../notifications/notifications.module';

import { PaymentProviderFactory } from './payment-provider.factory';
import { PaymentWebhooksController } from './payment-webhooks.controller';
import { PaymentsRepository } from './payments.repository';
import { CompanyPaymentConfigRepository } from './company-payment-config.repository';

import { PaysuiteProvider } from './providers/paysuite.provider';
import { AppyPayProvider } from './providers/appypay.provider';
import { OzowProvider } from './providers/ozow.provider';
import { PaystackProvider } from './providers/paystack.provider';

@Module({
  imports: [DatabaseModule, LedgerModule, NotificationsModule],
  controllers: [PaymentWebhooksController],
  providers: [
    PaymentProviderFactory,
    PaymentsRepository,
    CompanyPaymentConfigRepository,
    PaysuiteProvider,
    AppyPayProvider,
    OzowProvider,
    PaystackProvider,
  ],
  exports: [PaymentProviderFactory, PaymentsRepository],
})
export class PaymentsModule {}
