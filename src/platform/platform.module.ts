import { Module } from '@nestjs/common';
import { PlatformController } from './platform.controller';
import { InvitesController } from './invites.controller';
import { PlatformService } from './platform.service';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [DatabaseModule],
  controllers: [PlatformController, InvitesController],
  providers: [PlatformService],
  exports: [PlatformService],
})
export class PlatformModule {}
