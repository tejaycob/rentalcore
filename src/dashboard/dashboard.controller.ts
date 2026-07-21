import { Controller, Get, UseGuards, Req } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get('stats')
  stats(@Req() req: any) { return this.service.getStats(req.user.companyId); }

  @Get('activity')
  activity(@Req() req: any) { return this.service.getRecentActivity(req.user.companyId); }
}
