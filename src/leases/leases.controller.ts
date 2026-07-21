import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards, Req, HttpCode } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { LeasesService } from './leases.service';

@Controller('leases')
@UseGuards(JwtAuthGuard)
export class LeasesController {
  constructor(private readonly service: LeasesService) {}

  @Get()
  findAll(@Req() req: any) { return this.service.findAll(req.user.companyId); }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.service.findOne(id, req.user.companyId);
  }

  @Post()
  create(@Body() body: any, @Req() req: any) {
    return this.service.create(req.user.companyId, body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: any) {
    return this.service.update(id, req.user.companyId, body);
  }

  @Delete(':id/terminate')
  @HttpCode(204)
  terminate(@Param('id') id: string, @Req() req: any) {
    return this.service.terminate(id, req.user.companyId);
  }
}
