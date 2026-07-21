import { Controller, Get, Patch, Body, Param, UseGuards, Req } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TenantsService } from './tenants.service';

@Controller('tenants')
@UseGuards(JwtAuthGuard)
export class TenantsController {
  constructor(private readonly service: TenantsService) {}

  @Get()
  findAll(@Req() req: any) {
    return this.service.findAll(req.user.companyId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.service.findOne(id, req.user.companyId);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: any) {
    return this.service.update(id, req.user.companyId, body);
  }
}
