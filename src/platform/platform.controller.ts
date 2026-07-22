import {
  Controller, Get, Post, Patch, Body, Param, Query, UseGuards, Req, HttpCode,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PlatformAdminGuard } from './platform-admin.guard';
import { PlatformService } from './platform.service';

@Controller('platform')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class PlatformController {
  constructor(private readonly service: PlatformService) {}

  @Get('summary')
  summary() { return this.service.getSummary(); }

  @Get('companies')
  listCompanies() { return this.service.listCompanies(); }

  @Get('companies/:id')
  getCompany(@Param('id') id: string) { return this.service.getCompany(id); }

  /** Provision a new client: company + first-owner invite, one transaction. */
  @Post('companies')
  createCompany(@Body() body: any, @Req() req: any) {
    return this.service.createCompany(body, req.user.userId);
  }

  @Patch('companies/:id/subscription')
  setSubscription(@Param('id') id: string, @Body() body: any) {
    return this.service.setSubscription(id, body);
  }

  @Post('companies/:id/suspend')
  @HttpCode(200)
  suspend(@Param('id') id: string, @Body() body: { reason: string }) {
    return this.service.suspend(id, body?.reason ?? 'Suspended by administrator');
  }

  @Post('companies/:id/reactivate')
  @HttpCode(200)
  reactivate(@Param('id') id: string) { return this.service.reactivate(id); }

  @Get('invites')
  listInvites(@Query('companyId') companyId?: string) {
    return this.service.listInvites(companyId);
  }

  @Post('invites')
  invite(@Body() body: any, @Req() req: any) {
    return this.service.inviteUser(body, req.user.userId);
  }

  @Post('invites/:id/revoke')
  @HttpCode(200)
  revoke(@Param('id') id: string) { return this.service.revokeInvite(id); }
}
