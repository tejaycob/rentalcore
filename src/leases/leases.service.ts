import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Pool } from 'pg';
import * as bcrypt from 'bcrypt';

@Injectable()
export class LeasesService {
  constructor(private readonly pool: Pool) {}

  async findAll(companyId: string) {
    const { rows } = await this.pool.query(
      `SELECT l.id, l.unit_id, l.renter_id, l.start_date, l.end_date,
              l.rent_amount, l.deposit_amount, l.status, l.created_at,
              u.label AS unit_label, p.name AS property_name, p.city,
              usr.name AS renter_name, usr.email AS renter_email, usr.phone AS renter_phone,
              -- Effective currency: lease override, else property, else company.
              COALESCE(l.currency, p.currency, c.currency) AS currency
       FROM leases l
       JOIN units u ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
       JOIN users usr ON usr.id = l.renter_id
       JOIN companies c ON c.id = l.company_id
       WHERE l.company_id = $1
       ORDER BY l.created_at DESC`,
      [companyId],
    );
    return rows;
  }

  async findOne(id: string, companyId: string) {
    const { rows } = await this.pool.query(
      `SELECT l.id, l.unit_id, l.renter_id, l.start_date, l.end_date,
              l.rent_amount, l.deposit_amount, l.status, l.document_url, l.created_at,
              u.label AS unit_label, p.name AS property_name, p.address, p.city,
              usr.name AS renter_name, usr.email AS renter_email, usr.phone AS renter_phone, usr.locale AS renter_locale
       FROM leases l
       JOIN units u ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
       JOIN users usr ON usr.id = l.renter_id
       WHERE l.id = $1 AND l.company_id = $2`,
      [id, companyId],
    );
    if (!rows[0]) throw new NotFoundException('Lease not found');
    return rows[0];
  }

  async create(companyId: string, body: {
    unitId: string;
    renterName: string;
    renterEmail: string;
    renterPhone?: string;
    renterLocale: 'pt' | 'en';
    startDate: string;
    endDate: string;
    rentAmount: number;
    depositAmount?: number;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Check unit belongs to company and is vacant
      const { rows: [unit] } = await client.query(
        `SELECT u.id FROM units u JOIN properties p ON p.id = u.property_id
         WHERE u.id = $1 AND p.company_id = $2 AND u.status = 'vacant'`,
        [body.unitId, companyId],
      );
      if (!unit) throw new BadRequestException('Unit not found or not available');

      // Create or find renter user
      let { rows: [renter] } = await client.query(
        `SELECT id FROM users WHERE email = $1`,
        [body.renterEmail],
      );
      if (!renter) {
        const tmpPassword = await bcrypt.hash(Math.random().toString(36).slice(2) + 'Aa1!', 10);
        const { rows: [newRenter] } = await client.query(
          `INSERT INTO users (company_id, role, name, email, phone, password_hash, locale)
           VALUES ($1, 'renter', $2, $3, $4, $5, $6)
           RETURNING id`,
          [companyId, body.renterName, body.renterEmail, body.renterPhone ?? null, tmpPassword, body.renterLocale],
        );
        renter = newRenter;
      }

      // Create lease
      const { rows: [lease] } = await client.query(
        `INSERT INTO leases (company_id, unit_id, renter_id, start_date, end_date, rent_amount, deposit_amount, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
         RETURNING id, status`,
        [companyId, body.unitId, renter.id, body.startDate, body.endDate,
         body.rentAmount, body.depositAmount ?? 0],
      );

      // Mark unit occupied
      await client.query(
        `UPDATE units SET status = 'occupied' WHERE id = $1`,
        [body.unitId],
      );

      await client.query('COMMIT');
      return this.findOne(lease.id, companyId);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }


  /** Whitelisted lease fields the UI may change after creation. Anything
   *  not listed is ignored, so a stray key can never touch company_id,
   *  renter_id or status (status changes go through terminate()). */
  private static readonly EDITABLE = [
    'rent_due_day',
    'currency',
    'deposit_status',
    'deposit_amount',
    'notice_period_days',
    'next_review_date',
    'rent_discount_amount',
    'rent_discount_reason',
    'utilities_water',
    'utilities_electricity',
    'utilities_wifi',
    'utilities_trash',
  ] as const;

  async update(id: string, companyId: string, body: Record<string, unknown>) {
    const sets: string[] = [];
    const params: unknown[] = [id, companyId];

    for (const field of LeasesService.EDITABLE) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        const v = body[field];
        params.push(v === '' ? null : v);
        sets.push(`${field} = $${params.length}`);
      }
    }
    if (sets.length === 0) throw new BadRequestException('No editable fields supplied');

    const { rows } = await this.pool.query(
      `UPDATE leases SET ${sets.join(', ')}
       WHERE id = $1 AND company_id = $2
       RETURNING id`,
      params,
    );
    if (!rows[0]) throw new NotFoundException('Lease not found');
    return this.findOne(id, companyId);
  }

  async terminate(id: string, companyId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [lease] } = await client.query(
        `UPDATE leases SET status = 'terminated' WHERE id = $1 AND company_id = $2 RETURNING unit_id`,
        [id, companyId],
      );
      if (lease) {
        await client.query(`UPDATE units SET status = 'vacant' WHERE id = $1`, [lease.unit_id]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
