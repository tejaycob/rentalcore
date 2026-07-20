// src/database/database.module.ts
//
// Provides a single shared Pool instance, under the `Pool` class itself
// as the injection token. Every payments/ledger repository written
// earlier takes `private readonly pool: Pool` as a plain constructor
// parameter with no @Inject() decorator — NestJS resolves that by
// looking up the `Pool` class as a token, so that's exactly what this
// module registers. Providing the class directly (rather than a
// separate string token aliased to it) is the standard pattern and
// requires no changes to any existing repository file.

import { Global, Module } from '@nestjs/common';
import { Pool } from 'pg';

@Global()
@Module({
  providers: [
    {
      provide: Pool,
      useFactory: (): Pool => {
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) {
          throw new Error('DATABASE_URL is not set');
        }
        return new Pool({ connectionString });
      },
    },
  ],
  exports: [Pool],
})
export class DatabaseModule {}
