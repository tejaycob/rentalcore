import {
  Injectable, NotFoundException, BadRequestException, ForbiddenException, ConflictException,
} from '@nestjs/common';
import { Pool } from 'pg';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

/** Roles a company owner may assign. 'renter' is excluded on purpose —
 *  renters are created by the lease flow, which also links them to a unit.
 *  'platform_admin' is excluded because it is not a company role at all. */
const ASSIGNABLE_ROLES = ['owner', 'property_manager', 'accountant'] as const;
type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

const INVITE_TTL_DAYS = 14;

@Injectable()
export class UsersService {
  constructor(private readonly pool: Pool) {}

  /* ---------------------------------------------------------------- */
  /* Team list                                                         */
  /* ---------------------------------------------------------------- */

  async listStaff(companyId: string) {
    const { rows } = await this.pool.query(
      `SELECT u.id, u.name, u.email, u.phone, u.role, u.active, u.locale, u.created_at,
              (SELECT MAX(le.created_at) FROM login_events le
                WHERE le.user_id = u.id AND le.success) AS last_login_at
       FROM users u
       WHERE u.company_id = $1 AND u.role <> 'renter'
       ORDER BY
         CASE u.role WHEN 'owner' THEN 1 WHEN 'property_manager' THEN 2 ELSE 3 END,
         u.name`,
      [companyId],
    );
    return rows;
  }

  /** One user's profile. Scoped to the caller's company so an id from
   *  another tenant returns 404 rather than data. */
  async getOne(id: string, companyId: string) {
    const { rows } = await this.pool.query(
      `SELECT u.id, u.name, u.email, u.phone, u.role, u.active, u.locale, u.created_at,
              u.id_type, u.id_number, u.nuit,
              u.employer_name, u.occupation, u.work_phone,
              u.emergency_contact_name, u.emergency_contact_relationship,
              u.emergency_contact_phone
       FROM users u WHERE u.id = $1 AND u.company_id = $2`,
      [id, companyId],
    );
    if (!rows[0]) throw new NotFoundException('User not found');

    const logins = await this.pool.query(
      `SELECT success, failure_reason, ip_address, created_at
       FROM login_events WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 10`,
      [id],
    );
    return { ...rows[0], recentLogins: logins.rows };
  }

  /* ---------------------------------------------------------------- */
  /* Inviting staff                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * A company owner invites their own staff. Same mechanism as platform
   * invites: only a hash is stored, the raw token is returned once.
   */
  async inviteStaff(
    companyId: string,
    invitedBy: string,
    body: { email: string; name?: string; role: string },
  ) {
    if (!ASSIGNABLE_ROLES.includes(body.role as AssignableRole)) {
      throw new BadRequestException(
        `Role must be one of: ${ASSIGNABLE_ROLES.join(', ')}`,
      );
    }

    const { rows: [existing] } = await this.pool.query(
      `SELECT id FROM users WHERE lower(email) = lower($1)`, [body.email]);
    if (existing) throw new ConflictException('That email already has an account');

    const raw = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');

    const { rows } = await this.pool.query(
      `INSERT INTO invites (token_hash, email, name, role, company_id, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' days')::interval)
       RETURNING id, email, role, expires_at`,
      [hash, body.email, body.name ?? null, body.role, companyId, invitedBy,
       String(INVITE_TTL_DAYS)],
    );
    return { ...rows[0], token: raw };
  }

  async listPendingInvites(companyId: string) {
    const { rows } = await this.pool.query(
      `SELECT id, email, name, role, expires_at, created_at
       FROM invites
       WHERE company_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
         AND expires_at > now()
       ORDER BY created_at DESC`,
      [companyId],
    );
    return rows;
  }

  /* ---------------------------------------------------------------- */
  /* Changing a colleague                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Role and active-flag changes.
   *
   * Two guards that matter:
   *  - you cannot change your own role or deactivate yourself, so an owner
   *    can't accidentally lock themselves out of their own company
   *  - the last active owner cannot be demoted or deactivated, so a company
   *    can never end up with nobody able to administer it
   */
  async updateStaff(
    id: string,
    companyId: string,
    actingUserId: string,
    body: { role?: string; active?: boolean },
  ) {
    if (id === actingUserId) {
      throw new BadRequestException(
        'You cannot change your own role or status — ask another owner',
      );
    }

    const { rows: [target] } = await this.pool.query(
      `SELECT id, role, active FROM users WHERE id = $1 AND company_id = $2`,
      [id, companyId],
    );
    if (!target) throw new NotFoundException('User not found');
    if (target.role === 'renter') {
      throw new BadRequestException('Tenants are managed from the Tenants page');
    }

    const losingOwner =
      target.role === 'owner' &&
      ((body.role && body.role !== 'owner') || body.active === false);

    if (losingOwner) {
      const { rows: [{ count }] } = await this.pool.query<{ count: string }>(
        `SELECT COUNT(*)::int AS count FROM users
          WHERE company_id = $1 AND role = 'owner' AND active AND id <> $2`,
        [companyId, id],
      );
      if (Number(count) === 0) {
        throw new BadRequestException(
          'This is the last active owner — promote someone else first',
        );
      }
    }

    const sets: string[] = [];
    const params: unknown[] = [id, companyId];

    if (body.role !== undefined) {
      if (!ASSIGNABLE_ROLES.includes(body.role as AssignableRole)) {
        throw new BadRequestException(`Role must be one of: ${ASSIGNABLE_ROLES.join(', ')}`);
      }
      params.push(body.role);
      sets.push(`role = $${params.length}`);
    }
    if (body.active !== undefined) {
      params.push(body.active);
      sets.push(`active = $${params.length}`);
    }
    if (!sets.length) throw new BadRequestException('Nothing to update');

    await this.pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $1 AND company_id = $2`,
      params,
    );
    return this.getOne(id, companyId);
  }

  /* ---------------------------------------------------------------- */
  /* Your own profile                                                  */
  /* ---------------------------------------------------------------- */

  async getMyProfile(userId: string) {
    const { rows } = await this.pool.query(
      `SELECT u.id, u.name, u.email, u.phone, u.role, u.locale, u.created_at,
              u.company_id, c.name AS company_name, c.currency, c.country_code
       FROM users u
       LEFT JOIN companies c ON c.id = u.company_id
       WHERE u.id = $1`,
      [userId],
    );
    if (!rows[0]) throw new NotFoundException('User not found');
    return rows[0];
  }

  /** Name, phone and language only. Role and company are deliberately not
   *  editable here — otherwise anyone could promote themselves. */
  async updateMyProfile(
    userId: string,
    body: { name?: string; phone?: string; locale?: string },
  ) {
    const sets: string[] = [];
    const params: unknown[] = [userId];

    if (body.name !== undefined) {
      if (!body.name.trim()) throw new BadRequestException('Name cannot be empty');
      params.push(body.name.trim());
      sets.push(`name = $${params.length}`);
    }
    if (body.phone !== undefined) {
      params.push(body.phone || null);
      sets.push(`phone = $${params.length}`);
    }
    if (body.locale !== undefined) {
      if (!['pt', 'en'].includes(body.locale)) {
        throw new BadRequestException('Language must be pt or en');
      }
      params.push(body.locale);
      sets.push(`locale = $${params.length}`);
    }
    if (!sets.length) throw new BadRequestException('Nothing to update');

    await this.pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $1`, params);
    return this.getMyProfile(userId);
  }

  /**
   * Password change.
   *
   * Requires the current password even though the caller is authenticated —
   * a stolen session should not be enough to lock the real owner out. All
   * refresh tokens are revoked afterwards so other devices are signed out.
   */
  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    if (!newPassword || newPassword.length < 8) {
      throw new BadRequestException('New password must be at least 8 characters');
    }
    if (currentPassword === newPassword) {
      throw new BadRequestException('The new password must be different');
    }

    const { rows: [user] } = await this.pool.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id = $1`, [userId]);
    if (!user) throw new NotFoundException('User not found');

    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) throw new ForbiddenException('Current password is incorrect');

    const hash = await bcrypt.hash(newPassword, 12);
    await this.pool.query(
      `UPDATE users SET password_hash = $2 WHERE id = $1`, [userId, hash]);

    // Sign out everywhere else. Best-effort: the password is already
    // changed, so a failure here must not surface as "change failed".
    try {
      await this.pool.query(
        `UPDATE refresh_tokens SET revoked_at = now()
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      );
    } catch {
      /* ignored */
    }

    return { changed: true };
  }
}
