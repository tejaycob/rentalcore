import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Pool } from 'pg';

export type EntityType = 'lease' | 'user' | 'unit' | 'property' | 'invoice' | 'payment' | 'ticket';
export type DocType =
  | 'lease_signed'
  | 'id_document'
  | 'proof_of_payment'
  | 'inspection'
  | 'invoice_pdf'
  | 'statement'
  | 'other';

const ENTITY_TYPES: EntityType[] = ['lease', 'user', 'unit', 'property', 'invoice', 'payment', 'ticket'];
const DOC_TYPES: DocType[] = [
  'lease_signed', 'id_document', 'proof_of_payment',
  'inspection', 'invoice_pdf', 'statement', 'other',
];

/** Matches the CHECK constraint in migration 003. Enforced here too so the
 *  user gets a readable message instead of a 500 from Postgres. */
const MAX_BYTES = 10 * 1024 * 1024;

const ALLOWED_MIME = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/webp',
];

/** Each entity type lives in a different table, and each reaches company_id
 *  by a different path. Centralised here so an upload can never be attached
 *  to a record belonging to another company. */
const OWNERSHIP_SQL: Record<EntityType, string> = {
  user:     `SELECT 1 FROM users      WHERE id = $1 AND company_id = $2`,
  lease:    `SELECT 1 FROM leases     WHERE id = $1 AND company_id = $2`,
  property: `SELECT 1 FROM properties WHERE id = $1 AND company_id = $2`,
  invoice:  `SELECT 1 FROM invoices   WHERE id = $1 AND company_id = $2`,
  payment:  `SELECT 1 FROM payments   WHERE id = $1 AND company_id = $2`,
  ticket:   `SELECT 1 FROM maintenance_tickets WHERE id = $1 AND company_id = $2`,
  // units have no company_id of their own — reached through their property
  unit:     `SELECT 1 FROM units u JOIN properties p ON p.id = u.property_id
             WHERE u.id = $1 AND p.company_id = $2`,
};

@Injectable()
export class DocumentsService {
  constructor(private readonly pool: Pool) {}

  private assertValidEnums(entityType: string, docType: string) {
    if (!ENTITY_TYPES.includes(entityType as EntityType)) {
      throw new BadRequestException(`Invalid entityType: ${entityType}`);
    }
    if (!DOC_TYPES.includes(docType as DocType)) {
      throw new BadRequestException(`Invalid docType: ${docType}`);
    }
  }

  private async assertOwned(entityType: EntityType, entityId: string, companyId: string) {
    const { rows } = await this.pool.query(OWNERSHIP_SQL[entityType], [entityId, companyId]);
    if (rows.length === 0) {
      // Deliberately the same message whether the record is missing or
      // belongs to someone else — don't confirm existence across tenants.
      throw new NotFoundException(`${entityType} not found`);
    }
  }

  async upload(params: {
    companyId: string;
    userId: string;
    entityType: string;
    entityId: string;
    docType: string;
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer };
  }) {
    const { companyId, userId, entityType, entityId, docType, file } = params;

    if (!file || !file.buffer) throw new BadRequestException('No file received');
    this.assertValidEnums(entityType, docType);
    await this.assertOwned(entityType as EntityType, entityId, companyId);

    if (file.size > MAX_BYTES) {
      throw new BadRequestException(
        `File is ${(file.size / 1048576).toFixed(1)}MB — the limit is 10MB`,
      );
    }
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      throw new BadRequestException(
        `Unsupported file type ${file.mimetype}. Allowed: PDF, JPEG, PNG, HEIC, WebP`,
      );
    }

    const { rows } = await this.pool.query(
      `INSERT INTO documents
         (company_id, entity_type, entity_id, doc_type, filename, mime_type, size_bytes, uploaded_by, file_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, doc_type, filename, mime_type, size_bytes, created_at`,
      [companyId, entityType, entityId, docType,
       file.originalname, file.mimetype, file.size, userId, file.buffer],
    );
    return rows[0];
  }

  /** Metadata only — never selects file_data, so listing a hundred documents
   *  doesn't pull a hundred megabytes through the connection. */
  async listFor(entityType: string, entityId: string, companyId: string) {
    this.assertValidEnums(entityType, 'other');
    await this.assertOwned(entityType as EntityType, entityId, companyId);

    const { rows } = await this.pool.query(
      `SELECT d.id, d.doc_type, d.filename, d.mime_type, d.size_bytes,
              d.created_at, u.name AS uploaded_by_name
       FROM documents d
       LEFT JOIN users u ON u.id = d.uploaded_by
       WHERE d.entity_type = $1 AND d.entity_id = $2
         AND d.company_id = $3 AND d.deleted_at IS NULL
       ORDER BY d.created_at DESC`,
      [entityType, entityId, companyId],
    );
    return rows;
  }

  async download(id: string, companyId: string) {
    const { rows } = await this.pool.query<{
      filename: string; mime_type: string | null; file_data: Buffer | null;
    }>(
      `SELECT filename, mime_type, file_data
       FROM documents
       WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
      [id, companyId],
    );
    if (!rows[0]) throw new NotFoundException('Document not found');
    if (!rows[0].file_data) {
      throw new NotFoundException('Document has no stored content');
    }
    return rows[0];
  }

  /** Soft delete — the row and its bytes are retained, per the
   *  never-destructive rule. */
  async remove(id: string, companyId: string): Promise<void> {
    const { rows } = await this.pool.query(
      `UPDATE documents SET deleted_at = now()
       WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL
       RETURNING id`,
      [id, companyId],
    );
    if (!rows[0]) throw new NotFoundException('Document not found');
  }
}
