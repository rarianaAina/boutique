import { newSortableId, nowIso } from '@boutique/shared';
import type { AuditEntry } from '@boutique/shared';
import { parseJson, toJson } from '../rows';
import type { SqlExecutor } from '../client';

/**
 * Journal d'audit (§21).
 *
 * Trois choix pour qu'il reste lisible des mois plus tard :
 *
 *  - l'identifiant est TRIÉ PAR DATE, donc l'ordre d'insertion se lit dans la
 *    clé — utile quand deux écritures tombent dans la même milliseconde ;
 *  - le nom de l'utilisateur est RECOPIÉ, pour qu'un compte archivé ne rende
 *    pas illisible une ligne qu'on relit un an après ;
 *  - `before` et `after` sont en JSON, mais on n'y met QUE les champs modifiés :
 *    une entrée qui recopierait tout le produit rendrait le journal
 *    inexploitable en même temps qu'elle le ferait grossir pour rien.
 */

export const AUDIT_ACTIONS = {
  login: 'LOGIN',
  logout: 'LOGOUT',
  loginFailed: 'LOGIN_FAILED',
  create: 'CREATE',
  update: 'UPDATE',
  softDelete: 'SOFT_DELETE',
  sale: 'SALE',
  saleCancel: 'SALE_CANCEL',
  refund: 'REFUND',
  exchange: 'EXCHANGE',
  purchase: 'PURCHASE',
  receipt: 'RECEIPT',
  transfer: 'TRANSFER',
  priceChange: 'PRICE_CHANGE',
  stockChange: 'STOCK_CHANGE',
  import: 'IMPORT',
  sync: 'SYNC',
  backup: 'BACKUP',
  /** Archive complète du commerce, produite ou reprise. */
  export: 'EXPORT',
  restore: 'RESTORE',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS] | (string & {});

interface AuditRow {
  id: string;
  at: string;
  user_id: string | null;
  user_label: string | null;
  shop_id: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  before: string | null;
  after: string | null;
}

const toEntry = (row: AuditRow): AuditEntry => ({
  id: row.id,
  at: row.at,
  userId: row.user_id,
  userLabel: row.user_label,
  shopId: row.shop_id,
  action: row.action,
  entity: row.entity,
  entityId: row.entity_id,
  before: parseJson<unknown>(row.before, null),
  after: parseJson<unknown>(row.after, null),
});

export interface AuditInput {
  action: AuditAction;
  entity: string;
  entityId?: string | null;
  userId?: string | null;
  userLabel?: string | null;
  shopId?: string | null;
  before?: unknown;
  after?: unknown;
}

export interface AuditQuery {
  action?: string | null;
  entity?: string | null;
  entityId?: string | null;
  userId?: string | null;
  from?: string | null;
  to?: string | null;
  limit?: number;
  offset?: number;
}

export class AuditRepository {
  constructor(private readonly db: SqlExecutor) {}

  async write(input: AuditInput): Promise<string> {
    const id = newSortableId();
    await this.db.execute(
      `INSERT INTO audit_log (id, at, user_id, user_label, shop_id, action, entity, entity_id,
                              before, after)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        nowIso(),
        input.userId ?? null,
        input.userLabel ?? null,
        input.shopId ?? null,
        input.action,
        input.entity,
        input.entityId ?? null,
        input.before === undefined ? null : toJson(input.before),
        input.after === undefined ? null : toJson(input.after),
      ],
    );
    return id;
  }

  async list(query: AuditQuery): Promise<{ items: AuditEntry[]; total: number }> {
    const limit = Math.min(query.limit ?? 100, 1000);
    const offset = Math.max(0, query.offset ?? 0);

    const conditions: string[] = [];
    const params: unknown[] = [];
    for (const [column, value] of [
      ['action', query.action],
      ['entity', query.entity],
      ['entity_id', query.entityId],
      ['user_id', query.userId],
    ] as const) {
      if (value) {
        conditions.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (query.from) {
      conditions.push('at >= ?');
      params.push(query.from);
    }
    if (query.to) {
      conditions.push('at < ?');
      params.push(query.to);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await this.db.select<AuditRow>(
      `SELECT * FROM audit_log ${where} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    const totals = await this.db.select<{ total: number }>(
      `SELECT COUNT(*) AS total FROM audit_log ${where}`,
      params,
    );
    return { items: rows.map(toEntry), total: totals[0]?.total ?? 0 };
  }

  /** Historique d'une entité précise : la fiche d'un appareil, d'un produit… */
  async forEntity(entity: string, entityId: string): Promise<AuditEntry[]> {
    const rows = await this.db.select<AuditRow>(
      'SELECT * FROM audit_log WHERE entity = ? AND entity_id = ? ORDER BY at, id',
      [entity, entityId],
    );
    return rows.map(toEntry);
  }
}

/**
 * Différence entre deux versions d'un objet, limitée aux champs modifiés.
 *
 * C'est ce qui rend le journal utile : « prix de vente 2 950 000 -> 2 750 000 »
 * se lit d'un coup d'œil, là où deux copies complètes du produit obligeraient à
 * les comparer à la main.
 */
export function diffFields<T extends Record<string, unknown>>(
  before: T,
  after: T,
): { before: Partial<T>; after: Partial<T> } | null {
  const changedBefore: Partial<T> = {};
  const changedAfter: Partial<T> = {};
  let changed = false;

  for (const key of new Set([...Object.keys(before), ...Object.keys(after)]) as Set<keyof T>) {
    const left = before[key];
    const right = after[key];
    if (JSON.stringify(left ?? null) === JSON.stringify(right ?? null)) continue;
    changedBefore[key] = left;
    changedAfter[key] = right;
    changed = true;
  }

  return changed ? { before: changedBefore, after: changedAfter } : null;
}
