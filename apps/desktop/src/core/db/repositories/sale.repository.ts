import { newId, nowIso } from '@boutique/shared';
import type { Money, Sale, SaleLine, SalePayment, SaleStatus } from '@boutique/shared';
import { chunk, placeholders } from '../chunk';
import type { SqlExecutor } from '../client';

/** Ventes, lignes et règlements (§12). */

interface SaleRow {
  id: string;
  shop_id: string;
  number: string;
  status: SaleStatus;
  customer_id: string | null;
  user_id: string;
  sold_at: string;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  paid: number;
  change_given: number;
  note: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const toSale = (row: SaleRow): Sale => ({
  id: row.id,
  shopId: row.shop_id,
  number: row.number,
  status: row.status,
  customerId: row.customer_id,
  userId: row.user_id,
  soldAt: row.sold_at,
  subtotal: row.subtotal,
  discount: row.discount,
  tax: row.tax,
  total: row.total,
  paid: row.paid,
  changeGiven: row.change_given,
  note: row.note,
  cancelledAt: row.cancelled_at,
  cancelledBy: row.cancelled_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
});

interface SaleLineRow {
  id: string;
  sale_id: string;
  product_id: string;
  unit_id: string | null;
  label: string;
  identifier: string | null;
  quantity: number;
  unit_price: number;
  discount: number;
  tax_rate: number | null;
  line_total: number;
  unit_cost: number;
  refunded_quantity: number;
  position: number;
}

const toSaleLine = (row: SaleLineRow): SaleLine => ({
  id: row.id,
  saleId: row.sale_id,
  productId: row.product_id,
  unitId: row.unit_id,
  label: row.label,
  identifier: row.identifier,
  quantity: row.quantity,
  unitPrice: row.unit_price,
  discount: row.discount,
  taxRate: row.tax_rate,
  lineTotal: row.line_total,
  unitCost: row.unit_cost,
  refundedQuantity: row.refunded_quantity,
});

interface PaymentRow {
  id: string;
  sale_id: string;
  method: string;
  amount: number;
  reference: string | null;
  paid_at: string;
}

const toPayment = (row: PaymentRow): SalePayment => ({
  id: row.id,
  saleId: row.sale_id,
  method: row.method,
  amount: row.amount,
  reference: row.reference,
  paidAt: row.paid_at,
});

export interface SaleLineDraft {
  productId: string;
  unitId?: string | null;
  label: string;
  identifier?: string | null;
  quantity: number;
  unitPrice: Money;
  discount?: Money;
  taxRate?: number | null;
  unitCost?: Money;
}

export interface PaymentDraft {
  method: string;
  amount: Money;
  reference?: string | null;
}

export interface SaleHeaderDraft {
  shopId: string;
  number: string;
  customerId?: string | null;
  userId: string;
  soldAt?: string;
  note?: string | null;
  changeGiven?: Money;
}

export interface SaleDetail {
  sale: Sale;
  lines: SaleLine[];
  payments: SalePayment[];
  customerLabel: string | null;
  sellerLabel: string;
}

export interface SaleQuery {
  shopId: string;
  status?: SaleStatus | null;
  userId?: string | null;
  customerId?: string | null;
  from?: string | null;
  to?: string | null;
  query?: string;
  limit?: number;
  offset?: number;
}

export class SaleRepository {
  constructor(private readonly db: SqlExecutor) {}

  async byId(id: string): Promise<Sale | null> {
    const rows = await this.db.select<SaleRow>('SELECT * FROM sale WHERE id = ?', [id]);
    return rows[0] ? toSale(rows[0]) : null;
  }

  async byNumber(shopId: string, number: string): Promise<Sale | null> {
    const rows = await this.db.select<SaleRow>(
      'SELECT * FROM sale WHERE shop_id = ? AND number = ?',
      [shopId, number],
    );
    return rows[0] ? toSale(rows[0]) : null;
  }

  async lines(saleId: string): Promise<SaleLine[]> {
    const rows = await this.db.select<SaleLineRow>(
      'SELECT * FROM sale_line WHERE sale_id = ? ORDER BY position, id',
      [saleId],
    );
    return rows.map(toSaleLine);
  }

  async payments(saleId: string): Promise<SalePayment[]> {
    const rows = await this.db.select<PaymentRow>(
      'SELECT * FROM sale_payment WHERE sale_id = ? ORDER BY paid_at',
      [saleId],
    );
    return rows.map(toPayment);
  }

  async detail(id: string): Promise<SaleDetail | null> {
    const sale = await this.byId(id);
    if (!sale) return null;
    const [lines, payments, labels] = await Promise.all([
      this.lines(id),
      this.payments(id),
      this.db.select<{ customer_label: string | null; seller_label: string }>(
        `SELECT TRIM(COALESCE(c.first_name, '') || ' ' || c.last_name) AS customer_label,
                u.full_name AS seller_label
         FROM sale s
         LEFT JOIN customer c ON c.id = s.customer_id
         JOIN app_user u ON u.id = s.user_id
         WHERE s.id = ?`,
        [id],
      ),
    ]);
    return {
      sale,
      lines,
      payments,
      customerLabel: labels[0]?.customer_label || null,
      sellerLabel: labels[0]?.seller_label ?? '—',
    };
  }

  async list(query: SaleQuery): Promise<{
    items: (Sale & { customerLabel: string | null; sellerLabel: string; itemCount: number })[];
    total: number;
    sum: number;
  }> {
    const limit = Math.min(query.limit ?? 50, 500);
    const offset = Math.max(0, query.offset ?? 0);

    const conditions = ['s.deleted_at IS NULL', 's.shop_id = ?'];
    const params: unknown[] = [query.shopId];
    if (query.status) {
      conditions.push('s.status = ?');
      params.push(query.status);
    }
    if (query.userId) {
      conditions.push('s.user_id = ?');
      params.push(query.userId);
    }
    if (query.customerId) {
      conditions.push('s.customer_id = ?');
      params.push(query.customerId);
    }
    if (query.from) {
      conditions.push('s.sold_at >= ?');
      params.push(query.from);
    }
    if (query.to) {
      conditions.push('s.sold_at < ?');
      params.push(query.to);
    }
    if (query.query && query.query.trim() !== '') {
      conditions.push(
        `(s.number LIKE ? OR EXISTS (SELECT 1 FROM sale_line l
            WHERE l.sale_id = s.id AND (l.identifier LIKE ? OR l.label LIKE ?)))`,
      );
      const like = `%${query.query.trim()}%`;
      params.push(like, like, like);
    }
    const where = conditions.join(' AND ');

    const rows = await this.db.select<
      SaleRow & { customer_label: string | null; seller_label: string; item_count: number }
    >(
      `SELECT s.*,
              TRIM(COALESCE(c.first_name, '') || ' ' || c.last_name) AS customer_label,
              u.full_name AS seller_label,
              (SELECT COALESCE(SUM(l.quantity), 0) FROM sale_line l WHERE l.sale_id = s.id) AS item_count
       FROM sale s
       LEFT JOIN customer c ON c.id = s.customer_id
       JOIN app_user u ON u.id = s.user_id
       WHERE ${where}
       ORDER BY s.sold_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    const totals = await this.db.select<{ total: number; sum: number }>(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN s.status <> 'CANCELLED' THEN s.total ELSE 0 END), 0) AS sum
       FROM sale s WHERE ${where}`,
      params,
    );

    return {
      items: rows.map((row) => ({
        ...toSale(row),
        customerLabel: row.customer_label || null,
        sellerLabel: row.seller_label,
        itemCount: row.item_count,
      })),
      total: totals[0]?.total ?? 0,
      sum: totals[0]?.sum ?? 0,
    };
  }

  /** Ventes contenant une unité donnée : point de départ d'un retour. */
  async forUnit(unitId: string): Promise<Sale[]> {
    const rows = await this.db.select<SaleRow>(
      `SELECT s.* FROM sale s
       JOIN sale_line l ON l.sale_id = s.id
       WHERE l.unit_id = ? AND s.deleted_at IS NULL
       ORDER BY s.sold_at DESC`,
      [unitId],
    );
    return rows.map(toSale);
  }

  async insert(
    tx: SqlExecutor,
    header: SaleHeaderDraft,
    lines: SaleLineDraft[],
    payments: PaymentDraft[],
    totals: { subtotal: Money; discount: Money; tax: Money; total: Money; paid: Money },
    id = newId(),
  ): Promise<string> {
    const at = nowIso();
    const soldAt = header.soldAt ?? at;

    await tx.execute(
      `INSERT INTO sale (id, shop_id, number, status, customer_id, user_id, sold_at, subtotal,
                         discount, tax, total, paid, change_given, note, created_at, updated_at)
       VALUES (?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        header.shopId,
        header.number,
        header.customerId ?? null,
        header.userId,
        soldAt,
        totals.subtotal,
        totals.discount,
        totals.tax,
        totals.total,
        totals.paid,
        header.changeGiven ?? 0,
        header.note ?? null,
        at,
        at,
      ],
    );

    for (const [position, line] of lines.entries()) {
      await tx.execute(
        `INSERT INTO sale_line (id, sale_id, product_id, unit_id, label, identifier, quantity,
                                unit_price, discount, tax_rate, line_total, unit_cost,
                                refunded_quantity, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        [
          newId(),
          id,
          line.productId,
          line.unitId ?? null,
          line.label,
          line.identifier ?? null,
          line.quantity,
          line.unitPrice,
          line.discount ?? 0,
          line.taxRate ?? null,
          line.quantity * line.unitPrice - (line.discount ?? 0),
          line.unitCost ?? 0,
          position,
        ],
      );
    }

    for (const payment of payments) {
      await tx.execute(
        `INSERT INTO sale_payment (id, sale_id, method, amount, reference, paid_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [newId(), id, payment.method, payment.amount, payment.reference ?? null, soldAt],
      );
    }

    return id;
  }

  async setStatus(
    tx: SqlExecutor,
    id: string,
    status: SaleStatus,
    cancel?: { at: string; by: string },
  ): Promise<void> {
    await tx.execute(
      `UPDATE sale SET status = ?, cancelled_at = COALESCE(?, cancelled_at),
              cancelled_by = COALESCE(?, cancelled_by), updated_at = ?
       WHERE id = ?`,
      [status, cancel?.at ?? null, cancel?.by ?? null, nowIso(), id],
    );
  }

  async addRefundedQuantity(tx: SqlExecutor, saleLineId: string, quantity: number): Promise<void> {
    await tx.execute(
      'UPDATE sale_line SET refunded_quantity = refunded_quantity + ? WHERE id = ?',
      [quantity, saleLineId],
    );
  }

  /** Total déjà remboursé sur une vente : plafond des remboursements suivants. */
  async refundedTotal(saleId: string): Promise<Money> {
    const rows = await this.db.select<{ total: number }>(
      `SELECT COALESCE(SUM(total), 0) AS total FROM refund
       WHERE sale_id = ? AND status = 'COMPLETED'`,
      [saleId],
    );
    return rows[0]?.total ?? 0;
  }

  async linesByIds(ids: readonly string[]): Promise<Map<string, SaleLine>> {
    const result = new Map<string, SaleLine>();
    for (const batch of chunk(ids)) {
      const rows = await this.db.select<SaleLineRow>(
        `SELECT * FROM sale_line WHERE id IN (${placeholders(batch.length)})`,
        [...batch],
      );
      for (const row of rows) result.set(row.id, toSaleLine(row));
    }
    return result;
  }
}
