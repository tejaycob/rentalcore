import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Pool } from 'pg';

@Injectable()
export class InvoicesService {
  constructor(private readonly pool: Pool) {}

  async findAll(companyId: string, filters: { status?: string; leaseId?: string } = {}) {
    const conditions = ['i.company_id = $1'];
    const params: any[] = [companyId];
    if (filters.status)  conditions.push(`i.status = $${params.push(filters.status)}`);
    if (filters.leaseId) conditions.push(`i.lease_id = $${params.push(filters.leaseId)}`);

    const { rows } = await this.pool.query(
      `SELECT i.id, i.lease_id, i.period, i.amount_due, i.due_date, i.status, i.created_at,
              i.late_fee_amount, i.late_fee_tier, i.days_late, i.amount_total,
              u.label AS unit_label, p.name AS property_name,
              usr.id AS renter_id, usr.name AS renter_name, usr.email AS renter_email,
              COALESCE(l.currency, p.currency, c.currency) AS currency,
              -- how much has actually landed against this invoice
              COALESCE(pay.paid, 0) AS amount_paid,
              (i.amount_total - COALESCE(pay.paid, 0)) AS balance
       FROM invoices i
       JOIN leases l     ON l.id = i.lease_id
       JOIN units u      ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
       JOIN companies c  ON c.id = i.company_id
       JOIN users usr    ON usr.id = l.renter_id
       LEFT JOIN LATERAL (
         SELECT SUM(amount) AS paid FROM payments
         WHERE invoice_id = i.id AND status = 'succeeded'
       ) pay ON true
       WHERE ${conditions.join(' AND ')}
       ORDER BY i.due_date DESC`,
      params,
    );
    return rows;
  }

  async findOne(id: string, companyId: string) {
    const { rows } = await this.pool.query(
      `SELECT i.id, i.lease_id, i.period, i.amount_due, i.due_date, i.status, i.created_at,
              i.late_fee_amount, i.late_fee_tier, i.days_late, i.amount_total,
              u.label AS unit_label, p.name AS property_name, p.address, p.city,
              usr.name AS renter_name, usr.email AS renter_email, usr.locale AS renter_locale,
              usr.nuit AS renter_nuit, usr.id_number AS renter_id_number,
              COALESCE(l.currency, p.currency, c.currency) AS currency,
              c.name AS company_name, c.bank_name, c.bank_account_name,
              c.bank_account_number, c.bank_nib, c.payment_instructions,
              COALESCE(json_agg(json_build_object(
                'id', pay.id, 'method', pay.method, 'amount', pay.amount,
                'status', pay.status, 'created_at', pay.created_at
              ) ORDER BY pay.created_at DESC) FILTER (WHERE pay.id IS NOT NULL), '[]') AS payments
       FROM invoices i
       JOIN leases l     ON l.id = i.lease_id
       JOIN units u      ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
       JOIN companies c  ON c.id = i.company_id
       JOIN users usr    ON usr.id = l.renter_id
       LEFT JOIN payments pay ON pay.invoice_id = i.id
       WHERE i.id = $1 AND i.company_id = $2
       GROUP BY i.id, u.label, p.name, p.address, p.city, usr.name, usr.email,
                usr.locale, usr.nuit, usr.id_number, l.currency, p.currency,
                c.currency, c.name, c.bank_name, c.bank_account_name,
                c.bank_account_number, c.bank_nib, c.payment_instructions`,
      [id, companyId],
    );
    if (!rows[0]) throw new NotFoundException('Invoice not found');
    return rows[0];
  }

  /**
   * Generates one month's invoice for a single lease.
   *
   * `period` is 'YYYY-MM' and is stored in exactly that format — the schema
   * documents invoices.period as 'YYYY-MM' and UNIQUE(lease_id, period)
   * depends on it staying consistent.
   *
   * The due date comes from the lease's rent_due_day via invoice_due_date(),
   * which clamps to the last day of short months (a due day of 31 becomes
   * the 28th in February rather than rolling into March).
   */
  async generateForLease(companyId: string, leaseId: string, period: string) {
    if (!/^\d{4}-\d{2}$/.test(period)) {
      throw new BadRequestException("period must be 'YYYY-MM'");
    }
    const monthStart = `${period}-01`;

    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO invoices (company_id, lease_id, period, amount_due, due_date)
       SELECT $1::uuid,
              l.id,
              $2::text,
              GREATEST(l.rent_amount - COALESCE(l.rent_discount_amount, 0), 0),
              invoice_due_date($2::text, COALESCE(l.rent_due_day, 5)::smallint)
       FROM leases l
       WHERE l.id = $3::uuid
         AND l.company_id = $1::uuid
         AND l.status = 'active'
         AND l.start_date <= ($4::date + interval '1 month' - interval '1 day')
         AND l.end_date   >= $4::date
         AND NOT EXISTS (
           SELECT 1 FROM invoices i WHERE i.lease_id = l.id AND i.period = $2::text
         )
       RETURNING id`,
      [companyId, period, leaseId, monthStart],
    );

    if (!rows[0]) {
      // Distinguish the two reasons so the UI can say something useful.
      const { rows: existing } = await this.pool.query(
        `SELECT id FROM invoices WHERE lease_id = $1 AND period = $2 AND company_id = $3`,
        [leaseId, period, companyId],
      );
      if (existing[0]) {
        throw new BadRequestException(`An invoice for ${period} already exists for this lease`);
      }
      throw new BadRequestException(
        `No active lease for ${period} — check the lease is active and its term covers that month`,
      );
    }
    return this.findOne(rows[0].id, companyId);
  }

  /** Same rules, applied across every active lease for the month. */
  async generateForAll(companyId: string, period: string): Promise<{ generated: number }> {
    if (!/^\d{4}-\d{2}$/.test(period)) {
      throw new BadRequestException("period must be 'YYYY-MM'");
    }
    const monthStart = `${period}-01`;

    const { rows } = await this.pool.query(
      `INSERT INTO invoices (company_id, lease_id, period, amount_due, due_date)
       SELECT $1::uuid,
              l.id,
              $2::text,
              GREATEST(l.rent_amount - COALESCE(l.rent_discount_amount, 0), 0),
              invoice_due_date($2::text, COALESCE(l.rent_due_day, 5)::smallint)
       FROM leases l
       WHERE l.company_id = $1::uuid
         AND l.status = 'active'
         AND l.start_date <= ($3::date + interval '1 month' - interval '1 day')
         AND l.end_date   >= $3::date
         AND NOT EXISTS (
           SELECT 1 FROM invoices i WHERE i.lease_id = l.id AND i.period = $2::text
         )
       RETURNING id`,
      [companyId, period, monthStart],
    );
    return { generated: rows.length };
  }

  /**
   * Tenant statement: every invoice and payment for a lease, oldest first,
   * with a running balance. This is what you print or email when a tenant
   * asks "what do I owe?".
   */
  async getStatement(companyId: string, leaseId: string) {
    const { rows: header } = await this.pool.query(
      `SELECT l.id AS lease_id, l.start_date, l.end_date, l.rent_amount,
              l.rent_due_day, l.deposit_amount, l.deposit_status, l.status,
              COALESCE(l.currency, p.currency, c.currency) AS currency,
              u.label AS unit_label, p.name AS property_name, p.address, p.city,
              usr.name AS renter_name, usr.email AS renter_email,
              usr.nuit AS renter_nuit, usr.id_type, usr.id_number,
              c.name AS company_name, c.bank_name, c.bank_account_name,
              c.bank_account_number, c.bank_nib, c.payment_instructions
       FROM leases l
       JOIN units u      ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
       JOIN companies c  ON c.id = l.company_id
       JOIN users usr    ON usr.id = l.renter_id
       WHERE l.id = $1 AND l.company_id = $2`,
      [leaseId, companyId],
    );
    if (!header[0]) throw new NotFoundException('Lease not found');

    // Charges and credits interleaved in date order. Invoices are debits
    // (what the tenant owes), successful payments are credits.
    const { rows: lines } = await this.pool.query(
      `SELECT * FROM (
         SELECT i.due_date       AS entry_date,
                'invoice'        AS kind,
                i.id             AS ref_id,
                i.period         AS reference,
                i.status,
                i.amount_total   AS debit,
                0::numeric       AS credit,
                i.late_fee_amount,
                i.days_late
         FROM invoices i
         WHERE i.lease_id = $1 AND i.company_id = $2

         UNION ALL

         SELECT pay.created_at::date AS entry_date,
                'payment'            AS kind,
                pay.id               AS ref_id,
                pay.method           AS reference,
                pay.status,
                0::numeric           AS debit,
                pay.amount           AS credit,
                NULL::numeric        AS late_fee_amount,
                NULL::int            AS days_late
         FROM payments pay
         JOIN invoices i2 ON i2.id = pay.invoice_id
         WHERE i2.lease_id = $1 AND pay.company_id = $2 AND pay.status = 'succeeded'
       ) t
       ORDER BY entry_date ASC, kind DESC`,
      [leaseId, companyId],
    );

    // Running balance computed here rather than in SQL so the same numbers
    // drive the screen, the PDF and any email without three chances to drift.
    let balance = 0;
    const entries = lines.map((l: any) => {
      balance += Number(l.debit) - Number(l.credit);
      return { ...l, balance: Number(balance.toFixed(2)) };
    });

    const totalCharged = lines.reduce((s: number, l: any) => s + Number(l.debit), 0);
    const totalPaid    = lines.reduce((s: number, l: any) => s + Number(l.credit), 0);

    return {
      lease: header[0],
      entries,
      totals: {
        charged: Number(totalCharged.toFixed(2)),
        paid: Number(totalPaid.toFixed(2)),
        balance: Number((totalCharged - totalPaid).toFixed(2)),
      },
    };
  }

  /**
   * Walks unpaid invoices past their due date and stamps the penalty from
   * the company's late_fee_policies rows. Idempotent: re-running recomputes
   * from the current lateness rather than stacking fees.
   */
  async applyLateFees(companyId: string) {
    const { rows: due } = await this.pool.query(
      `SELECT i.id, i.amount_due, (CURRENT_DATE - i.due_date) AS days_late
       FROM invoices i
       WHERE i.company_id = $1
         AND i.status IN ('pending','overdue')
         AND i.due_date < CURRENT_DATE`,
      [companyId],
    );

    let updated = 0;
    for (const inv of due) {
      const { rows: fee } = await this.pool.query(
        `SELECT * FROM calculate_late_fee($1, $2, $3)`,
        [companyId, inv.amount_due, inv.days_late],
      );
      const amount = fee[0]?.fee_amount ?? 0;
      const tier   = fee[0]?.tier ?? null;

      await this.pool.query(
        `UPDATE invoices
            SET late_fee_amount = $2,
                late_fee_tier = $3,
                days_late = $4,
                late_fee_calculated_at = now(),
                status = 'overdue'
          WHERE id = $1`,
        [inv.id, amount, tier, inv.days_late],
      );
      updated++;
    }
    return { updated };
  }

  async updateStatus(id: string, companyId: string, status: string) {
    const allowed = ['pending', 'paid', 'overdue', 'cancelled'];
    if (!allowed.includes(status)) throw new BadRequestException(`Invalid status: ${status}`);

    const { rows } = await this.pool.query(
      `UPDATE invoices SET status = $3 WHERE id = $1 AND company_id = $2
       RETURNING id, status`,
      [id, companyId, status],
    );
    if (!rows[0]) throw new NotFoundException('Invoice not found');
    return rows[0];
  }
}
