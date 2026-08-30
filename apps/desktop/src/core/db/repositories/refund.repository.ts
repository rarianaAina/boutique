import { newId, nowIso } from '@boutique/shared';
import type { Exchange, Money, Refund, RefundLine, RefundStatus } from '@boutique/shared';
import { toBool } from '../rows';
import type { SqlExecutor } from '../client';

/** Remboursements (§16) et échanges (§15). */

interface RefundRow {
  id: string;
  shop_id: string;
  number: string;
  sale_id: string;
  status: RefundStatus;
  reason: string | null;
  method: string;
  total: number;
  user_id: string;
  refunded_at: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const toRefund = (row: RefundRow): Refund => ({
  id: row.id,
  shopId: row.shop_id,
  number: row.number,
  saleId: row.sale_id,
  status: row.status,
  reason: row.reason,
  method: row.method,
  total: row.total,
  userId: row.user_id,
  refundedAt: row.refunded_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
});

interface RefundLineRow {
  id: string;
  refund_id: string;
  sale_line_id: string;
  product_id: string;
  unit_id: string | null;
  quantity: number;
  amount: number;
  restock: number;
}

const toRefundLine = (row: RefundLineRow): RefundLine => ({
  id: row.id,
  refundId: row.refund_id,
  saleLineId: row.sale_line_id,
  productId: row.product_id,
  unitId: row.unit_id,
  quantity: row.quantity,
  amount: row.amount,
  restock: toBool(row.restock),
});

interface ExchangeRow {
  id: string;
  shop_id: string;
  number: string;
  original_sale_id: string;
  new_sale_id: string | null;
  returned_unit_id: string;
  new_unit_id: string | null;
  new_product_id: string | null;
  price_difference: number;
  settled_method: string | null;
  reason: string | null;
  user_id: string;
  exchanged_at: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const toExchange = (row: ExchangeRow): Exchange => ({
  id: row.id,
  shopId: row.shop_id,
  number: row.number,
  originalSaleId: row.original_sale_id,
  newSaleId: row.new_sale_id,
  returnedUnitId: row.returned_unit_id,
  newUnitId: row.new_unit_id,
  newProductId: row.new_product_id,
  priceDifference: row.price_difference,
  settledMethod: row.settled_method,
  reason: row.reason,
  userId: row.user_id,
  exchangedAt: row.exchanged_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
});

export interface RefundLineDraft {
  saleLineId: string;
  productId: string;
  unitId?: string | null;
  quantity: number;
  amount: Money;
  restock: boolean;
}

export class RefundRepository {
  constructor(private readonly db: SqlExecutor) {}

  async byId(id: string): Promise<Refund | null> {
    const rows = await this.db.select<RefundRow>('SELECT * FROM refund WHERE id = ?', [id]);
    return rows[0] ? toRefund(rows[0]) : null;
  }

  async lines(refundId: string): Promise<RefundLine[]> {
    const rows = await this.db.select<RefundLineRow>(
      'SELECT * FROM refund_line WHERE refund_id = ?',
      [refundId],
    );
    return rows.map(toRefundLine);
  }

  async forSale(saleId: string): Promise<Refund[]> {
    const rows = await this.db.select<RefundRow>(
      'SELECT * FROM refund WHERE sale_id = ? ORDER BY refunded_at',
      [saleId],
    );
    return rows.map(toRefund);
  }

  async list(query: {
    shopId: string;
    from?: string | null;
    to?: string | null;
    limit?: number;
    offset?: number;
  }): Promise<{ items: (Refund & { saleNumber: string })[]; total: number; sum: number }> {
    const limit = Math.min(query.limit ?? 50, 500);
    const offset = Math.max(0, query.offset ?? 0);
    const conditions = ['r.deleted_at IS NULL', 'r.shop_id = ?'];
    const params: unknown[] = [query.shopId];
    if (query.from) {
      conditions.push('r.refunded_at >= ?');
      params.push(query.from);
    }
    if (query.to) {
      conditions.push('r.refunded_at < ?');
      params.push(query.to);
    }
    const where = conditions.join(' AND ');

    const rows = await this.db.select<RefundRow & { sale_number: string }>(
      `SELECT r.*, s.number AS sale_number FROM refund r
       JOIN sale s ON s.id = r.sale_id
       WHERE ${where} ORDER BY r.refunded_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    const totals = await this.db.select<{ total: number; sum: number }>(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN r.status = 'COMPLETED' THEN r.total ELSE 0 END), 0) AS sum
       FROM refund r WHERE ${where}`,
      params,
    );
    return {
      items: rows.map((row) => ({ ...toRefund(row), saleNumber: row.sale_number })),
      total: totals[0]?.total ?? 0,
      sum: totals[0]?.sum ?? 0,
    };
  }

  async insert(
    tx: SqlExecutor,
    header: {
      shopId: string;
      number: string;
      saleId: string;
      reason?: string | null;
      method: string;
      total: Money;
      userId: string;
      refundedAt?: string;
    },
    lines: RefundLineDraft[],
    id = newId(),
  ): Promise<string> {
    const at = nowIso();
    await tx.execute(
      `INSERT INTO refund (id, shop_id, number, sale_id, status, reason, method, total, user_id,
                           refunded_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        header.shopId,
        header.number,
        header.saleId,
        header.reason ?? null,
        header.method,
        header.total,
        header.userId,
        header.refundedAt ?? at,
        at,
        at,
      ],
    );
    for (const line of lines) {
      await tx.execute(
        `INSERT INTO refund_line (id, refund_id, sale_line_id, product_id, unit_id, quantity,
                                  amount, restock)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId(),
          id,
          line.saleLineId,
          line.productId,
          line.unitId ?? null,
          line.quantity,
          line.amount,
          line.restock ? 1 : 0,
        ],
      );
    }
    return id;
  }
}

export class ExchangeRepository {
  constructor(private readonly db: SqlExecutor) {}

  async byId(id: string): Promise<Exchange | null> {
    const rows = await this.db.select<ExchangeRow>('SELECT * FROM exchange WHERE id = ?', [id]);
    return rows[0] ? toExchange(rows[0]) : null;
  }

  async forSale(saleId: string): Promise<Exchange[]> {
    const rows = await this.db.select<ExchangeRow>(
      'SELECT * FROM exchange WHERE original_sale_id = ? ORDER BY exchanged_at',
      [saleId],
    );
    return rows.map(toExchange);
  }

  async forUnit(unitId: string): Promise<Exchange[]> {
    const rows = await this.db.select<ExchangeRow>(
      'SELECT * FROM exchange WHERE returned_unit_id = ? OR new_unit_id = ? ORDER BY exchanged_at',
      [unitId, unitId],
    );
    return rows.map(toExchange);
  }

  async list(query: {
    shopId: string;
    from?: string | null;
    to?: string | null;
    limit?: number;
    offset?: number;
  }): Promise<{ items: (Exchange & { saleNumber: string })[]; total: number }> {
    const limit = Math.min(query.limit ?? 50, 500);
    const offset = Math.max(0, query.offset ?? 0);
    const conditions = ['e.deleted_at IS NULL', 'e.shop_id = ?'];
    const params: unknown[] = [query.shopId];
    if (query.from) {
      conditions.push('e.exchanged_at >= ?');
      params.push(query.from);
    }
    if (query.to) {
      conditions.push('e.exchanged_at < ?');
      params.push(query.to);
    }
    const where = conditions.join(' AND ');

    const rows = await this.db.select<ExchangeRow & { sale_number: string }>(
      `SELECT e.*, s.number AS sale_number FROM exchange e
       JOIN sale s ON s.id = e.original_sale_id
       WHERE ${where} ORDER BY e.exchanged_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    const totals = await this.db.select<{ total: number }>(
      `SELECT COUNT(*) AS total FROM exchange e WHERE ${where}`,
      params,
    );
    return {
      items: rows.map((row) => ({ ...toExchange(row), saleNumber: row.sale_number })),
      total: totals[0]?.total ?? 0,
    };
  }

  async insert(
    tx: SqlExecutor,
    input: {
      shopId: string;
      number: string;
      originalSaleId: string;
      newSaleId?: string | null;
      returnedUnitId: string;
      newUnitId?: string | null;
      newProductId?: string | null;
      priceDifference: Money;
      settledMethod?: string | null;
      reason?: string | null;
      userId: string;
      exchangedAt?: string;
    },
    id = newId(),
  ): Promise<string> {
    const at = nowIso();
    await tx.execute(
      `INSERT INTO exchange (id, shop_id, number, original_sale_id, new_sale_id, returned_unit_id,
                             new_unit_id, new_product_id, price_difference, settled_method, reason,
                             user_id, exchanged_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.shopId,
        input.number,
        input.originalSaleId,
        input.newSaleId ?? null,
        input.returnedUnitId,
        input.newUnitId ?? null,
        input.newProductId ?? null,
        input.priceDifference,
        input.settledMethod ?? null,
        input.reason ?? null,
        input.userId,
        input.exchangedAt ?? at,
        at,
        at,
      ],
    );
    return id;
  }
}
