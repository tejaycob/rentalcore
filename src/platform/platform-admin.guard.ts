import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';

/**
 * Allows only platform_admin users through.
 *
 * Use together with JwtAuthGuard, which populates req.user:
 *   @UseGuards(JwtAuthGuard, PlatformAdminGuard)
 *
 * The check is on the role in the token, and a platform admin's token
 * carries companyId: null. That is deliberate — it means a platform admin
 * physically cannot satisfy the `WHERE company_id = $1` filter every
 * tenant service applies, so a mis-wired route leaks nothing instead of
 * leaking everything.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (req.user?.role !== 'platform_admin') {
      throw new ForbiddenException('Platform administrator access required');
    }
    return true;
  }
}
