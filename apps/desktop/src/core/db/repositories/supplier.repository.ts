import { buildSearchKey, escapeLike, newId, nowIso, searchTerms } from '@boutique/shared';
import type { Supplier } from '@boutique/shared';
import { fromBool, toBool } from '../rows';
import type { SqlExecutor } from '../client';

/** Fournisseurs (§9). */

interface SupplierRow {
  id: string;
  code: string;
  name: string;
  company: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  country: string | null;
  terms: string | null;
  notes: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const toSupplier = (row: SupplierRow): Supplier => ({
  id: row.id,
  code: row.code,
  name: row.name,
  company: row.company,
  phone: row.phone,
  email: row.email,
  address: row.address,
  country: row.country,
  terms: row.terms,
  notes: row.notes,
  isActive: toBool(row.is_active),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
});

export interface SupplierInput {
  code: string;
  name: string;
  company?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  country?: string | null;
  terms?: string | null;
  notes?: string | null;
  isActive?: boolean;
}

const searchKeyOf = (input: SupplierInput): string =>
  buildSearchKey(input.name, input.company, input.code, input.phone, input.email, input.country);

export class SupplierRepository {
  constructor(private readonly db: SqlExecutor) {}

  async list(options: { query?: string; activeOnly?: boolean } = {}): Promise<Supplier[]> {
    const conditions = ['deleted_at IS NULL'];
    const params: unknown[] = [];
    if (options.activeOnly) conditions.push('is_active = 1');
    for (const term of searchTerms(options.query ?? '')) {
      conditions.push("search_key LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(term)}%`);
    }
    const rows = await this.db.select<SupplierRow>(
      `SELECT * FROM supplier WHERE ${conditions.join(' AND ')} ORDER BY name LIMIT 500`,
      params,
    );
    return rows.map(toSupplier);
  }

  async byId(id: string): Promise<Supplier | null> {
    const rows = await this.db.select<SupplierRow>('SELECT * FROM supplier WHERE id = ?', [id]);
    return rows[0] ? toSupplier(rows[0]) : null;
  }

  async byCode(code: string): Promise<Supplier | null> {
    const rows = await this.db.select<SupplierRow>(
      'SELECT * FROM supplier WHERE code = ? AND deleted_at IS NULL',
      [code],
    );
    return rows[0] ? toSupplier(rows[0]) : null;
  }

  async create(input: SupplierInput, id = newId()): Promise<string> {
    const at = nowIso();
    await this.db.execute(
      `INSERT INTO supplier (id, code, name, company, phone, email, address, country, terms,
                             notes, is_active, search_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.code,
        input.name,
        input.company ?? null,
        input.phone ?? null,
        input.email ?? null,
        input.address ?? null,
        input.country ?? null,
        input.terms ?? null,
        input.notes ?? null,
        fromBool(input.isActive ?? true),
        searchKeyOf(input),
        at,
        at,
      ],
    );
    return id;
  }

  async update(id: string, input: SupplierInput): Promise<void> {
    await this.db.execute(
      `UPDATE supplier SET
         code = ?, name = ?, company = ?, phone = ?, email = ?, address = ?, country = ?,
         terms = ?, notes = ?, is_active = ?, search_key = ?, updated_at = ?
       WHERE id = ?`,
      [
        input.code,
        input.name,
        input.company ?? null,
        input.phone ?? null,
        input.email ?? null,
        input.address ?? null,
        input.country ?? null,
        input.terms ?? null,
        input.notes ?? null,
        fromBool(input.isActive ?? true),
        searchKeyOf(input),
        nowIso(),
        id,
      ],
    );
  }

  async softDelete(id: string): Promise<void> {
    const at = nowIso();
    await this.db.execute(
      'UPDATE supplier SET deleted_at = ?, is_active = 0, updated_at = ? WHERE id = ?',
      [at, at, id],
    );
  }

  /** Historique d'achats, pour la fiche fournisseur. */
  async purchaseSummary(
    supplierId: string,
  ): Promise<{ purchases: number; total: number; lastAt: string | null }> {
    const rows = await this.db.select<{ purchases: number; total: number; last_at: string | null }>(
      `SELECT COUNT(*) AS purchases, COALESCE(SUM(total), 0) AS total, MAX(ordered_at) AS last_at
       FROM purchase
       WHERE supplier_id = ? AND deleted_at IS NULL AND status <> 'CANCELLED'`,
      [supplierId],
    );
    const row = rows[0];
    return {
      purchases: row?.purchases ?? 0,
      total: row?.total ?? 0,
      lastAt: row?.last_at ?? null,
    };
  }
}
