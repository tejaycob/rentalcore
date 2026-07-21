import { Injectable } from '@nestjs/common';
import { Pool } from 'pg';

export interface UserRow {
  id: string;
  company_id: string;
  role: 'owner' | 'property_manager' | 'accountant' | 'renter';
  name: string;
  email: string;
  phone: string | null;
  password_hash: string;
  locale: 'pt' | 'en';
  active: boolean;
}

@Injectable()
export class UsersRepository {
  constructor(private readonly pool: Pool) {}

  async findByEmail(email: string): Promise<UserRow | null> {
    // Bypass RLS for login — user isn't authenticated yet so no session vars set
    const { rows } = await this.pool.query<UserRow>(
      `SELECT id, company_id, role, name, email, phone, password_hash, locale, active
       FROM users WHERE email = $1 AND active = true`,
      [email],
    );
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<UserRow | null> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT id, company_id, role, name, email, phone, password_hash, locale, active
       FROM users WHERE id = $1 AND active = true`,
      [id],
    );
    return rows[0] ?? null;
  }

  async create(params: {
    companyId: string;
    role: UserRow['role'];
    name: string;
    email: string;
    phone?: string;
    passwordHash: string;
    locale: 'pt' | 'en';
  }): Promise<UserRow> {
    const { rows } = await this.pool.query<UserRow>(
      `INSERT INTO users (company_id, role, name, email, phone, password_hash, locale)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, company_id, role, name, email, phone, password_hash, locale, active`,
      [params.companyId, params.role, params.name, params.email,
       params.phone ?? null, params.passwordHash, params.locale],
    );
    return rows[0];
  }

  async storeRefreshToken(params: {
    userId: string;
    tokenHash: string;
    deviceLabel?: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, device_label, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [params.userId, params.tokenHash, params.deviceLabel ?? null, params.expiresAt],
    );
  }

  async findRefreshToken(tokenHash: string): Promise<{ user_id: string; expires_at: Date } | null> {
    const { rows } = await this.pool.query<{ user_id: string; expires_at: Date }>(
      `SELECT user_id, expires_at FROM refresh_tokens
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [tokenHash],
    );
    return rows[0] ?? null;
  }

  async revokeRefreshToken(tokenHash: string): Promise<void> {
    await this.pool.query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1`,
      [tokenHash],
    );
  }
}
