import { newId, nowIso } from '@boutique/shared';
import type {
  CostAllocation,
  LandedCost,
  LandedCostKind,
  Money,
  Purchase,
  PurchaseLine,
  PurchaseStatus,
} from '@boutique/shared';
import type { SqlExecutor } from '../client';

/** Achats, lignes d'achat, coûts logistiques et réceptions (§10, §11). */

interface PurchaseRow {
  id: string;
  shop_id: string;
  number: string;
  supplier_id: string;
  supplier_reference: string | null;
  status: PurchaseStatus;
  ordered_at: string | null;
  expected_at: string | null;
  subtotal: number;
  discount: number;
  tax: number;
  landed_cost_total: number;
  total: number;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const toPurchase = (row: PurchaseRow): Purchase => ({
  id: row.id,
  shopId: row.shop_id,
  number: row.number,
  supplierId: row.supplier_id,
  supplierReference: row.supplier_reference,
  status: row.status,
  orderedAt: row.ordered_at,
  expectedAt: row.expected_at,
  subtotal: row.subtotal,
  discount: row.discount,
  tax: row.tax,
  landedCostTotal: row.landed_cost_total,
  total: row.total,
  notes: row.notes,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
});

interface LineRow {
  id: string;
  purchase_id: string;
  product_id: string;
  label: string;
  quantity: number;
  received_quantity: number;
  unit_price: number;
  discount: number;
  tax_rate: number | null;
  line_total: number;
  allocated_cost: number;
  position: number;
}

const toLine = (row: LineRow): PurchaseLine => ({
  id: row.id,
  purchaseId: row.purchase_id,
  productId: row.product_id,
  label: row.label,
  quantity: row.quantity,
  receivedQuantity: row.received_quantity,
  unitPrice: row.unit_price,
  discount: row.discount,
  taxRate: row.tax_rate,
  lineTotal: row.line_total,
  allocatedCost: row.allocated_cost,
});

interface CostRow {
  id: string;
  purchase_id: string;
  kind: LandedCostKind;
  label: string | null;
  amount: number;
  allocation: CostAllocation;
  created_at: string;
}

const toCost = (row: CostRow): LandedCost => ({
  id: row.id,
  purchaseId: row.purchase_id,
  kind: row.kind,
  label: row.label,
  amount: row.amount,
  allocation: row.allocation,
  createdAt: row.created_at,
});

export interface PurchaseLineInput {
  productId: string;
  label: string;
  quantity: number;
  unitPrice: Money;
  discount?: Money;
  taxRate?: number | null;
}

export interface PurchaseHeaderInput {
  shopId: string;
  number: string;
  supplierId: string;
  supplierReference?: string | null;
  expectedAt?: string | null;
  notes?: string | null;
  createdBy: string;
}

/** Achat complet, tel que l'écran de détail l'affiche. */
export interface PurchaseDetail {
  purchase: Purchase;
  lines: PurchaseLine[];
  costs: LandedCost[];
  supplierName: string;
}

export interface PurchaseQuery {
  shopId: string;
  status?: PurchaseStatus | null;
  supplierId?: string | null;
  query?: string;
  limit?: number;
  offset?: number;
}

export class PurchaseRepository {
  constructor(private readonly db: SqlExecutor) {}

  async byId(id: string): Promise<Purchase | null> {
    const rows = await this.db.select<PurchaseRow>('SELECT * FROM purchase WHERE id = ?', [id]);
    return rows[0] ? toPurchase(rows[0]) : null;
  }

  async detail(id: string): Promise<PurchaseDetail | null> {
    const purchase = await this.byId(id);
    if (!purchase) return null;
    const [lines, costs, supplier] = await Promise.all([
      this.lines(id),
      this.costs(id),
      this.db.select<{ name: string }>('SELECT name FROM supplier WHERE id = ?', [
        purchase.supplierId,
      ]),
    ]);
    return { purchase, lines, costs, supplierName: supplier[0]?.name ?? '—' };
  }

  async lines(purchaseId: string): Promise<PurchaseLine[]> {
    const rows = await this.db.select<LineRow>(
      'SELECT * FROM purchase_line WHERE purchase_id = ? ORDER BY position, id',
      [purchaseId],
    );
    return rows.map(toLine);
  }

  async costs(purchaseId: string): Promise<LandedCost[]> {
    const rows = await this.db.select<CostRow>(
      'SELECT * FROM landed_cost WHERE purchase_id = ? ORDER BY created_at',
      [purchaseId],
    );
    return rows.map(toCost);
  }

  async list(
    query: PurchaseQuery,
  ): Promise<{ items: (Purchase & { supplierName: string })[]; total: number }> {
    const limit = Math.min(query.limit ?? 50, 500);
    const offset = Math.max(0, query.offset ?? 0);

    const conditions = ['p.deleted_at IS NULL', 'p.shop_id = ?'];
    const params: unknown[] = [query.shopId];
    if (query.status) {
      conditions.push('p.status = ?');
      params.push(query.status);
    }
    if (query.supplierId) {
      conditions.push('p.supplier_id = ?');
      params.push(query.supplierId);
    }
    if (query.query && query.query.trim() !== '') {
      conditions.push('(p.number LIKE ? OR p.supplier_reference LIKE ? OR s.name LIKE ?)');
      const like = `%${query.query.trim()}%`;
      params.push(like, like, like);
    }
    const where = conditions.join(' AND ');

    const rows = await this.db.select<PurchaseRow & { supplier_name: string }>(
      `SELECT p.*, s.name AS supplier_name
       FROM purchase p JOIN supplier s ON s.id = p.supplier_id
       WHERE ${where}
       ORDER BY COALESCE(p.ordered_at, p.created_at) DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    const totals = await this.db.select<{ total: number }>(
      `SELECT COUNT(*) AS total FROM purchase p JOIN supplier s ON s.id = p.supplier_id WHERE ${where}`,
      params,
    );

    return {
      items: rows.map((row) => ({ ...toPurchase(row), supplierName: row.supplier_name })),
      total: totals[0]?.total ?? 0,
    };
  }

  async create(
    tx: SqlExecutor,
    header: PurchaseHeaderInput,
    lines: PurchaseLineInput[],
    id = newId(),
  ): Promise<string> {
    const at = nowIso();
    const totals = computeTotals(lines);

    await tx.execute(
      `INSERT INTO purchase (id, shop_id, number, supplier_id, supplier_reference, status,
                             expected_at, subtotal, discount, tax, landed_cost_total, total,
                             notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      [
        id,
        header.shopId,
        header.number,
        header.supplierId,
        header.supplierReference ?? null,
        header.expectedAt ?? null,
        totals.subtotal,
        totals.discount,
        totals.tax,
        totals.total,
        header.notes ?? null,
        header.createdBy,
        at,
        at,
      ],
    );

    for (const [position, line] of lines.entries()) {
      await tx.execute(
        `INSERT INTO purchase_line (id, purchase_id, product_id, label, quantity, received_quantity,
                                    unit_price, discount, tax_rate, line_total, allocated_cost, position)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, ?)`,
        [
          newId(),
          id,
          line.productId,
          line.label,
          line.quantity,
          line.unitPrice,
          line.discount ?? 0,
          line.taxRate ?? null,
          line.quantity * line.unitPrice - (line.discount ?? 0),
          position,
        ],
      );
    }

    return id;
  }

  async replaceLines(
    tx: SqlExecutor,
    purchaseId: string,
    lines: PurchaseLineInput[],
  ): Promise<void> {
    const totals = computeTotals(lines);
    await tx.execute('DELETE FROM purchase_line WHERE purchase_id = ?', [purchaseId]);
    for (const [position, line] of lines.entries()) {
      await tx.execute(
        `INSERT INTO purchase_line (id, purchase_id, product_id, label, quantity, received_quantity,
                                    unit_price, discount, tax_rate, line_total, allocated_cost, position)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, ?)`,
        [
          newId(),
          purchaseId,
          line.productId,
          line.label,
          line.quantity,
          line.unitPrice,
          line.discount ?? 0,
          line.taxRate ?? null,
          line.quantity * line.unitPrice - (line.discount ?? 0),
          position,
        ],
      );
    }
    await tx.execute(
      `UPDATE purchase SET subtotal = ?, discount = ?, tax = ?,
              total = ? + landed_cost_total, updated_at = ?
       WHERE id = ?`,
      [totals.subtotal, totals.discount, totals.tax, totals.total, nowIso(), purchaseId],
    );
  }

  async setStatus(
    tx: SqlExecutor,
    id: string,
    status: PurchaseStatus,
    orderedAt?: string | null,
  ): Promise<void> {
    await tx.execute(
      `UPDATE purchase SET status = ?, ordered_at = COALESCE(?, ordered_at), updated_at = ? WHERE id = ?`,
      [status, orderedAt ?? null, nowIso(), id],
    );
  }

  async addCost(
    tx: SqlExecutor,
    purchaseId: string,
    input: {
      kind: LandedCostKind;
      label?: string | null;
      amount: Money;
      allocation?: CostAllocation;
    },
  ): Promise<string> {
    const id = newId();
    await tx.execute(
      `INSERT INTO landed_cost (id, purchase_id, kind, label, amount, allocation, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        purchaseId,
        input.kind,
        input.label ?? null,
        input.amount,
        input.allocation ?? 'BY_VALUE',
        nowIso(),
      ],
    );
    return id;
  }

  async removeCost(tx: SqlExecutor, costId: string): Promise<void> {
    await tx.execute('DELETE FROM landed_cost WHERE id = ?', [costId]);
  }

  /** Écrit les parts ventilées et met à jour les totaux de l'en-tête. */
  async applyAllocation(
    tx: SqlExecutor,
    purchaseId: string,
    allocation: { lineId: string; allocatedCost: Money }[],
    landedTotal: Money,
  ): Promise<void> {
    for (const entry of allocation) {
      await tx.execute('UPDATE purchase_line SET allocated_cost = ? WHERE id = ?', [
        entry.allocatedCost,
        entry.lineId,
      ]);
    }
    await tx.execute(
      `UPDATE purchase SET landed_cost_total = ?, total = subtotal - discount + tax + ?, updated_at = ?
       WHERE id = ?`,
      [landedTotal, landedTotal, nowIso(), purchaseId],
    );
  }

  async recordReceipt(
    tx: SqlExecutor,
    input: { purchaseId: string; shopId: string; userId: string; note?: string | null },
    lines: { purchaseLineId: string; quantity: number }[],
  ): Promise<string> {
    const id = newId();
    const at = nowIso();
    await tx.execute(
      `INSERT INTO purchase_receipt (id, purchase_id, shop_id, received_at, user_id, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.purchaseId, input.shopId, at, input.userId, input.note ?? null, at],
    );
    for (const line of lines) {
      await tx.execute(
        `INSERT INTO purchase_receipt_line (id, receipt_id, purchase_line_id, quantity)
         VALUES (?, ?, ?, ?)`,
        [newId(), id, line.purchaseLineId, line.quantity],
      );
      await tx.execute(
        'UPDATE purchase_line SET received_quantity = received_quantity + ? WHERE id = ?',
        [line.quantity, line.purchaseLineId],
      );
    }
    return id;
  }

  async softDelete(id: string): Promise<void> {
    const at = nowIso();
    await this.db.execute('UPDATE purchase SET deleted_at = ?, updated_at = ? WHERE id = ?', [
      at,
      at,
      id,
    ]);
  }
}

/** Totaux d'un achat à partir de ses lignes. Une seule définition, ici. */
export function computeTotals(lines: readonly PurchaseLineInput[]): {
  subtotal: Money;
  discount: Money;
  tax: Money;
  total: Money;
} {
  let subtotal = 0;
  let discount = 0;
  let tax = 0;
  for (const line of lines) {
    const gross = line.quantity * line.unitPrice;
    const lineDiscount = line.discount ?? 0;
    subtotal += gross;
    discount += lineDiscount;
    if (line.taxRate) tax += Math.round(((gross - lineDiscount) * line.taxRate) / 10_000);
  }
  return { subtotal, discount, tax, total: subtotal - discount + tax };
}
