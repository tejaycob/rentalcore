import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards, Req, HttpCode } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PropertiesService } from './properties.service';

@Controller('properties')
@UseGuards(JwtAuthGuard)
export class PropertiesController {
  constructor(private readonly service: PropertiesService) {}

  @Get()
  findAll(@Req() req: any) {
    return this.service.findAll(req.user.companyId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.service.findOne(id, req.user.companyId);
  }

  @Post()
  create(@Body() body: { name: string; address: string; city: string }, @Req() req: any) {
    return this.service.create(req.user.companyId, body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.service.update(id, req.user.companyId, body);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string, @Req() req: any) {
    return this.service.remove(id, req.user.companyId);
  }
}
