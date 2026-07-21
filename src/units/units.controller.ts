import { Controller, Get, Post, Patch, Body, Param, UseGuards, Req, Query } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UnitsService } from './units.service';

@Controller('units')
@UseGuards(JwtAuthGuard)
export class UnitsController {
  constructor(private readonly service: UnitsService) {}

  @Get()
  findAll(@Req() req: any, @Query('propertyId') propertyId?: string) {
    if (propertyId) return this.service.findByProperty(propertyId, req.user.companyId);
    return this.service.findAll(req.user.companyId);
  }

  @Post()
  create(@Body() body: any, @Req() req: any) {
    return this.service.create(req.user.companyId, body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.service.update(id, req.user.companyId, body);
  }
}
