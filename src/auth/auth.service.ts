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

  async login(email: string, password: string, deviceLabel?: string): Promise<AuthTokens> {
    const user = await this.users.findByEmail(email);
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    return this.issueTokens(user, deviceLabel);
  }

  async register(params: {
    companyName: string;
    countryCode: 'MZ' | 'ZA' | 'AO';
    currency: string;
    name: string;
    email: string;
    password: string;
    locale: 'pt' | 'en';
    phone?: string;
  }): Promise<AuthTokens> {
    // Check email not taken (outside RLS since no session yet)
    const existing = await this.users.findByEmail(params.email);
    if (existing) throw new ConflictException('Email already registered');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Create company. The trial lives on companies.plan_tier /
      // companies.trial_ends_at — both confirmed present in the migration.
      // An earlier version also inserted a row into `subscriptions` using
      // column names that were never checked against the real schema; if any
      // of them didn't exist, Postgres aborted the transaction and register
      // failed with an opaque 500. Removed rather than guessed at. Billing
      // can populate `subscriptions` later, once its shape is confirmed.
      const { rows: [company] } = await client.query<{ id: string }>(
        `INSERT INTO companies (name, country_code, currency, plan_tier, trial_ends_at)
         VALUES ($1, $2, $3, 'starter', now() + interval '30 days')
         RETURNING id`,
        [params.companyName, params.countryCode, params.currency],
      );

      const hash = await bcrypt.hash(params.password, 12);
      const { rows: [user] } = await client.query(
        `INSERT INTO users (company_id, role, name, email, phone, password_hash, locale)
         VALUES ($1, 'owner', $2, $3, $4, $5, $6)
         RETURNING id, company_id, role, name, email, phone, password_hash, locale, active`,
        [company.id, params.name, params.email, params.phone ?? null, hash, params.locale],
      );

      await client.query('COMMIT');
      return this.issueTokens(user);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

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
