import { Injectable } from '@nestjs/common';
import { Pool } from 'pg';

@Injectable()
export class DashboardService {
  constructor(private readonly pool: Pool) {}

  async getStats(companyId: string) {
    const [units, invoices, tickets, revenue] = await Promise.all([
      this.pool.query(
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE status = 'occupied') AS occupied,
           COUNT(*) FILTER (WHERE status = 'vacant') AS vacant,
           COUNT(*) FILTER (WHERE status = 'maintenance') AS maintenance
         FROM units u
         JOIN properties p ON p.id = u.property_id
         WHERE p.company_id = $1`,
        [companyId],
      ),
      this.pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'pending') AS pending,
           COUNT(*) FILTER (WHERE status = 'overdue') AS overdue,
           COUNT(*) FILTER (WHERE status = 'paid' AND date_trunc('month', updated_at) = date_trunc('month', now())) AS paid_this_month,
           COALESCE(SUM(amount_due) FILTER (WHERE status = 'pending'), 0) AS pending_amount,
           COALESCE(SUM(amount_due) FILTER (WHERE status = 'overdue'), 0) AS overdue_amount
         FROM invoices WHERE company_id = $1`,
        [companyId],
      ),
      this.pool.query(
        `SELECT COUNT(*) FILTER (WHERE status = 'open') AS open,
                COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress
         FROM maintenance_tickets WHERE company_id = $1`,
        [companyId],
      ),
      this.pool.query(
        `SELECT COALESCE(SUM(l.rent_amount), 0) AS monthly_rent
         FROM leases l WHERE l.company_id = $1 AND l.status = 'active'`,
        [companyId],
      ),
    ]);

    return {
      units: units.rows[0],
      invoices: invoices.rows[0],
      tickets: tickets.rows[0],
      monthlyRent: revenue.rows[0].monthly_rent,
    };
  }

  async getRecentActivity(companyId: string) {
    const { rows } = await this.pool.query(
      `SELECT 'invoice' AS type, i.id, i.period AS label, i.status, i.created_at,
              usr.name AS subject
       FROM invoices i
       JOIN leases l ON l.id = i.lease_id
       JOIN users usr ON usr.id = l.renter_id
       WHERE i.company_id = $1
       UNION ALL
       SELECT 'ticket' AS type, t.id, t.title AS label, t.status, t.opened_at AS created_at,
              u.label AS subject
       FROM maintenance_tickets t
       JOIN units u ON u.id = t.unit_id
       WHERE t.company_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [companyId],
    );
    return rows;
  }
}
