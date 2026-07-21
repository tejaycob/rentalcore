import {
  Controller, Get, Post, Delete, Param, Query, Req, Res,
  UseGuards, UseInterceptors, UploadedFile, Body, HttpCode,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DocumentsService } from './documents.service';

@Controller('documents')
@UseGuards(JwtAuthGuard)
export class DocumentsController {
  constructor(private readonly service: DocumentsService) {}

  /** GET /documents?entityType=user&entityId=<uuid> */
  @Get()
  list(@Query('entityType') entityType: string,
       @Query('entityId') entityId: string,
       @Req() req: any) {
    return this.service.listFor(entityType, entityId, req.user.companyId);
  }

  /**
   * POST /documents  (multipart/form-data)
   * fields: file, entityType, entityId, docType
   *
   * memoryStorage is deliberate: the bytes go straight into Postgres, so
   * writing them to the container filesystem first would be pointless and
   * would not survive a Railway redeploy anyway.
   */
  @Post()
  @UseInterceptors(FileInterceptor('file'))
  upload(@UploadedFile() file: any,
         @Body() body: { entityType: string; entityId: string; docType: string },
         @Req() req: any) {
    return this.service.upload({
      companyId: req.user.companyId,
      userId: req.user.userId,
      entityType: body.entityType,
      entityId: body.entityId,
      docType: body.docType,
      file,
    });
  }

  /** GET /documents/:id/download — streams the stored bytes back. */
  @Get(':id/download')
  async download(@Param('id') id: string, @Req() req: any, @Res() res: Response) {
    const doc = await this.service.download(id, req.user.companyId);
    res.setHeader('Content-Type', doc.mime_type ?? 'application/octet-stream');
    // `inline` so PDFs and images open in a tab; the filename is quoted
    // because real filenames contain spaces.
    res.setHeader('Content-Disposition', `inline; filename="${doc.filename.replace(/"/g, '')}"`);
    return res.send(doc.file_data);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string, @Req() req: any) {
    return this.service.remove(id, req.user.companyId);
  }
}
