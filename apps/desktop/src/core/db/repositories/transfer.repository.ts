import { newId, nowIso } from '@boutique/shared';
import type { Transfer, TransferLine, TransferStatus } from '@boutique/shared';
import type { SqlExecutor } from '../client';

/** Transferts entre boutiques (§17). */

interface TransferRow {
  id: string;
  number: string;
  from_shop_id: string;
  to_shop_id: string;
  status: TransferStatus;
  requested_by: string;
  requested_at: string;
  approved_at: string | null;
  shipped_at: string | null;
  received_at: string | null;
  received_by: string | null;
  note: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const toTransfer = (row: TransferRow): Transfer => ({
  id: row.id,
  number: row.number,
  fromShopId: row.from_shop_id,
  toShopId: row.to_shop_id,
  status: row.status,
  requestedBy: row.requested_by,
  requestedAt: row.requested_at,
  approvedAt: row.approved_at,
  shippedAt: row.shipped_at,
  receivedAt: row.received_at,
  receivedBy: row.received_by,
  note: row.note,
  rejectionReason: row.rejection_reason,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
});

interface TransferLineRow {
  id: string;
  transfer_id: string;
  product_id: string;
  unit_id: string | null;
  label: string;
  identifier: string | null;
  quantity: number;
  received_quantity: number;
  position: number;
}

const toLine = (row: TransferLineRow): TransferLine => ({
  id: row.id,
  transferId: row.transfer_id,
  productId: row.product_id,
  unitId: row.unit_id,
  label: row.label,
  identifier: row.identifier,
  quantity: row.quantity,
  receivedQuantity: row.received_quantity,
});

export interface TransferLineDraft {
  productId: string;
  unitId?: string | null;
  label: string;
  identifier?: string | null;
  quantity: number;
}

export interface TransferDetail {
  transfer: Transfer;
  lines: TransferLine[];
  fromShopName: string;
  toShopName: string;
}

export interface TransferQuery {
  shopId: string;
  /** `out` : ce que la boutique envoie. `in` : ce qu'elle reçoit. */
  direction?: 'out' | 'in' | 'both';
  status?: TransferStatus | null;
  limit?: number;
  offset?: number;
}

export class TransferRepository {
  constructor(private readonly db: SqlExecutor) {}

  async byId(id: string): Promise<Transfer | null> {
    const rows = await this.db.select<TransferRow>('SELECT * FROM transfer WHERE id = ?', [id]);
    return rows[0] ? toTransfer(rows[0]) : null;
  }

  async byNumber(number: string): Promise<Transfer | null> {
    const rows = await this.db.select<TransferRow>('SELECT * FROM transfer WHERE number = ?', [
      number,
    ]);
    return rows[0] ? toTransfer(rows[0]) : null;
  }

  async lines(transferId: string): Promise<TransferLine[]> {
    const rows = await this.db.select<TransferLineRow>(
      'SELECT * FROM transfer_line WHERE transfer_id = ? ORDER BY position, id',
      [transferId],
    );
    return rows.map(toLine);
  }

  async detail(id: string): Promise<TransferDetail | null> {
    const transfer = await this.byId(id);
    if (!transfer) return null;
    const [lines, shops] = await Promise.all([
      this.lines(id),
      this.db.select<{ id: string; name: string }>('SELECT id, name FROM shop WHERE id IN (?, ?)', [
        transfer.fromShopId,
        transfer.toShopId,
      ]),
    ]);
    const names = new Map(shops.map((shop) => [shop.id, shop.name]));
    return {
      transfer,
      lines,
      fromShopName: names.get(transfer.fromShopId) ?? '—',
      toShopName: names.get(transfer.toShopId) ?? '—',
    };
  }

  async list(
    query: TransferQuery,
  ): Promise<{ items: (Transfer & { itemCount: number })[]; total: number }> {
    const limit = Math.min(query.limit ?? 50, 500);
    const offset = Math.max(0, query.offset ?? 0);

    const direction = query.direction ?? 'both';
    const conditions = ['t.deleted_at IS NULL'];
    const params: unknown[] = [];
    if (direction === 'out') {
      conditions.push('t.from_shop_id = ?');
      params.push(query.shopId);
    } else if (direction === 'in') {
      conditions.push('t.to_shop_id = ?');
      params.push(query.shopId);
    } else {
      conditions.push('(t.from_shop_id = ? OR t.to_shop_id = ?)');
      params.push(query.shopId, query.shopId);
    }
    if (query.status) {
      conditions.push('t.status = ?');
      params.push(query.status);
    }
    const where = conditions.join(' AND ');

    const rows = await this.db.select<TransferRow & { item_count: number }>(
      `SELECT t.*, (SELECT COALESCE(SUM(l.quantity), 0) FROM transfer_line l
                    WHERE l.transfer_id = t.id) AS item_count
       FROM transfer t WHERE ${where}
       ORDER BY t.requested_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    const totals = await this.db.select<{ total: number }>(
      `SELECT COUNT(*) AS total FROM transfer t WHERE ${where}`,
      params,
    );
    return {
      items: rows.map((row) => ({ ...toTransfer(row), itemCount: row.item_count })),
      total: totals[0]?.total ?? 0,
    };
  }

  async insert(
    tx: SqlExecutor,
    header: {
      number: string;
      fromShopId: string;
      toShopId: string;
      requestedBy: string;
      note?: string | null;
      status?: TransferStatus;
    },
    lines: TransferLineDraft[],
    id = newId(),
  ): Promise<string> {
    const at = nowIso();
    await tx.execute(
      `INSERT INTO transfer (id, number, from_shop_id, to_shop_id, status, requested_by,
                             requested_at, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        header.number,
        header.fromShopId,
        header.toShopId,
        header.status ?? 'REQUESTED',
        header.requestedBy,
        at,
        header.note ?? null,
        at,
        at,
      ],
    );
    for (const [position, line] of lines.entries()) {
      await tx.execute(
        `INSERT INTO transfer_line (id, transfer_id, product_id, unit_id, label, identifier,
                                    quantity, received_quantity, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        [
          newId(),
          id,
          line.productId,
          line.unitId ?? null,
          line.label,
          line.identifier ?? null,
          line.quantity,
          position,
        ],
      );
    }
    return id;
  }

  async setStatus(
    tx: SqlExecutor,
    id: string,
    status: TransferStatus,
    stamps: {
      approvedAt?: string;
      shippedAt?: string;
      receivedAt?: string;
      receivedBy?: string;
      rejectionReason?: string;
    } = {},
  ): Promise<void> {
    await tx.execute(
      `UPDATE transfer SET
         status = ?,
         approved_at = COALESCE(?, approved_at),
         shipped_at = COALESCE(?, shipped_at),
         received_at = COALESCE(?, received_at),
         received_by = COALESCE(?, received_by),
         rejection_reason = COALESCE(?, rejection_reason),
         updated_at = ?
       WHERE id = ?`,
      [
        status,
        stamps.approvedAt ?? null,
        stamps.shippedAt ?? null,
        stamps.receivedAt ?? null,
        stamps.receivedBy ?? null,
        stamps.rejectionReason ?? null,
        nowIso(),
        id,
      ],
    );
  }

  async addReceivedQuantity(tx: SqlExecutor, lineId: string, quantity: number): Promise<void> {
    await tx.execute(
      'UPDATE transfer_line SET received_quantity = received_quantity + ? WHERE id = ?',
      [quantity, lineId],
    );
  }
}
