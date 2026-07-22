import { Injectable, UnauthorizedException, ConflictException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Pool } from 'pg';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { UsersRepository } from './users.repository';

export interface JwtPayload {
  sub: string;        // user id
  companyId: string;
  role: string;
  locale: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
    locale: string;
    companyId: string;
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersRepository,
    private readonly jwt: JwtService,
    private readonly pool: Pool,
  ) {}

  async login(
    email: string,
    password: string,
    deviceLabel?: string,
    context?: { ip?: string; userAgent?: string },
  ): Promise<AuthTokens> {
    const user = await this.users.findByEmail(email);

    // Every branch below records the attempt before throwing, so the
    // platform console can show who is getting in and who is failing.
    // The message stays identical throughout — a caller must not be able
    // to tell "no such account" from "wrong password" from "suspended".
    const deny = async (reason: string): Promise<never> => {
      await this.recordLogin({
        userId: user?.id ?? null,
        companyId: user?.company_id ?? null,
        email,
        success: false,
        failureReason: reason,
        ...context,
      });
      throw new UnauthorizedException('Invalid credentials');
    };

    if (!user) return deny('no_such_user');

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return deny('bad_password');
    if (!user.active) return deny('user_inactive');

    // Platform admins have no company, so there is nothing to suspend.
    if (user.company_id) {
      const company = await this.loadCompanyAccess(user.company_id);
      if (!company) return deny('company_missing');
      if (!company.active || company.subscription_status === 'suspended') {
        return deny('company_suspended');
      }
    }

    await this.recordLogin({
      userId: user.id,
      companyId: user.company_id,
      email,
      success: true,
      ...context,
    });

    return this.issueTokens(user, deviceLabel);
  }


  /**
   * Reads the access flags a login depends on.
   *
   * `active` has existed since the first migration; `subscription_status`
   * arrives in 004. If the code is deployed before that migration runs —
   * which is exactly what happened on 22 Jul — querying the newer column
   * throws 42703 and every login 500s, including for accounts that have
   * nothing to do with subscriptions.
   *
   * A pending migration should degrade one feature, not lock everyone out.
   * So the richer query is attempted first and falls back to the columns
   * that are guaranteed to exist. Once 004 is applied the fallback simply
   * stops being used; nothing needs changing here afterwards.
   */
  private async loadCompanyAccess(
    companyId: string,
  ): Promise<{ active: boolean; subscription_status: string } | null> {
    try {
      const { rows } = await this.pool.query<{ active: boolean; subscription_status: string }>(
        `SELECT active, subscription_status FROM companies WHERE id = $1`,
        [companyId],
      );
      return rows[0] ?? null;
    } catch (err: any) {
      // 42703 = undefined_column. Any other failure is a real problem and
      // must not be swallowed into a silent "allowed".
      if (err?.code !== '42703') throw err;

      console.warn(
        '[auth] companies.subscription_status is missing — migration 004 has not been applied. ' +
        'Falling back to companies.active; suspension enforcement is inactive until it runs.',
      );
      const { rows } = await this.pool.query<{ active: boolean }>(
        `SELECT active FROM companies WHERE id = $1`,
        [companyId],
      );
      return rows[0] ? { active: rows[0].active, subscription_status: 'active' } : null;
    }
  }

  /** Append-only audit. Never allowed to break a login — a failure to log
   *  must not lock someone out, so it is swallowed deliberately. */
  private async recordLogin(e: {
    userId: string | null;
    companyId: string | null;
    email: string;
    success: boolean;
    failureReason?: string;
    ip?: string;
    userAgent?: string;
  }): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO login_events
           (user_id, company_id, email, success, failure_reason, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [e.userId, e.companyId, e.email, e.success,
         e.failureReason ?? null, e.ip ?? null, e.userAgent ?? null],
      );
    } catch {
      // Intentionally ignored.
    }
  }

  // Self-serve registration was removed in migration 004's release.
  // Clients are provisioned by a platform admin (POST /platform/companies),
  // which creates the company and emails the first owner an invite; the
  // owner sets their own password via POST /invites/accept.
  //
  // Leaving an open /auth/register on a multi-tenant system means anyone
  // who finds the URL can create a company on the production instance.

  async refresh(rawRefreshToken: string): Promise<AuthTokens> {
    const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');
    const stored = await this.users.findRefreshToken(tokenHash);
    if (!stored) throw new UnauthorizedException('Invalid or expired refresh token');

    await this.users.revokeRefreshToken(tokenHash);

    const user = await this.users.findById(stored.user_id);
    if (!user) throw new UnauthorizedException('User not found');

    return this.issueTokens(user);
  }

  async logout(rawRefreshToken: string): Promise<void> {
    const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');
    await this.users.revokeRefreshToken(tokenHash);
  }

  private async issueTokens(user: any, deviceLabel?: string): Promise<AuthTokens> {
    const payload: JwtPayload = {
      sub: user.id,
      companyId: user.company_id,
      role: user.role,
      locale: user.locale,
    };

    const accessToken = this.jwt.sign(payload);

    const rawRefresh = crypto.randomBytes(40).toString('hex');
    const refreshHash = crypto.createHash('sha256').update(rawRefresh).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await this.users.storeRefreshToken({
      userId: user.id,
      tokenHash: refreshHash,
      deviceLabel,
      expiresAt,
    });

    return {
      accessToken,
      refreshToken: rawRefresh,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        locale: user.locale,
        companyId: user.company_id,
      },
    };
  }
}
