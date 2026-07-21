import { Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';

@Injectable()
export class UnitsService {
  constructor(private readonly pool: Pool) {}

  async findByProperty(propertyId: string, companyId: string) {
    const { rows } = await this.pool.query(
      `SELECT u.id, u.property_id, u.label, u.unit_type, u.base_rent, u.status, u.created_at,
              p.name AS property_name,
              (SELECT json_build_object('id', l.id, 'renter_name', usr.name, 'end_date', l.end_date, 'rent_amount', l.rent_amount)
               FROM leases l JOIN users usr ON usr.id = l.renter_id
               WHERE l.unit_id = u.id AND l.status = 'active' LIMIT 1) AS active_lease
       FROM units u
       JOIN properties p ON p.id = u.property_id
       WHERE u.property_id = $1 AND p.company_id = $2
       ORDER BY u.label`,
      [propertyId, companyId],
    );
    return rows;
  }

  async findAll(companyId: string) {
    const { rows } = await this.pool.query(
      `SELECT u.id, u.property_id, u.label, u.unit_type, u.base_rent, u.status, u.created_at,
              p.name AS property_name, p.city,
              (SELECT json_build_object('id', l.id, 'renter_name', usr.name, 'end_date', l.end_date)
               FROM leases l JOIN users usr ON usr.id = l.renter_id
               WHERE l.unit_id = u.id AND l.status = 'active' LIMIT 1) AS active_lease
       FROM units u
       JOIN properties p ON p.id = u.property_id
       WHERE p.company_id = $1
       ORDER BY p.name, u.label`,
      [companyId],
    );
    return rows;
  }

  async create(companyId: string, body: { propertyId: string; label: string; unitType?: string; baseRent: number }) {
    // Verify property belongs to company
    const { rows: [prop] } = await this.pool.query(
      `SELECT id FROM properties WHERE id = $1 AND company_id = $2`,
      [body.propertyId, companyId],
    );
    if (!prop) throw new NotFoundException('Property not found');

    const { rows } = await this.pool.query(
      `INSERT INTO units (property_id, label, unit_type, base_rent)
       VALUES ($1, $2, $3, $4)
       RETURNING id, property_id, label, unit_type, base_rent, status, created_at`,
      [body.propertyId, body.label, body.unitType ?? 'apartment', body.baseRent],
    );
    return rows[0];
  }

  async update(id: string, companyId: string, body: any) {
    const { rows } = await this.pool.query(
      `UPDATE units u
       SET label = COALESCE($3, u.label),
           unit_type = COALESCE($4, u.unit_type),
           base_rent = COALESCE($5, u.base_rent),
           status = COALESCE($6, u.status)
       FROM properties p
       WHERE u.id = $1 AND u.property_id = p.id AND p.company_id = $2
       RETURNING u.id, u.property_id, u.label, u.unit_type, u.base_rent, u.status`,
      [id, companyId, body.label, body.unitType, body.baseRent, body.status],
    );
    if (!rows[0]) throw new NotFoundException('Unit not found');
    return rows[0];
  }
}
