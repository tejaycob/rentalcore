import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [
    DatabaseModule,
    MulterModule.register({
      storage: memoryStorage(),
      // Hard stop before the request body is fully buffered. The service
      // checks again for a friendlier message; this is the backstop that
      // stops a 500MB upload consuming memory.
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
