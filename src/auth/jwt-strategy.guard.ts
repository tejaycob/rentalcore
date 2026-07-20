// src/auth/jwt-strategy.guard.ts
//
// A plain CanActivate guard rather than @nestjs/passport — this app has
// no other auth strategy to plug into passport's abstraction for, so a
// direct JwtService.verify() keeps one less dependency in play. Attach
// with `@UseGuards(JwtStrategyGuard)` on any controller/route that needs
// a logged-in user; it populates `req.user` with { sub, companyId, role }
// from the token payload for downstream handlers to read.

import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export interface RequestUser {
  sub: string; // user id
  companyId: string | null;
  role: 'owner' | 'property_manager' | 'accountant' | 'renter';
}

@Injectable()
export class JwtStrategyGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers['authorization'];

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const token = authHeader.slice('Bearer '.length);
    try {
      const payload = this.jwtService.verify<RequestUser>(token);
      request.user = payload;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
