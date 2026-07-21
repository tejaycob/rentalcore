import { Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';

@Injectable()
export class MaintenanceService {
  constructor(private readonly pool: Pool) {}

  async findAll(companyId: string, filters: { status?: string; priority?: string } = {}) {
    const conditions = ['t.company_id = $1'];
    const params: any[] = [companyId];
    if (filters.status) { conditions.push(`t.status = $${params.push(filters.status)}`); }
    if (filters.priority) { conditions.push(`t.priority = $${params.push(filters.priority)}`); }

    const { rows } = await this.pool.query(
      `SELECT t.id, t.unit_id, t.title, t.description, t.priority, t.status,
              t.opened_at, t.resolved_at,
              u.label AS unit_label, p.name AS property_name,
              rep.name AS reported_by_name,
              asgn.name AS assigned_to_name
       FROM maintenance_tickets t
       JOIN units u ON u.id = t.unit_id
       JOIN properties p ON p.id = u.property_id
       JOIN users rep ON rep.id = t.reported_by
       LEFT JOIN users asgn ON asgn.id = t.assigned_to
       WHERE ${conditions.join(' AND ')}
       ORDER BY CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
                t.opened_at DESC`,
      params,
    );
    return rows;
  }

  async create(companyId: string, userId: string, body: {
    unitId: string; title: string; description?: string; priority?: string;
  }) {
    const { rows } = await this.pool.query(
      `INSERT INTO maintenance_tickets (company_id, unit_id, reported_by, title, description, priority)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, title, priority, status, opened_at`,
      [companyId, body.unitId, userId, body.title, body.description ?? null, body.priority ?? 'medium'],
    );
    return rows[0];
  }

  async update(id: string, companyId: string, body: { status?: string; priority?: string; assignedTo?: string }) {
    const resolvedAt = body.status === 'resolved' ? 'now()' : 'resolved_at';
    const { rows } = await this.pool.query(
      `UPDATE maintenance_tickets
       SET status = COALESCE($3, status),
           priority = COALESCE($4, priority),
           assigned_to = COALESCE($5, assigned_to),
           resolved_at = CASE WHEN $3 = 'resolved' THEN now() ELSE resolved_at END
       WHERE id = $1 AND company_id = $2
       RETURNING id, status, priority, resolved_at`,
      [id, companyId, body.status, body.priority, body.assignedTo],
    );
    if (!rows[0]) throw new NotFoundException('Ticket not found');
    return rows[0];
  }
}
