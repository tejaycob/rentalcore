// src/notifications/notifications.module.ts
import { Module } from '@nestjs/common';
import { EmailService } from './email.service';
import { I18nModule } from '../i18n/i18n.module';

@Module({
  imports: [I18nModule],
  providers: [EmailService],
  exports: [EmailService],
})
export class NotificationsModule {}
