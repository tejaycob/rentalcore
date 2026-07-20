// src/ledger/ledger.service.ts
//
// Posts double-entry pairs to ledger_entries. Every call here writes
// exactly two rows whose debit/credit sides balance — this is what makes
// the books auditable later, and it's why ledger_entries has debit/credit
// columns instead of a single signed amount (see schema comments).

import { Injectable } from '@nestjs/common';
import { Pool } from 'pg';

@Injectable()
export class LedgerService {
  constructor(private readonly pool: Pool) {}

  /** Called from the webhook controller once a payment is confirmed
   *  succeeded. Posts: debit cash, credit accounts_receivable — the
   *  invoice's outstanding balance moves from "owed" to "collected". */
  async postRentPayment(paymentId: string, amount: number): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query<{ companyId: string; invoiceId: string }>(
        `SELECT company_id AS "companyId", invoice_id AS "invoiceId" FROM payments WHERE id = $1`,
        [paymentId],
      );
      if (rows.length === 0) throw new Error(`Payment ${paymentId} not found`);
      const { companyId, invoiceId } = rows[0];

      await client.query(
        `INSERT INTO ledger_entries (company_id, invoice_id, payment_id, entry_type, account, debit, credit, memo)
         VALUES ($1, $2, $3, 'rent_income', 'cash', $4, 0, 'Rent payment received')`,
        [companyId, invoiceId, paymentId, amount],
      );
      await client.query(
        `INSERT INTO ledger_entries (company_id, invoice_id, payment_id, entry_type, account, debit, credit, memo)
         VALUES ($1, $2, $3, 'rent_income', 'accounts_receivable', 0, $4, 'Invoice settled')`,
        [companyId, invoiceId, paymentId, amount],
      );

      await client.query(`UPDATE invoices SET status = 'paid' WHERE id = $1`, [invoiceId]);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Reverses a previously-posted rent payment. Does NOT delete or edit
   *  the original entries — accounting convention is to post an
   *  offsetting pair, preserving full history of what happened and when. */
  async postRefund(paymentId: string, amount: number): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query<{ companyId: string; invoiceId: string }>(
        `SELECT company_id AS "companyId", invoice_id AS "invoiceId" FROM payments WHERE id = $1`,
        [paymentId],
      );
      if (rows.length === 0) throw new Error(`Payment ${paymentId} not found`);
      const { companyId, invoiceId } = rows[0];

      await client.query(
        `INSERT INTO ledger_entries (company_id, invoice_id, payment_id, entry_type, account, debit, credit, memo)
         VALUES ($1, $2, $3, 'refund', 'refunds_payable', $4, 0, 'Refund issued')`,
        [companyId, invoiceId, paymentId, amount],
      );
      await client.query(
        `INSERT INTO ledger_entries (company_id, invoice_id, payment_id, entry_type, account, debit, credit, memo)
         VALUES ($1, $2, $3, 'refund', 'cash', 0, $4, 'Cash paid out on refund')`,
        [companyId, invoiceId, paymentId, amount],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
