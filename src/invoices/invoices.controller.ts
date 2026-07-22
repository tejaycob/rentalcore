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

  /** Full ledger for one lease — invoices, payments, running balance. */
  @Get('statement/:leaseId')
  statement(@Param('leaseId') leaseId: string, @Req() req: any) {
    return this.service.getStatement(req.user.companyId, leaseId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.service.findOne(id, req.user.companyId);
  }

  /** One customer, one month. */
  @Post('generate')
  generate(@Body() body: { leaseId: string; period: string }, @Req() req: any) {
    return this.service.generateForLease(req.user.companyId, body.leaseId, body.period);
  }

  /** Every active lease for the month. */
  @Post('generate-all')
  generateAll(@Body() body: { period: string }, @Req() req: any) {
    return this.service.generateForAll(req.user.companyId, body.period);
  }

  /** Stamp late fees on everything past due, per company policy. */
  @Post('apply-late-fees')
  applyLateFees(@Req() req: any) {
    return this.service.applyLateFees(req.user.companyId);
  }

  @Patch(':id/status')
  updateStatus(@Param('id') id: string, @Body() body: { status: string }, @Req() req: any) {
    return this.service.updateStatus(id, req.user.companyId, body.status);
  }
}
