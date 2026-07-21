import { Controller, Get, Post, Patch, Body, Param, Query, UseGuards, Req } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MaintenanceService } from './maintenance.service';

@Controller('maintenance')
@UseGuards(JwtAuthGuard)
export class MaintenanceController {
  constructor(private readonly service: MaintenanceService) {}

  @Get()
  findAll(@Req() req: any, @Query() q: any) {
    return this.service.findAll(req.user.companyId, { status: q.status, priority: q.priority });
  }

  @Post()
  create(@Body() body: any, @Req() req: any) {
    return this.service.create(req.user.companyId, req.user.userId, body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.service.update(id, req.user.companyId, body);
  }
}
