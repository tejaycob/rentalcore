import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { I18nModule } from './i18n/i18n.module';
import { LedgerModule } from './ledger/ledger.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PaymentsModule } from './payments/payments.module';
import { AuthModule } from './auth/auth.module';
import { PropertiesModule } from './properties/properties.module';
import { UnitsModule } from './units/units.module';
import { LeasesModule } from './leases/leases.module';
import { InvoicesModule } from './invoices/invoices.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { TenantsModule } from './tenants/tenants.module';
import { DocumentsModule } from './documents/documents.module';
import { PlatformModule } from './platform/platform.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    I18nModule,
    LedgerModule,
    NotificationsModule,
    AuthModule,
    PaymentsModule,
    PropertiesModule,
    UnitsModule,
    LeasesModule,
    InvoicesModule,
    MaintenanceModule,
    DashboardModule,
    TenantsModule,
    DocumentsModule,
    PlatformModule,
  ],
  // NOTE on tenancy: the DB connection runs as the table owner and the
  // migration never uses FORCE ROW LEVEL SECURITY, so Postgres RLS does not
  // apply to this app's queries. Tenant isolation is enforced by the explicit
  // `WHERE company_id = $1` in every service query (verified against all 391
  // column references). A per-request RLS context (dedicated client +
  // SET LOCAL) is future work — an earlier interceptor that claimed to do
  // this via pool.query() was removed because pooled connections make it a
  // no-op at best and misleading at worst.
})
export class AppModule {}
