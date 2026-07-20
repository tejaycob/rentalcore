// src/app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { I18nModule } from './i18n/i18n.module';
import { LedgerModule } from './ledger/ledger.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PaymentsModule } from './payments/payments.module';

@Module({
  imports: [
    // Must be first: loads .env into process.env via dotenv before any
    // other module initializes — DatabaseModule's factory reads
    // process.env.DATABASE_URL synchronously at startup, so this has to
    // run ahead of it, not after.
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    AuthModule,
    I18nModule,
    LedgerModule,
    NotificationsModule,
    PaymentsModule,
  ],
})
export class AppModule {}
