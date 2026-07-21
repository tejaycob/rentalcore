import { Module } from '@nestjs/common';
import { LeasesController } from './leases.controller';
import { LeasesService } from './leases.service';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [DatabaseModule],
  controllers: [LeasesController],
  providers: [LeasesService],
  exports: [LeasesService],
})
export class LeasesModule {}
