// src/auth/auth.module.ts

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { DatabaseModule } from '../database/database.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthRepository } from './auth.repository';
import { JwtStrategyGuard } from './jwt-strategy.guard';

@Module({
  imports: [
    DatabaseModule,
    JwtModule.register({
      // Same env-var convention as ENCRYPTION_MASTER_KEY in crypto/secrets.service.ts —
      // required at startup, no fallback default, so a misconfigured deploy fails
      // loudly instead of signing tokens with a guessable key.
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '15m' },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthRepository, JwtStrategyGuard],
  exports: [JwtStrategyGuard, JwtModule],
})
export class AuthModule {}
