import { newId, nowIso } from '@boutique/shared';
import type { Invoice, InvoiceStatus, Money } from '@boutique/shared';
import type { SqlExecutor } from '../client';

/** Factures (§13). */

interface InvoiceRow {
  id: string;
  shop_id: string;
  number: string;
  sale_id: string | null;
  customer_id: string | null;
  status: InvoiceStatus;
  issued_at: string;
  due_at: string | null;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  paid: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const toInvoice = (row: InvoiceRow): Invoice => ({
  id: row.id,
  shopId: row.shop_id,
  number: row.number,
  saleId: row.sale_id,
  customerId: row.customer_id,
  status: row.status,
  issuedAt: row.issued_at,
  dueAt: row.due_at,
  subtotal: row.subtotal,
  discount: row.discount,
  tax: row.tax,
  total: row.total,
  paid: row.paid,
  notes: row.notes,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
});

export class InvoiceRepository {
  constructor(private readonly db: SqlExecutor) {}

  async byId(id: string): Promise<Invoice | null> {
    const rows = await this.db.select<InvoiceRow>('SELECT * FROM invoice WHERE id = ?', [id]);
    return rows[0] ? toInvoice(rows[0]) : null;
  }

  async bySale(saleId: string): Promise<Invoice | null> {
    const rows = await this.db.select<InvoiceRow>('SELECT * FROM invoice WHERE sale_id = ?', [
      saleId,
    ]);
    return rows[0] ? toInvoice(rows[0]) : null;
  }

  async list(query: {
    shopId: string;
    status?: InvoiceStatus | null;
    customerId?: string | null;
    from?: string | null;
    to?: string | null;
    limit?: number;
    offset?: number;
  }): Promise<{
    items: (Invoice & { customerLabel: string | null })[];
    total: number;
    sum: number;
  }> {
    const limit = Math.min(query.limit ?? 50, 500);
    const offset = Math.max(0, query.offset ?? 0);
    const conditions = ['i.deleted_at IS NULL', 'i.shop_id = ?'];
    const params: unknown[] = [query.shopId];
    if (query.status) {
      conditions.push('i.status = ?');
      params.push(query.status);
    }
    if (query.customerId) {
      conditions.push('i.customer_id = ?');
      params.push(query.customerId);
    }
    if (query.from) {
      conditions.push('i.issued_at >= ?');
      params.push(query.from);
    }
    if (query.to) {
      conditions.push('i.issued_at < ?');
      params.push(query.to);
    }
    const where = conditions.join(' AND ');

    const rows = await this.db.select<InvoiceRow & { customer_label: string | null }>(
      `SELECT i.*, TRIM(COALESCE(c.first_name, '') || ' ' || c.last_name) AS customer_label
       FROM invoice i LEFT JOIN customer c ON c.id = i.customer_id
       WHERE ${where} ORDER BY i.issued_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    const totals = await this.db.select<{ total: number; sum: number }>(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN i.status <> 'CANCELLED' THEN i.total ELSE 0 END), 0) AS sum
       FROM invoice i WHERE ${where}`,
      params,
    );
    return {
      items: rows.map((row) => ({ ...toInvoice(row), customerLabel: row.customer_label || null })),
      total: totals[0]?.total ?? 0,
      sum: totals[0]?.sum ?? 0,
    };
  }

  async insert(
    tx: SqlExecutor,
    input: {
      shopId: string;
      number: string;
      saleId?: string | null;
      customerId?: string | null;
      status?: InvoiceStatus;
      issuedAt?: string;
      dueAt?: string | null;
      subtotal: Money;
      discount: Money;
      tax: Money;
      total: Money;
      paid: Money;
      notes?: string | null;
    },
    id = newId(),
  ): Promise<string> {
    const at = nowIso();
    await tx.execute(
      `INSERT INTO invoice (id, shop_id, number, sale_id, customer_id, status, issued_at, due_at,
                            subtotal, discount, tax, total, paid, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.shopId,
        input.number,
        input.saleId ?? null,
        input.customerId ?? null,
        input.status ?? 'ISSUED',
        input.issuedAt ?? at,
        input.dueAt ?? null,
        input.subtotal,
        input.discount,
        input.tax,
        input.total,
        input.paid,
        input.notes ?? null,
        at,
        at,
      ],
    );
    return id;
  }

  async setStatus(tx: SqlExecutor, id: string, status: InvoiceStatus, paid?: Money): Promise<void> {
    await tx.execute(
      'UPDATE invoice SET status = ?, paid = COALESCE(?, paid), updated_at = ? WHERE id = ?',
      [status, paid ?? null, nowIso(), id],
    );
  }
}
