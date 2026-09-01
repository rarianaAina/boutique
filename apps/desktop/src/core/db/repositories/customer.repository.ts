import { buildSearchKey, escapeLike, newId, nowIso, searchTerms } from '@boutique/shared';
import type { Customer } from '@boutique/shared';
import type { SqlExecutor } from '../client';

/** Clients (§14). */

interface CustomerRow {
  id: string;
  shop_id: string | null;
  first_name: string | null;
  last_name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  nif: string | null;
  stat: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const toCustomer = (row: CustomerRow): Customer => ({
  id: row.id,
  shopId: row.shop_id,
  firstName: row.first_name,
  lastName: row.last_name,
  phone: row.phone,
  email: row.email,
  address: row.address,
  nif: row.nif,
  stat: row.stat,
  notes: row.notes,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
});

export interface CustomerInput {
  firstName?: string | null;
  lastName: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  /** NIF et STAT, pour un client professionnel. Voir la migration 0005. */
  nif?: string | null;
  stat?: string | null;
  notes?: string | null;
  shopId?: string | null;
}

export const customerName = (customer: Customer): string =>
  [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim();

export class CustomerRepository {
  constructor(private readonly db: SqlExecutor) {}

  async byId(id: string): Promise<Customer | null> {
    const rows = await this.db.select<CustomerRow>('SELECT * FROM customer WHERE id = ?', [id]);
    return rows[0] ? toCustomer(rows[0]) : null;
  }

  async search(query: string, limit = 50): Promise<Customer[]> {
    const conditions = ['deleted_at IS NULL'];
    const params: unknown[] = [];
    for (const term of searchTerms(query)) {
      conditions.push("search_key LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(term)}%`);
    }
    const rows = await this.db.select<CustomerRow>(
      `SELECT * FROM customer WHERE ${conditions.join(' AND ')} ORDER BY last_name, first_name LIMIT ?`,
      [...params, limit],
    );
    return rows.map(toCustomer);
  }

  async byPhone(phone: string): Promise<Customer | null> {
    const rows = await this.db.select<CustomerRow>(
      'SELECT * FROM customer WHERE phone = ? AND deleted_at IS NULL LIMIT 1',
      [phone.trim()],
    );
    return rows[0] ? toCustomer(rows[0]) : null;
  }

  async create(input: CustomerInput, id = newId()): Promise<string> {
    const at = nowIso();
    await this.db.execute(
      `INSERT INTO customer (id, shop_id, first_name, last_name, phone, email, address,
                             nif, stat, notes, search_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.shopId ?? null,
        input.firstName ?? null,
        input.lastName,
        input.phone ?? null,
        input.email ?? null,
        input.address ?? null,
        input.nif ?? null,
        input.stat ?? null,
        input.notes ?? null,
        buildSearchKey(input.firstName, input.lastName, input.phone, input.email),
        at,
        at,
      ],
    );
    return id;
  }

  async update(id: string, input: CustomerInput): Promise<void> {
    await this.db.execute(
      `UPDATE customer SET first_name = ?, last_name = ?, phone = ?, email = ?, address = ?,
              nif = ?, stat = ?, notes = ?, search_key = ?, updated_at = ?
       WHERE id = ?`,
      [
        input.firstName ?? null,
        input.lastName,
        input.phone ?? null,
        input.email ?? null,
        input.address ?? null,
        input.nif ?? null,
        input.stat ?? null,
        input.notes ?? null,
        buildSearchKey(input.firstName, input.lastName, input.phone, input.email),
        nowIso(),
        id,
      ],
    );
  }

  async softDelete(id: string): Promise<void> {
    const at = nowIso();
    await this.db.execute('UPDATE customer SET deleted_at = ?, updated_at = ? WHERE id = ?', [
      at,
      at,
      id,
    ]);
  }

  /**
   * Historique d'un client (§14) : ce qu'il a acheté, et surtout QUELS
   * APPAREILS — c'est la question qu'on pose au comptoir quand un client revient
   * avec un téléphone sans savoir quand il l'a acheté.
   */
  async history(customerId: string): Promise<{
    sales: { id: string; number: string; soldAt: string; total: number; status: string }[];
    devices: {
      unitId: string;
      identifier: string | null;
      productName: string;
      soldAt: string | null;
    }[];
    totals: { salesCount: number; totalSpent: number; refunded: number };
  }> {
    const sales = await this.db.select<{
      id: string;
      number: string;
      sold_at: string;
      total: number;
      status: string;
    }>(
      `SELECT id, number, sold_at, total, status FROM sale
       WHERE customer_id = ? AND deleted_at IS NULL
       ORDER BY sold_at DESC LIMIT 200`,
      [customerId],
    );

    const devices = await this.db.select<{
      unit_id: string;
      identifier: string | null;
      product_name: string;
      sold_at: string | null;
    }>(
      `SELECT u.id AS unit_id, COALESCE(u.imei1, u.serial) AS identifier,
              p.name AS product_name, s.sold_at
       FROM sale s
       JOIN sale_line l ON l.sale_id = s.id
       JOIN v_unit u ON u.id = l.unit_id
       JOIN product p ON p.id = u.product_id
       WHERE s.customer_id = ? AND s.deleted_at IS NULL AND l.unit_id IS NOT NULL
       ORDER BY s.sold_at DESC LIMIT 200`,
      [customerId],
    );

    const totals = await this.db.select<{ count: number; spent: number }>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS spent FROM sale
       WHERE customer_id = ? AND deleted_at IS NULL AND status <> 'CANCELLED'`,
      [customerId],
    );
    const refunded = await this.db.select<{ total: number }>(
      `SELECT COALESCE(SUM(r.total), 0) AS total FROM refund r
       JOIN sale s ON s.id = r.sale_id
       WHERE s.customer_id = ? AND r.status = 'COMPLETED'`,
      [customerId],
    );

    return {
      sales: sales.map((row) => ({
        id: row.id,
        number: row.number,
        soldAt: row.sold_at,
        total: row.total,
        status: row.status,
      })),
      devices: devices.map((row) => ({
        unitId: row.unit_id,
        identifier: row.identifier,
        productName: row.product_name,
        soldAt: row.sold_at,
      })),
      totals: {
        salesCount: totals[0]?.count ?? 0,
        totalSpent: totals[0]?.spent ?? 0,
        refunded: refunded[0]?.total ?? 0,
      },
    };
  }
}
