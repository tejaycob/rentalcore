import {
  Controller, Get, Post, Patch, Body, Param, UseGuards, Req, HttpCode,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OwnerGuard } from './owner.guard';
import { UsersService } from './users.service';

/** Your own profile — any signed-in user. */
@Controller('me')
@UseGuards(JwtAuthGuard)
export class MeController {
  constructor(private readonly service: UsersService) {}

  @Get()
  profile(@Req() req: any) {
    return this.service.getMyProfile(req.user.userId);
  }

  @Patch()
  update(@Body() body: { name?: string; phone?: string; locale?: string }, @Req() req: any) {
    return this.service.updateMyProfile(req.user.userId, body);
  }

  @Post('password')
  @HttpCode(200)
  changePassword(
    @Body() body: { currentPassword: string; newPassword: string },
    @Req() req: any,
  ) {
    return this.service.changePassword(req.user.userId, body.currentPassword, body.newPassword);
  }
}

/** Company staff administration — owners only. */
@Controller('users')
@UseGuards(JwtAuthGuard, OwnerGuard)
export class UsersController {
  constructor(private readonly service: UsersService) {}

  @Get()
  list(@Req() req: any) {
    return this.service.listStaff(req.user.companyId);
  }

  @Get('invites')
  invites(@Req() req: any) {
    return this.service.listPendingInvites(req.user.companyId);
  }

  @Get(':id')
  getOne(@Param('id') id: string, @Req() req: any) {
    return this.service.getOne(id, req.user.companyId);
  }

  @Post('invite')
  invite(@Body() body: { email: string; name?: string; role: string }, @Req() req: any) {
    return this.service.inviteStaff(req.user.companyId, req.user.userId, body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: { role?: string; active?: boolean }, @Req() req: any) {
    return this.service.updateStaff(id, req.user.companyId, req.user.userId, body);
  }
}
