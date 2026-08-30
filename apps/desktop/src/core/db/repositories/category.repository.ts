import { newId, nowIso } from '@boutique/shared';
import type { Category } from '@boutique/shared';
import type { SqlExecutor } from '../client';

/** Catégories, hiérarchiques sur un seul niveau de parenté (rayon / sous-rayon). */

interface CategoryRow {
  id: string;
  parent_id: string | null;
  code: string;
  name: string;
  position: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const toCategory = (row: CategoryRow): Category => ({
  id: row.id,
  parentId: row.parent_id,
  code: row.code,
  name: row.name,
  position: row.position,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
});

export class CategoryRepository {
  constructor(private readonly db: SqlExecutor) {}

  async list(): Promise<Category[]> {
    const rows = await this.db.select<CategoryRow>(
      'SELECT * FROM category WHERE deleted_at IS NULL ORDER BY position, name',
    );
    return rows.map(toCategory);
  }

  async byCode(code: string): Promise<Category | null> {
    const rows = await this.db.select<CategoryRow>(
      'SELECT * FROM category WHERE code = ? AND deleted_at IS NULL',
      [code],
    );
    return rows[0] ? toCategory(rows[0]) : null;
  }

  async create(
    input: { code: string; name: string; parentId?: string | null; position?: number },
    id = newId(),
  ): Promise<string> {
    const at = nowIso();
    await this.db.execute(
      `INSERT INTO category (id, parent_id, code, name, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.parentId ?? null, input.code, input.name, input.position ?? 0, at, at],
    );
    return id;
  }

  async update(
    id: string,
    input: { name?: string; parentId?: string | null; position?: number },
  ): Promise<void> {
    await this.db.execute(
      `UPDATE category SET
         name = COALESCE(?, name),
         parent_id = ?,
         position = COALESCE(?, position),
         updated_at = ?
       WHERE id = ?`,
      [input.name ?? null, input.parentId ?? null, input.position ?? null, nowIso(), id],
    );
  }

  /**
   * Suppression logique, refusée si des produits y sont rattachés : une
   * catégorie qui disparaît sous des produits les rendrait introuvables dans
   * l'arborescence sans qu'aucune alerte ne le signale.
   */
  async softDelete(id: string): Promise<void> {
    const rows = await this.db.select<{ total: number }>(
      'SELECT COUNT(*) AS total FROM product WHERE category_id = ? AND deleted_at IS NULL',
      [id],
    );
    if ((rows[0]?.total ?? 0) > 0) {
      throw new Error('Cette catégorie contient encore des produits.');
    }
    const at = nowIso();
    await this.db.execute('UPDATE category SET deleted_at = ?, updated_at = ? WHERE id = ?', [
      at,
      at,
      id,
    ]);
  }
}
