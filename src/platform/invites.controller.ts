import { Controller, Get, Post, Body, Query, HttpCode } from '@nestjs/common';
import { PlatformService } from './platform.service';

/**
 * PUBLIC — no guard. These are the two endpoints an invited person hits
 * before they have an account, so they cannot require a token.
 *
 * Both are rate-limit candidates: they take a secret from the URL, and the
 * only thing stopping enumeration today is that tokens are 32 random bytes.
 */
@Controller('invites')
export class InvitesController {
  constructor(private readonly service: PlatformService) {}

  /** Shows who the invite is for, so the page isn't a blank password form. */
  @Get('peek')
  peek(@Query('token') token: string) {
    return this.service.peekInvite(token);
  }

  @Post('accept')
  @HttpCode(201)
  accept(@Body() body: { token: string; password: string; name?: string }) {
    return this.service.acceptInvite(body.token, body.password, body.name);
  }
}
