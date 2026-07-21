import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Pool } from 'pg';

export interface TenantListRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  active: boolean;
  id_type: string | null;
  id_number: string | null;
  nuit: string | null;
  lease_count: number;
  active_lease_id: string | null;
  property_name: string | null;
  unit_label: string | null;
  rent_amount: string | null;
  currency: string | null;
  lease_end: string | null;
  document_count: number;
}

/** Fields the UI is allowed to write. Anything not listed here is ignored,
 *  so a malformed request can never touch role, company_id or password. */
const EDITABLE_FIELDS = [
  'name',
  'phone',
  'locale',
  'id_type',
  'id_number',
  'nuit',
  'employer_name',
  'occupation',
  'work_phone',
  'emergency_contact_name',
  'emergency_contact_relationship',
  'emergency_contact_phone',
] as const;

type EditableField = (typeof EDITABLE_FIELDS)[number];

@Injectable()
export class TenantsService {
  constructor(private readonly pool: Pool) {}

  /** All renters for the company, with their current lease and document
   *  count so the list is useful without N+1 follow-up requests. */
  async findAll(companyId: string): Promise<TenantListRow[]> {
    const { rows } = await this.pool.query<TenantListRow>(
      `SELECT u.id, u.name, u.email, u.phone, u.active,
              u.id_type, u.id_number, u.nuit,
              COUNT(DISTINCT l.id)::int AS lease_count,
              al.lease_id     AS active_lease_id,
              al.property_name,
              al.unit_label,
              al.rent_amount,
              al.currency,
              al.end_date     AS lease_end,
              COALESCE(dc.cnt, 0)::int AS document_count
       FROM users u
       LEFT JOIN leases l ON l.renter_id = u.id
       LEFT JOIN LATERAL (
         SELECT l2.id AS lease_id, l2.rent_amount, l2.end_date,
                p.name AS property_name, un.label AS unit_label,
                COALESCE(l2.currency, p.currency, c.currency) AS currency
         FROM leases l2
         JOIN units un      ON un.id = l2.unit_id
         JOIN properties p  ON p.id = un.property_id
         JOIN companies c   ON c.id = l2.company_id
         WHERE l2.renter_id = u.id AND l2.status = 'active'
         ORDER BY l2.start_date DESC
         LIMIT 1
       ) al ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS cnt FROM documents d
         WHERE d.entity_type = 'user' AND d.entity_id = u.id AND d.deleted_at IS NULL
       ) dc ON true
       WHERE u.company_id = $1 AND u.role = 'renter'
       GROUP BY u.id, al.lease_id, al.property_name, al.unit_label,
                al.rent_amount, al.currency, al.end_date, dc.cnt
       ORDER BY u.name`,
      [companyId],
    );
    return rows;
  }

  /** Full profile: identity, emergency contact, employment, lease history
   *  and documents — everything the detail drawer renders. */
  async findOne(id: string, companyId: string) {
    const { rows } = await this.pool.query(
      `SELECT u.id, u.name, u.email, u.phone, u.locale, u.active, u.created_at,
              u.id_type, u.id_number, u.nuit,
              u.employer_name, u.occupation, u.work_phone,
              u.emergency_contact_name, u.emergency_contact_relationship,
              u.emergency_contact_phone
       FROM users u
       WHERE u.id = $1 AND u.company_id = $2 AND u.role = 'renter'`,
      [id, companyId],
    );
    if (!rows[0]) throw new NotFoundException('Tenant not found');

    const [leases, documents] = await Promise.all([
      this.pool.query(
        `SELECT l.id, l.start_date, l.end_date, l.rent_amount, l.deposit_amount,
                l.deposit_status, l.status, l.rent_due_day,
                COALESCE(l.currency, p.currency, c.currency) AS currency,
                un.label AS unit_label, p.name AS property_name
         FROM leases l
         JOIN units un     ON un.id = l.unit_id
         JOIN properties p ON p.id = un.property_id
         JOIN companies c  ON c.id = l.company_id
         WHERE l.renter_id = $1 AND l.company_id = $2
         ORDER BY l.start_date DESC`,
        [id, companyId],
      ),
      this.pool.query(
        `SELECT id, doc_type, filename, mime_type, size_bytes, created_at
         FROM documents
         WHERE entity_type = 'user' AND entity_id = $1
           AND company_id = $2 AND deleted_at IS NULL
         ORDER BY created_at DESC`,
        [id, companyId],
      ),
    ]);

    return { ...rows[0], leases: leases.rows, documents: documents.rows };
  }

  /** Partial update. Only whitelisted fields are written, and the SQL is
   *  built from a fixed column list — the request body never reaches the
   *  query text, only parameters. */
  async update(id: string, companyId: string, body: Record<string, unknown>) {
    const sets: string[] = [];
    const params: unknown[] = [id, companyId];

    for (const field of EDITABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        const value = body[field];
        params.push(value === '' ? null : value);
        sets.push(`${field} = $${params.length}`);
      }
    }

    if (sets.length === 0) {
      throw new BadRequestException('No editable fields supplied');
    }

    // The DB also enforces this, but catching it here returns a clear
    // message instead of a constraint-violation 500.
    const phone = (body as Record<string, string>).phone;
    const emergency = (body as Record<string, string>).emergency_contact_phone;
    if (phone && emergency && phone === emergency) {
      throw new BadRequestException(
        'Emergency contact phone must differ from the tenant phone',
      );
    }

    const { rows } = await this.pool.query(
      `UPDATE users SET ${sets.join(', ')}
       WHERE id = $1 AND company_id = $2 AND role = 'renter'
       RETURNING id`,
      params,
    );
    if (!rows[0]) throw new NotFoundException('Tenant not found');

    return this.findOne(id, companyId);
  }
}
