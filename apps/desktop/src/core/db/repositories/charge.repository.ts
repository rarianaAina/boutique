import { newId, nowIso } from '@boutique/shared';
import type { Charge, ChargeCategory, IsoDate, Money } from '@boutique/shared';
import type { SqlExecutor } from '../client';

/**
 * Charges d'exploitation.
 *
 * Ce que la boutique dépense pour fonctionner — loyer, salaires, JIRAMA,
 * transport, impôts — et sans quoi il n'y aurait pas de bénéfice à calculer,
 * seulement une marge sur marchandises.
 *
 * Les achats de MARCHANDISE n'entrent pas ici : ils passent par les achats, et
 * leur coût rejoint le résultat par le prix de revient des articles vendus.
 * Les compter des deux côtés fausserait le résultat dans le sens le plus
 * trompeur — trop bas les mois où l'on réapprovisionne, trop haut les autres.
 */

interface ChargeRow {
  id: string;
  shop_id: string;
  category: ChargeCategory;
  label: string;
  amount: number;
  occurred_at: string;
  supplier_id: string | null;
  reference: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const toCharge = (row: ChargeRow): Charge => ({
  id: row.id,
  shopId: row.shop_id,
  category: row.category,
  label: row.label,
  amount: row.amount,
  occurredAt: row.occurred_at,
  supplierId: row.supplier_id,
  reference: row.reference,
  notes: row.notes,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
});

export interface ChargeInput {
  shopId: string;
  category: ChargeCategory;
  label: string;
  amount: Money;
  occurredAt: IsoDate;
  supplierId?: string | null;
  reference?: string | null;
  notes?: string | null;
}

export interface ChargeQuery {
  shopId: string;
  category?: ChargeCategory | null;
  from?: string | null;
  to?: string | null;
  limit?: number;
  offset?: number;
}

export class ChargeRepository {
  constructor(private readonly db: SqlExecutor) {}

  async list(query: ChargeQuery): Promise<Charge[]> {
    const conditions = ['shop_id = ?', 'deleted_at IS NULL'];
    const params: unknown[] = [query.shopId];

    if (query.category) {
      conditions.push('category = ?');
      params.push(query.category);
    }
    if (query.from) {
      conditions.push('occurred_at >= ?');
      params.push(query.from);
    }
    if (query.to) {
      conditions.push('occurred_at <= ?');
      params.push(query.to);
    }

    const rows = await this.db.select<ChargeRow>(
      `SELECT * FROM charge WHERE ${conditions.join(' AND ')}
        ORDER BY occurred_at DESC, created_at DESC
        LIMIT ? OFFSET ?`,
      [...params, query.limit ?? 100, query.offset ?? 0],
    );
    return rows.map(toCharge);
  }

  async byId(id: string): Promise<Charge | null> {
    const rows = await this.db.select<ChargeRow>('SELECT * FROM charge WHERE id = ?', [id]);
    return rows[0] ? toCharge(rows[0]) : null;
  }

  async create(input: ChargeInput, id = newId()): Promise<string> {
    const at = nowIso();
    await this.db.execute(
      `INSERT INTO charge (id, shop_id, category, label, amount, occurred_at,
                           supplier_id, reference, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.shopId,
        input.category,
        input.label,
        input.amount,
        input.occurredAt,
        input.supplierId ?? null,
        input.reference ?? null,
        input.notes ?? null,
        at,
        at,
      ],
    );
    return id;
  }

  async update(id: string, input: Omit<ChargeInput, 'shopId'>): Promise<void> {
    await this.db.execute(
      `UPDATE charge SET category = ?, label = ?, amount = ?, occurred_at = ?,
              supplier_id = ?, reference = ?, notes = ?, updated_at = ?
       WHERE id = ?`,
      [
        input.category,
        input.label,
        input.amount,
        input.occurredAt,
        input.supplierId ?? null,
        input.reference ?? null,
        input.notes ?? null,
        nowIso(),
        id,
      ],
    );
  }

  /**
   * Suppression LOGIQUE.
   *
   * Une charge effacée pour de bon changerait le résultat d'une période déjà
   * arrêtée, sans laisser de trace de ce qui a changé ni de qui l'a décidé.
   */
  async softDelete(id: string): Promise<void> {
    const at = nowIso();
    await this.db.execute('UPDATE charge SET deleted_at = ?, updated_at = ? WHERE id = ?', [
      at,
      at,
      id,
    ]);
  }

  /**
   * Total par catégorie sur une période, pour le compte de résultat.
   *
   * Borne haute EXCLUE, comme `periodRange` du paquet partagé : c'est la seule
   * façon de ne pas avoir à raisonner sur la dernière milliseconde d'une
   * journée, et surtout de compter les charges exactement comme on compte les
   * ventes.
   */
  async parCategorie(
    from: string,
    avant: string,
    shopId: string,
  ): Promise<{ category: ChargeCategory; total: number; nombre: number }[]> {
    return this.db.select<{ category: ChargeCategory; total: number; nombre: number }>(
      `SELECT category, SUM(amount) AS total, COUNT(*) AS nombre
         FROM charge
        WHERE shop_id = ? AND deleted_at IS NULL AND occurred_at >= ? AND occurred_at < ?
        GROUP BY category
        ORDER BY total DESC`,
      [shopId, from, avant],
    );
  }
}
