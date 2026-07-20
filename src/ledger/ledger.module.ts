// src/ledger/ledger.module.ts
//
// LedgerService takes a plain `Pool` constructor argument, satisfied by
// DatabaseModule's @Global() export — no need to import DatabaseModule
// here explicitly, but it's listed anyway for readability: a developer
// reading this file shouldn't have to know "Global modules don't need
// importing" to understand where Pool comes from.

import { Module } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [DatabaseModule],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
