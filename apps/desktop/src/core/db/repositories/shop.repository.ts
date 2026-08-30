import { newId, nowIso } from '@boutique/shared';
import type { Shop, ShopStatus } from '@boutique/shared';
import { fromBool, toBool } from '../rows';
import type { SqlExecutor } from '../client';

/**
 * Boutiques.
 *
 * Le réseau ENTIER est décrit dans chaque base locale : sans cela, une boutique
 * hors ligne ne pourrait pas préparer un transfert vers une destination qu'elle
 * ne connaît pas encore. Une seule ligne porte `is_local = 1` — celle installée
 * sur ce poste — et un index partiel garantit qu'il ne peut y en avoir deux.
 */

interface ShopRow {
  id: string;
  code: string;
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  status: ShopStatus;
  is_local: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const toShop = (row: ShopRow): Shop => ({
  id: row.id,
  code: row.code,
  name: row.name,
  address: row.address,
  phone: row.phone,
  email: row.email,
  status: row.status,
  isLocal: toBool(row.is_local),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
});

export interface ShopInput {
  code: string;
  name: string;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  status?: ShopStatus;
  isLocal?: boolean;
}

export class ShopRepository {
  constructor(private readonly db: SqlExecutor) {}

  async list(includeDeleted = false): Promise<Shop[]> {
    const rows = await this.db.select<ShopRow>(
      `SELECT * FROM shop ${includeDeleted ? '' : 'WHERE deleted_at IS NULL'} ORDER BY name`,
    );
    return rows.map(toShop);
  }

  async byId(id: string): Promise<Shop | null> {
    const rows = await this.db.select<ShopRow>('SELECT * FROM shop WHERE id = ?', [id]);
    return rows[0] ? toShop(rows[0]) : null;
  }

  async byCode(code: string): Promise<Shop | null> {
    const rows = await this.db.select<ShopRow>('SELECT * FROM shop WHERE code = ?', [code]);
    return rows[0] ? toShop(rows[0]) : null;
  }

  /** La boutique installée sur ce poste. Absente tant que rien n'est configuré. */
  async local(): Promise<Shop | null> {
    const rows = await this.db.select<ShopRow>(
      'SELECT * FROM shop WHERE is_local = 1 AND deleted_at IS NULL',
    );
    return rows[0] ? toShop(rows[0]) : null;
  }

  async create(input: ShopInput, id = newId()): Promise<string> {
    const at = nowIso();
    await this.db.execute(
      `INSERT INTO shop (id, code, name, address, phone, email, status, is_local,
                         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.code.toUpperCase(),
        input.name,
        input.address ?? null,
        input.phone ?? null,
        input.email ?? null,
        input.status ?? 'ACTIVE',
        fromBool(input.isLocal ?? false),
        at,
        at,
      ],
    );
    return id;
  }

  async update(id: string, input: Partial<ShopInput>): Promise<void> {
    await this.db.execute(
      `UPDATE shop SET
         code = COALESCE(?, code),
         name = COALESCE(?, name),
         address = COALESCE(?, address),
         phone = COALESCE(?, phone),
         email = COALESCE(?, email),
         status = COALESCE(?, status),
         updated_at = ?
       WHERE id = ?`,
      [
        input.code?.toUpperCase() ?? null,
        input.name ?? null,
        input.address ?? null,
        input.phone ?? null,
        input.email ?? null,
        input.status ?? null,
        nowIso(),
        id,
      ],
    );
  }

  /**
   * Désigne la boutique de ce poste.
   *
   * L'ancienne est démarquée d'abord : l'index partiel `ux_shop_local` refuse
   * deux lignes à 1, et l'ordre des deux instructions dans la même transaction
   * est donc significatif.
   */
  async setLocal(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute('UPDATE shop SET is_local = 0 WHERE is_local = 1');
      await tx.execute('UPDATE shop SET is_local = 1, updated_at = ? WHERE id = ?', [nowIso(), id]);
    });
  }

  /** Suppression LOGIQUE : les documents historiques référencent la boutique. */
  async softDelete(id: string): Promise<void> {
    const at = nowIso();
    await this.db.execute(
      'UPDATE shop SET deleted_at = ?, updated_at = ?, is_local = 0 WHERE id = ?',
      [at, at, id],
    );
  }
}
