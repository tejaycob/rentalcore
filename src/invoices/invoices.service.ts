import { Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';

@Injectable()
export class InvoicesService {
  constructor(private readonly pool: Pool) {}

  async findAll(companyId: string, filters: { status?: string; leaseId?: string } = {}) {
    const conditions = ['i.company_id = $1'];
    const params: any[] = [companyId];
    if (filters.status) { conditions.push(`i.status = $${params.push(filters.status)}`); }
    if (filters.leaseId) { conditions.push(`i.lease_id = $${params.push(filters.leaseId)}`); }

    const { rows } = await this.pool.query(
      `SELECT i.id, i.lease_id, i.period, i.amount_due, i.due_date, i.status, i.created_at,
              u.label AS unit_label, p.name AS property_name,
              usr.name AS renter_name, usr.email AS renter_email
       FROM invoices i
       JOIN leases l ON l.id = i.lease_id
       JOIN units u ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
       JOIN users usr ON usr.id = l.renter_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY i.due_date DESC`,
      params,
    );
    return rows;
  }

  async findOne(id: string, companyId: string) {
    const { rows } = await this.pool.query(
      `SELECT i.id, i.lease_id, i.period, i.amount_due, i.due_date, i.status, i.created_at,
              u.label AS unit_label, p.name AS property_name, p.address, p.city,
              usr.name AS renter_name, usr.email AS renter_email, usr.locale AS renter_locale,
              json_agg(json_build_object(
                'id', pay.id, 'method', pay.method, 'amount', pay.amount,
                'status', pay.status, 'created_at', pay.created_at
              ) ORDER BY pay.created_at DESC) FILTER (WHERE pay.id IS NOT NULL) AS payments
       FROM invoices i
       JOIN leases l ON l.id = i.lease_id
       JOIN units u ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
       JOIN users usr ON usr.id = l.renter_id
       LEFT JOIN payments pay ON pay.invoice_id = i.id
       WHERE i.id = $1 AND i.company_id = $2
       GROUP BY i.id, u.label, p.name, p.address, p.city, usr.name, usr.email, usr.locale`,
      [id, companyId],
    );
    if (!rows[0]) throw new NotFoundException('Invoice not found');
    return rows[0];
  }

  async generate(companyId: string, body: { leaseId: string; period: string; dueDate: string }) {
    // period format: YYYY-MM
    const { rows: [lease] } = await this.pool.query(
      `SELECT id, rent_amount FROM leases WHERE id = $1 AND company_id = $2 AND status = 'active'`,
      [body.leaseId, companyId],
    );
    if (!lease) throw new NotFoundException('Active lease not found');

    const { rows } = await this.pool.query(
      `INSERT INTO invoices (company_id, lease_id, period, amount_due, due_date)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (lease_id, period) DO NOTHING
       RETURNING id`,
      [companyId, body.leaseId, body.period, lease.rent_amount, body.dueDate],
    );
    return rows[0] ? this.findOne(rows[0].id, companyId)
                   : { error: 'Invoice already exists for this period' };
  }

  async generateForAll(companyId: string, period: string): Promise<{ generated: number }> {
    // Generate invoices for all active leases that don't have one for this period
    const { rows } = await this.pool.query(
      `INSERT INTO invoices (company_id, lease_id, period, amount_due, due_date)
       SELECT $1, l.id, $2, l.rent_amount,
              (date_trunc('month', $2::date) + interval '1 month' - interval '1 day')::date
       FROM leases l
       WHERE l.company_id = $1 AND l.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.lease_id = l.id AND i.period = $2)
       RETURNING id`,
      [companyId, period + '-01'],
    );
    return { generated: rows.length };
  }

  async updateStatus(id: string, companyId: string, status: string) {
    const { rows } = await this.pool.query(
      `UPDATE invoices SET status = $3 WHERE id = $1 AND company_id = $2 RETURNING id, status`,
      [id, companyId, status],
    );
    if (!rows[0]) throw new NotFoundException('Invoice not found');
    return rows[0];
  }
}
