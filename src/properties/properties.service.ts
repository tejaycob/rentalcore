import { Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';

export interface Property {
  id: string;
  company_id: string;
  name: string;
  address: string;
  city: string;
  active: boolean;
  unit_count?: number;
  vacant_count?: number;
  created_at: string;
}

@Injectable()
export class PropertiesService {
  constructor(private readonly pool: Pool) {}

  async findAll(companyId: string): Promise<Property[]> {
    const { rows } = await this.pool.query<Property>(
      `SELECT p.id, p.company_id, p.name, p.address, p.city, p.active, p.created_at,
              COUNT(u.id) AS unit_count,
              COUNT(u.id) FILTER (WHERE u.status = 'vacant') AS vacant_count
       FROM properties p
       LEFT JOIN units u ON u.property_id = p.id
       WHERE p.company_id = $1 AND p.active = true
       GROUP BY p.id
       ORDER BY p.name`,
      [companyId],
    );
    return rows;
  }

  async findOne(id: string, companyId: string): Promise<Property> {
    const { rows } = await this.pool.query<Property>(
      `SELECT p.id, p.company_id, p.name, p.address, p.city, p.active, p.created_at,
              COUNT(u.id) AS unit_count,
              COUNT(u.id) FILTER (WHERE u.status = 'vacant') AS vacant_count
       FROM properties p
       LEFT JOIN units u ON u.property_id = p.id
       WHERE p.id = $1 AND p.company_id = $2
       GROUP BY p.id`,
      [id, companyId],
    );
    if (!rows[0]) throw new NotFoundException('Property not found');
    return rows[0];
  }

  async create(companyId: string, body: { name: string; address: string; city: string }): Promise<Property> {
    const { rows } = await this.pool.query<Property>(
      `INSERT INTO properties (company_id, name, address, city)
       VALUES ($1, $2, $3, $4)
       RETURNING id, company_id, name, address, city, active, created_at`,
      [companyId, body.name, body.address, body.city],
    );
    return rows[0];
  }

  async update(id: string, companyId: string, body: Partial<{ name: string; address: string; city: string }>): Promise<Property> {
    const { rows } = await this.pool.query<Property>(
      `UPDATE properties
       SET name = COALESCE($3, name),
           address = COALESCE($4, address),
           city = COALESCE($5, city)
       WHERE id = $1 AND company_id = $2
       RETURNING id, company_id, name, address, city, active, created_at`,
      [id, companyId, body.name, body.address, body.city],
    );
    if (!rows[0]) throw new NotFoundException('Property not found');
    return rows[0];
  }

  async remove(id: string, companyId: string): Promise<void> {
    await this.pool.query(
      `UPDATE properties SET active = false WHERE id = $1 AND company_id = $2`,
      [id, companyId],
    );
  }
}
