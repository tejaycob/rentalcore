import { Controller, Get, Post, Patch, Body, Param, Query, UseGuards, Req } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { InvoicesService } from './invoices.service';

@Controller('invoices')
@UseGuards(JwtAuthGuard)
export class InvoicesController {
  constructor(private readonly service: InvoicesService) {}

  @Get()
  findAll(@Req() req: any, @Query() q: any) {
    return this.service.findAll(req.user.companyId, { status: q.status, leaseId: q.leaseId });
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.service.findOne(id, req.user.companyId);
  }

  @Post('generate')
  generate(@Body() body: { leaseId: string; period: string; dueDate: string }, @Req() req: any) {
    return this.service.generate(req.user.companyId, body);
  }

  @Post('generate-all')
  generateAll(@Body() body: { period: string }, @Req() req: any) {
    return this.service.generateForAll(req.user.companyId, body.period);
  }

  @Patch(':id/status')
  updateStatus(@Param('id') id: string, @Body() body: { status: string }, @Req() req: any) {
    return this.service.updateStatus(id, req.user.companyId, body.status);
  }
}
