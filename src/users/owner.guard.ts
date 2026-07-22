import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';

/**
 * Company administration — owners only.
 *
 * Property managers and accountants can run the day-to-day product but must
 * not be able to invite colleagues, change roles or deactivate people.
 * Platform admins are excluded too: they belong to no company, so "manage
 * this company's staff" has no meaning for them. They act through
 * /platform instead.
 */
@Injectable()
export class OwnerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (req.user?.role !== 'owner') {
      throw new ForbiddenException('Only a company owner can manage users');
    }
    return true;
  }
}
