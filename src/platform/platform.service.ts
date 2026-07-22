import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { Pool } from 'pg';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

const INVITE_TTL_DAYS = 14;

@Injectable()
export class PlatformService {
  constructor(private readonly pool: Pool) {}

  /* ---------------------------------------------------------------- */
  /* Overview                                                          */
  /* ---------------------------------------------------------------- */

  async listCompanies() {
    const { rows } = await this.pool.query(
      `SELECT * FROM v_platform_companies ORDER BY created_at DESC`,
    );
    return rows;
  }

  async getCompany(id: string) {
    const { rows } = await this.pool.query(
      `SELECT * FROM v_platform_companies WHERE id = $1`, [id],
    );
    if (!rows[0]) throw new NotFoundException('Company not found');

    const [users, invites, logins] = await Promise.all([
      this.pool.query(
        `SELECT id, name, email, role, active, created_at
         FROM users WHERE company_id = $1 ORDER BY role, name`, [id]),
      this.pool.query(
        `SELECT id, email, role, expires_at, accepted_at, revoked_at, created_at
         FROM invites WHERE company_id = $1 ORDER BY created_at DESC LIMIT 20`, [id]),
      this.pool.query(
        `SELECT email, success, failure_reason, created_at
         FROM login_events WHERE company_id = $1
         ORDER BY created_at DESC LIMIT 20`, [id]),
    ]);

    return {
      ...rows[0],
      users: users.rows,
      invites: invites.rows,
      recentLogins: logins.rows,
    };
  }

  /** Headline numbers for the console. */
  async getSummary() {
    const { rows } = await this.pool.query(
      `SELECT
         COUNT(*)                                                   AS companies,
         COUNT(*) FILTER (WHERE subscription_status = 'trialing')   AS trialing,
         COUNT(*) FILTER (WHERE subscription_status = 'active')     AS active,
         COUNT(*) FILTER (WHERE subscription_status = 'past_due')   AS past_due,
         COUNT(*) FILTER (WHERE subscription_status = 'suspended')  AS suspended,
         COALESCE(SUM(unit_count), 0)                               AS total_units,
         COALESCE(SUM(staff_count + tenant_count), 0)               AS total_users,
         COUNT(*) FILTER (WHERE last_login_at > now() - interval '7 days') AS active_last_7d,
         COUNT(*) FILTER (WHERE subscription_status = 'trialing'
                            AND trial_ends_at < now() + interval '7 days') AS trials_ending_soon
       FROM v_platform_companies`,
    );
    return rows[0];
  }

  /* ---------------------------------------------------------------- */
  /* Provisioning a client                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Creates the client company and an invite for their first owner, in one
   * transaction. No password is set here — the owner sets their own via the
   * invite link, so you never handle a client's credentials.
   */
  async createCompany(params: {
    name: string;
    countryCode: 'MZ' | 'ZA' | 'AO';
    currency: string;
    planTier?: string;
    unitLimit?: number;
    trialDays?: number;
    ownerName: string;
    ownerEmail: string;
    notes?: string;
  }, invitedBy: string) {
    const existing = await this.pool.query(
      `SELECT id FROM users WHERE lower(email) = lower($1)`, [params.ownerEmail]);
    if (existing.rows[0]) {
      throw new ConflictException('That email already has an account');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const trialDays = params.trialDays ?? 30;
      const { rows: [company] } = await client.query(
        `INSERT INTO companies
           (name, country_code, currency, plan_tier, unit_limit, notes,
            trial_ends_at, subscription_status)
         VALUES ($1, $2, $3, COALESCE($4,'starter'), $5, $6,
                 now() + ($7 || ' days')::interval, 'trialing')
         RETURNING id, name`,
        [params.name, params.countryCode, params.currency, params.planTier,
         params.unitLimit ?? null, params.notes ?? null, String(trialDays)],
      );

      // Seed the company's late-fee tiers so invoicing works on day one.
      // Mirrors what migration 002 seeded for existing companies.
      await client.query(
        `INSERT INTO late_fee_policies
           (company_id, tier, min_days_late, max_days_late, percent_of_rent, terminable, description)
         VALUES
           ($1, 1,  5,   15, 20.00, false, 'Atraso de 5 a 15 dias'),
           ($1, 2, 15,   30, 50.00, false, 'Atraso de 15 a 30 dias'),
           ($1, 3, 30, NULL, 50.00, true,  'Atraso superior a 30 dias — rescisão')`,
        [company.id],
      );

      const invite = await this.createInviteRow(client, {
        email: params.ownerEmail,
        name: params.ownerName,
        role: 'owner',
        companyId: company.id,
        invitedBy,
      });

      await client.query('COMMIT');
      return { company, invite };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Subscription control                                              */
  /* ---------------------------------------------------------------- */

  async setSubscription(companyId: string, body: {
    subscription_status?: string;
    paid_until?: string | null;
    plan_tier?: string;
    unit_limit?: number | null;
    trial_ends_at?: string | null;
    notes?: string;
  }) {
    const editable = ['subscription_status', 'paid_until', 'plan_tier',
                      'unit_limit', 'trial_ends_at', 'notes'] as const;
    const sets: string[] = [];
    const params: unknown[] = [companyId];

    for (const f of editable) {
      if (Object.prototype.hasOwnProperty.call(body, f)) {
        params.push((body as any)[f] === '' ? null : (body as any)[f]);
        sets.push(`${f} = $${params.length}`);
      }
    }
    if (!sets.length) throw new BadRequestException('No fields supplied');

    // Keep `active` consistent with the status rather than letting the two
    // drift apart — `active` is what the login check reads.
    sets.push(`active = (COALESCE($${params.push(body.subscription_status ?? null)}, subscription_status) <> 'suspended')`);

    const { rows } = await this.pool.query(
      `UPDATE companies SET ${sets.join(', ')} WHERE id = $1 RETURNING id`, params);
    if (!rows[0]) throw new NotFoundException('Company not found');
    return this.getCompany(companyId);
  }

  async suspend(companyId: string, reason: string) {
    const { rows } = await this.pool.query(
      `UPDATE companies
          SET subscription_status = 'suspended',
              suspended_at = now(),
              suspended_reason = $2,
              active = false
        WHERE id = $1 RETURNING id`,
      [companyId, reason],
    );
    if (!rows[0]) throw new NotFoundException('Company not found');
    return this.getCompany(companyId);
  }

  async reactivate(companyId: string) {
    const { rows } = await this.pool.query(
      `UPDATE companies
          SET subscription_status = 'active',
              suspended_at = NULL,
              suspended_reason = NULL,
              active = true
        WHERE id = $1 RETURNING id`,
      [companyId],
    );
    if (!rows[0]) throw new NotFoundException('Company not found');
    return this.getCompany(companyId);
  }

  /* ---------------------------------------------------------------- */
  /* Invites                                                           */
  /* ---------------------------------------------------------------- */

  /** Shared by createCompany (inside its transaction) and inviteUser. */
  private async createInviteRow(
    db: { query: (t: string, p?: any[]) => Promise<any> },
    params: { email: string; name?: string; role: string; companyId: string | null; invitedBy: string },
  ) {
    const raw = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');

    const { rows } = await db.query(
      `INSERT INTO invites (token_hash, email, name, role, company_id, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' days')::interval)
       RETURNING id, email, role, expires_at`,
      [hash, params.email, params.name ?? null, params.role,
       params.companyId, params.invitedBy, String(INVITE_TTL_DAYS)],
    );

    // The raw token is returned exactly once, here. Only its hash is
    // stored, so it cannot be recovered later — reissue instead.
    return { ...rows[0], token: raw };
  }

  async inviteUser(params: {
    email: string; name?: string; role: string; companyId: string | null;
  }, invitedBy: string) {
    const existing = await this.pool.query(
      `SELECT id FROM users WHERE lower(email) = lower($1)`, [params.email]);
    if (existing.rows[0]) throw new ConflictException('That email already has an account');

    if (params.role === 'platform_admin' && params.companyId) {
      throw new BadRequestException('A platform admin cannot belong to a company');
    }
    if (params.role !== 'platform_admin' && !params.companyId) {
      throw new BadRequestException('companyId is required for non-platform roles');
    }

    return this.createInviteRow(this.pool, { ...params, invitedBy });
  }

  async listInvites(companyId?: string) {
    const { rows } = await this.pool.query(
      `SELECT i.id, i.email, i.name, i.role, i.company_id, i.expires_at,
              i.accepted_at, i.revoked_at, i.created_at,
              c.name AS company_name,
              CASE
                WHEN i.revoked_at  IS NOT NULL THEN 'revoked'
                WHEN i.accepted_at IS NOT NULL THEN 'accepted'
                WHEN i.expires_at  < now()     THEN 'expired'
                ELSE 'pending'
              END AS status
       FROM invites i
       LEFT JOIN companies c ON c.id = i.company_id
       WHERE ($1::uuid IS NULL OR i.company_id = $1::uuid)
       ORDER BY i.created_at DESC
       LIMIT 200`,
      [companyId ?? null],
    );
    return rows;
  }

  async revokeInvite(id: string) {
    const { rows } = await this.pool.query(
      `UPDATE invites SET revoked_at = now()
        WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
        RETURNING id`, [id]);
    if (!rows[0]) throw new NotFoundException('Invite not found, already used, or already revoked');
    return { revoked: true };
  }

  /**
   * Public — the invite recipient calls this with the token from their link
   * and chooses their own password.
   *
   * Every failure returns the same message on purpose: a caller probing
   * tokens learns nothing about which ones exist.
   */
  async acceptInvite(token: string, password: string, name?: string) {
    if (!password || password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters');
    }
    const hash = crypto.createHash('sha256').update(token).digest('hex');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [invite] } = await client.query(
        `SELECT id, email, name, role, company_id
           FROM invites
          WHERE token_hash = $1
            AND accepted_at IS NULL
            AND revoked_at IS NULL
            AND expires_at > now()
          FOR UPDATE`,
        [hash],
      );
      if (!invite) throw new BadRequestException('This invite link is invalid or has expired');

      const { rows: [dupe] } = await client.query(
        `SELECT id FROM users WHERE lower(email) = lower($1)`, [invite.email]);
      if (dupe) throw new ConflictException('That email already has an account');

      const passwordHash = await bcrypt.hash(password, 12);
      const { rows: [user] } = await client.query(
        `INSERT INTO users (company_id, role, name, email, password_hash, locale)
         VALUES ($1, $2, $3, $4, $5, 'pt')
         RETURNING id, name, email, role, company_id`,
        [invite.company_id, invite.role, name ?? invite.name ?? invite.email,
         invite.email, passwordHash],
      );

      await client.query(
        `UPDATE invites SET accepted_at = now(), accepted_user_id = $2 WHERE id = $1`,
        [invite.id, user.id],
      );

      await client.query('COMMIT');
      return user;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Public — lets the accept page show who the invite is for before submit. */
  async peekInvite(token: string) {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const { rows } = await this.pool.query(
      `SELECT i.email, i.name, i.role, c.name AS company_name
         FROM invites i
         LEFT JOIN companies c ON c.id = i.company_id
        WHERE i.token_hash = $1
          AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`,
      [hash],
    );
    if (!rows[0]) throw new BadRequestException('This invite link is invalid or has expired');
    return rows[0];
  }
}
