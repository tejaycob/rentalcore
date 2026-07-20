// src/auth/auth.repository.ts
//
// Thin data-access layer for auth. Two things make this different from
// every other repository in this codebase: registration has to create a
// `companies` row AND a `users` row together (a brand-new tenant has no
// company_id to scope RLS by yet), and refresh tokens are stored hashed,
// never in plaintext, matching how password_hash already works.

import { Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import * as crypto from 'crypto';

export interface RegisterParams {
  companyName: string;
  countryCode: 'MZ' | 'ZA' | 'AO';
  currency: string;
  name: string;
  email: string;
  passwordHash: string;
  locale: 'pt' | 'en';
  phone?: string;
}

export interface UserRow {
  id: string;
  companyId: string | null;
  role: 'owner' | 'property_manager' | 'accountant' | 'renter';
  name: string;
  email: string;
  phone: string | null;
  passwordHash: string;
  locale: 'pt' | 'en';
  active: boolean;
}

function hashToken(token: string): string {
  // Refresh tokens are long random strings already, so a fast SHA-256 is
  // fine here (unlike passwords, there's no low-entropy input to protect
  // against brute force) — this only guards the DB row if it ever leaks.
  return crypto.createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class AuthRepository {
  constructor(private readonly pool: Pool) {}

  /** Creates the company and its first user (role: 'owner') in one
   *  transaction. Registration is the one place in the app that runs
   *  before any RLS context exists — there is no company_id to
   *  `SET LOCAL app.company_id` to yet, because we're creating it right
   *  now. Rather than disabling RLS, we set the context to the row we
   *  just inserted, inside the same transaction, before the second
   *  insert runs — so both inserts stay covered by the normal policies. */
  async registerCompanyAndOwner(params: RegisterParams): Promise<UserRow> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const companyResult = await client.query<{ id: string }>(
        `INSERT INTO companies (name, country_code, currency, trial_ends_at)
         VALUES ($1, $2, $3, now() + interval '30 days')
         RETURNING id`,
        [params.companyName, params.countryCode, params.currency],
      );
      const companyId = companyResult.rows[0].id;

      // From here on, this transaction is scoped as if it were an
      // authenticated 'owner' of the company we just created — the same
      // session variables the tenancy guard sets on every normal request.
      await client.query(`SET LOCAL app.company_id = '${companyId}'`);
      await client.query(`SET LOCAL app.user_role = 'owner'`);

      const userResult = await client.query<{
        id: string;
        company_id: string;
        role: UserRow['role'];
        name: string;
        email: string;
        phone: string | null;
        password_hash: string;
        locale: 'pt' | 'en';
        active: boolean;
      }>(
        `INSERT INTO users (company_id, role, name, email, phone, password_hash, locale)
         VALUES ($1, 'owner', $2, $3, $4, $5, $6)
         RETURNING id, company_id, role, name, email, phone, password_hash, locale, active`,
        [companyId, params.name, params.email, params.phone ?? null, params.passwordHash, params.locale],
      );

      await client.query('COMMIT');

      const row = userResult.rows[0];
      return {
        id: row.id,
        companyId: row.company_id,
        role: row.role,
        name: row.name,
        email: row.email,
        phone: row.phone,
        passwordHash: row.password_hash,
        locale: row.locale,
        active: row.active,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Looks up a user by email for login. Runs as a plain pool query with
   *  no `SET LOCAL app.*` context, on purpose — at login time we don't
   *  know the user's company_id yet, that's what this query is for.
   *  This works despite `users` having RLS enabled because the schema
   *  never ran `ALTER TABLE users FORCE ROW LEVEL SECURITY`: by default
   *  Postgres exempts a table's *owner* role from its own RLS policies,
   *  and the DB connection here (DATABASE_URL) is that owner role, the
   *  same one the migration ran as. If the app is later switched to a
   *  non-owner DB role, this query needs a matching policy or a
   *  dedicated lookup role — flag that before making that change. */
  async findByEmail(email: string): Promise<UserRow | null> {
    const result = await this.pool.query<{
      id: string;
      company_id: string | null;
      role: UserRow['role'];
      name: string;
      email: string;
      phone: string | null;
      password_hash: string;
      locale: 'pt' | 'en';
      active: boolean;
    }>(
      `SELECT id, company_id, role, name, email, phone, password_hash, locale, active
       FROM users WHERE email = $1`,
      [email],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      id: row.id,
      companyId: row.company_id,
      role: row.role,
      name: row.name,
      email: row.email,
      phone: row.phone,
      passwordHash: row.password_hash,
      locale: row.locale,
      active: row.active,
    };
  }

  async findById(id: string): Promise<UserRow | null> {
    const result = await this.pool.query(
      `SELECT id, company_id, role, name, email, phone, password_hash, locale, active
       FROM users WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      id: row.id,
      companyId: row.company_id,
      role: row.role,
      name: row.name,
      email: row.email,
      phone: row.phone,
      passwordHash: row.password_hash,
      locale: row.locale,
      active: row.active,
    };
  }

  async storeRefreshToken(userId: string, token: string, expiresAt: Date, deviceLabel?: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, device_label, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [userId, hashToken(token), deviceLabel ?? null, expiresAt],
    );
  }

  /** Returns the user_id owning this refresh token if it's valid
   *  (not revoked, not expired), otherwise null. */
  async findValidRefreshToken(token: string): Promise<{ id: string; userId: string } | null> {
    const result = await this.pool.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM refresh_tokens
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [hashToken(token)],
    );
    if (result.rows.length === 0) return null;
    return { id: result.rows[0].id, userId: result.rows[0].user_id };
  }

  async revokeRefreshToken(token: string): Promise<void> {
    await this.pool.query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hashToken(token)],
    );
  }

  async revokeAllRefreshTokensForUser(userId: string): Promise<void> {
    await this.pool.query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
  }

  async emailExists(email: string): Promise<boolean> {
    const result = await this.pool.query(`SELECT 1 FROM users WHERE email = $1`, [email]);
    return result.rows.length > 0;
  }
}
