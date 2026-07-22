import { Injectable } from '@nestjs/common';
import { Pool } from 'pg';

@Injectable()
export class DashboardService {
  constructor(private readonly pool: Pool) {}

  async getStats(companyId: string) {
    const [units, invoices, tickets, revenue, company] = await Promise.all([
      this.pool.query(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE status = 'occupied')    AS occupied,
                COUNT(*) FILTER (WHERE status = 'vacant')      AS vacant,
                COUNT(*) FILTER (WHERE status = 'maintenance') AS maintenance
         FROM units u JOIN properties p ON p.id = u.property_id
         WHERE p.company_id = $1`,
        [companyId],
      ),
      this.pool.query(
        `SELECT COUNT(*) FILTER (WHERE status = 'pending') AS pending,
                COUNT(*) FILTER (WHERE status = 'overdue') AS overdue,
                COUNT(*) FILTER (WHERE status = 'paid'
                  AND date_trunc('month', updated_at) = date_trunc('month', now())) AS paid_this_month,
                COALESCE(SUM(amount_total) FILTER (WHERE status = 'pending'), 0) AS pending_amount,
                COALESCE(SUM(amount_total) FILTER (WHERE status = 'overdue'), 0) AS overdue_amount
         FROM invoices WHERE company_id = $1`,
        [companyId],
      ),
      this.pool.query(
        `SELECT COUNT(*) FILTER (WHERE status = 'open')        AS open,
                COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress
         FROM maintenance_tickets WHERE company_id = $1`,
        [companyId],
      ),
      this.pool.query(
        `SELECT COALESCE(SUM(rent_amount - COALESCE(rent_discount_amount, 0)), 0) AS monthly_rent
         FROM leases WHERE company_id = $1 AND status = 'active'`,
        [companyId],
      ),
      this.pool.query(`SELECT currency FROM companies WHERE id = $1`, [companyId]),
    ]);

    return {
      units: units.rows[0],
      invoices: invoices.rows[0],
      tickets: tickets.rows[0],
      monthlyRent: revenue.rows[0].monthly_rent,
      currency: company.rows[0]?.currency ?? 'MZN',
    };
  }

  /**
   * Everything the charts render. Kept in one call so the dashboard makes
   * two requests rather than six.
   */
  async getCharts(companyId: string) {
    const [billedVsCollected, statusMix, byProperty, occupancy] = await Promise.all([
      // Last 6 months: what was invoiced vs what actually came in.
      // generate_series so months with no activity still appear — a gap in
      // the line is information, an absent month is just confusing.
      this.pool.query(
        `WITH months AS (
           SELECT to_char(d, 'YYYY-MM') AS period
           FROM generate_series(
             date_trunc('month', now()) - interval '5 months',
             date_trunc('month', now()),
             interval '1 month'
           ) d
         )
         SELECT m.period,
                COALESCE(SUM(i.amount_total), 0) AS billed,
                COALESCE((
                  SELECT SUM(p.amount) FROM payments p
                  JOIN invoices i2 ON i2.id = p.invoice_id
                  WHERE i2.company_id = $1 AND i2.period = m.period AND p.status = 'succeeded'
                ), 0) AS collected
         FROM months m
         LEFT JOIN invoices i ON i.period = m.period AND i.company_id = $1
         GROUP BY m.period
         ORDER BY m.period`,
        [companyId],
      ),

      this.pool.query(
        `SELECT status, COUNT(*) AS count, COALESCE(SUM(amount_total), 0) AS amount
         FROM invoices WHERE company_id = $1
         GROUP BY status ORDER BY status`,
        [companyId],
      ),

      // Contracted monthly rent per property — where the income comes from.
      this.pool.query(
        `SELECT p.name AS property_name,
                COUNT(DISTINCT u.id) AS units,
                COUNT(DISTINCT l.id) FILTER (WHERE l.status = 'active') AS occupied,
                COALESCE(SUM(l.rent_amount - COALESCE(l.rent_discount_amount, 0))
                         FILTER (WHERE l.status = 'active'), 0) AS monthly_rent
         FROM properties p
         LEFT JOIN units u  ON u.property_id = p.id
         LEFT JOIN leases l ON l.unit_id = u.id
         WHERE p.company_id = $1 AND p.active
         GROUP BY p.id, p.name
         ORDER BY monthly_rent DESC`,
        [companyId],
      ),

      this.pool.query(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE u.status = 'occupied') AS occupied
         FROM units u JOIN properties p ON p.id = u.property_id
         WHERE p.company_id = $1`,
        [companyId],
      ),
    ]);

    const occ = occupancy.rows[0];
    const occupancyRate = Number(occ.total) > 0
      ? Math.round((Number(occ.occupied) / Number(occ.total)) * 100)
      : 0;

    // Collection rate over the window — the single number that says whether
    // the business is actually getting paid.
    const totals = billedVsCollected.rows.reduce(
      (a: any, r: any) => ({ billed: a.billed + Number(r.billed), collected: a.collected + Number(r.collected) }),
      { billed: 0, collected: 0 },
    );
    const collectionRate = totals.billed > 0
      ? Math.round((totals.collected / totals.billed) * 100)
      : 0;

    return {
      billedVsCollected: billedVsCollected.rows,
      statusMix: statusMix.rows,
      byProperty: byProperty.rows,
      occupancyRate,
      collectionRate,
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
