import { Controller, Post, Get, Body, UseGuards, Req, HttpCode } from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: { email: string; password: string; deviceLabel?: string },
    @Req() req: any,
  ) {
    return this.auth.login(body.email, body.password, body.deviceLabel, {
      ip: req.headers['x-forwarded-for'] ?? req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() body: { refreshToken: string }) {
    return this.auth.refresh(body.refreshToken);
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Body() body: { refreshToken: string }) {
    await this.auth.logout(body.refreshToken);
    return { success: true };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@Req() req: any) {
    return req.user;
  }
}
