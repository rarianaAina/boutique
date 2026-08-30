import { escapeLike, normalizeImei, searchTerms } from '@boutique/shared';
import type { SqlExecutor } from '../db/client';

/**
 * Recherche globale (§23).
 *
 * Un seul champ, une seule frappe, et l'on trouve : un IMEI, un numéro de
 * série, un SKU, un code-barres, un nom de produit, un client, un numéro de
 * ticket, de facture ou de transfert.
 *
 * L'ordre des recherches n'est pas indifférent : les identifiants EXACTS
 * passent d'abord. Au comptoir, quand un vendeur colle un IMEI, il attend la
 * fiche de l'appareil — pas une liste de produits dont le nom contient ces
 * chiffres. Une correspondance exacte l'emporte donc toujours sur une
 * approximation, et la recherche s'arrête dès qu'elle en tient une.
 */

export type SearchKind =
  'UNIT' | 'PRODUCT' | 'CUSTOMER' | 'SALE' | 'INVOICE' | 'TRANSFER' | 'PURCHASE' | 'SUPPLIER';

export interface SearchHit {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle: string;
  /** Vrai pour une correspondance sur un identifiant exact. */
  exact: boolean;
}

export interface SearchResult {
  hits: SearchHit[];
  /** Renseigné quand une seule fiche répond : l'écran y va directement. */
  direct: SearchHit | null;
}

const LIMIT_PER_KIND = 8;

export class SearchService {
  constructor(private readonly db: SqlExecutor) {}

  async search(query: string): Promise<SearchResult> {
    const raw = query.trim();
    if (raw.length < 2) return { hits: [], direct: null };

    const exact = await this.exactMatches(raw);
    if (exact.length > 0) {
      return { hits: exact, direct: exact.length === 1 ? (exact[0] ?? null) : null };
    }

    const hits = [
      ...(await this.products(raw)),
      ...(await this.customers(raw)),
      ...(await this.documents(raw)),
      ...(await this.suppliers(raw)),
    ];
    return { hits, direct: null };
  }

  /** Identifiants exacts : IMEI, numéro de série, code-barres, SKU, numéros. */
  private async exactMatches(query: string): Promise<SearchHit[]> {
    const digits = normalizeImei(query);
    const candidates = [query, query.toUpperCase(), digits].filter(
      (value, index, list) => value !== '' && list.indexOf(value) === index,
    );

    const units = await this.db.select<{
      id: string;
      identifier: string;
      product_name: string;
      status: string;
      shop_name: string;
    }>(
      `SELECT u.id, i.value AS identifier, p.name AS product_name, u.status, s.name AS shop_name
       FROM unit_identifier i
       JOIN v_unit u ON u.id = i.unit_id
       JOIN product p ON p.id = u.product_id
       JOIN shop s ON s.id = u.shop_id
       WHERE i.value IN (${candidates.map(() => '?').join(', ')})
       LIMIT 5`,
      candidates,
    );
    if (units.length > 0) {
      return units.map((row) => ({
        kind: 'UNIT' as const,
        id: row.id,
        title: `${row.identifier} — ${row.product_name}`,
        subtitle: `${row.status} · ${row.shop_name}`,
        exact: true,
      }));
    }

    const products = await this.db.select<{ id: string; sku: string; name: string }>(
      `SELECT id, sku, name FROM product
       WHERE deleted_at IS NULL AND (sku = ? OR barcode = ?) LIMIT 5`,
      [query, query],
    );
    if (products.length > 0) {
      return products.map((row) => ({
        kind: 'PRODUCT' as const,
        id: row.id,
        title: row.name,
        subtitle: `SKU ${row.sku}`,
        exact: true,
      }));
    }

    const documents = await this.documents(query, true);
    return documents;
  }

  private async products(query: string): Promise<SearchHit[]> {
    const conditions = ['deleted_at IS NULL'];
    const params: unknown[] = [];
    for (const term of searchTerms(query)) {
      conditions.push("search_key LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(term)}%`);
    }
    const rows = await this.db.select<{
      id: string;
      name: string;
      sku: string;
      brand: string | null;
    }>(
      `SELECT id, name, sku, brand FROM product WHERE ${conditions.join(' AND ')}
       ORDER BY name LIMIT ?`,
      [...params, LIMIT_PER_KIND],
    );
    return rows.map((row) => ({
      kind: 'PRODUCT' as const,
      id: row.id,
      title: row.name,
      subtitle: [row.brand, `SKU ${row.sku}`].filter(Boolean).join(' · '),
      exact: false,
    }));
  }

  private async customers(query: string): Promise<SearchHit[]> {
    const conditions = ['deleted_at IS NULL'];
    const params: unknown[] = [];
    for (const term of searchTerms(query)) {
      conditions.push("search_key LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(term)}%`);
    }
    const rows = await this.db.select<{
      id: string;
      first_name: string | null;
      last_name: string;
      phone: string | null;
    }>(
      `SELECT id, first_name, last_name, phone FROM customer WHERE ${conditions.join(' AND ')}
       ORDER BY last_name LIMIT ?`,
      [...params, LIMIT_PER_KIND],
    );
    return rows.map((row) => ({
      kind: 'CUSTOMER' as const,
      id: row.id,
      title: [row.first_name, row.last_name].filter(Boolean).join(' '),
      subtitle: row.phone ?? 'Client',
      exact: false,
    }));
  }

  private async suppliers(query: string): Promise<SearchHit[]> {
    const conditions = ['deleted_at IS NULL'];
    const params: unknown[] = [];
    for (const term of searchTerms(query)) {
      conditions.push("search_key LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(term)}%`);
    }
    const rows = await this.db.select<{ id: string; name: string; code: string }>(
      `SELECT id, name, code FROM supplier WHERE ${conditions.join(' AND ')} ORDER BY name LIMIT ?`,
      [...params, LIMIT_PER_KIND],
    );
    return rows.map((row) => ({
      kind: 'SUPPLIER' as const,
      id: row.id,
      title: row.name,
      subtitle: `Fournisseur ${row.code}`,
      exact: false,
    }));
  }

  /** Numéros de tickets, factures, transferts et achats. */
  private async documents(query: string, exactOnly = false): Promise<SearchHit[]> {
    const pattern = exactOnly ? query : `%${escapeLike(query)}%`;
    const hits: SearchHit[] = [];

    const sales = await this.db.select<{
      id: string;
      number: string;
      sold_at: string;
      total: number;
    }>(
      exactOnly
        ? 'SELECT id, number, sold_at, total FROM sale WHERE number = ? AND deleted_at IS NULL LIMIT 5'
        : "SELECT id, number, sold_at, total FROM sale WHERE number LIKE ? ESCAPE '\\' AND deleted_at IS NULL LIMIT 8",
      [pattern],
    );
    hits.push(
      ...sales.map((row) => ({
        kind: 'SALE' as const,
        id: row.id,
        title: `Ticket ${row.number}`,
        subtitle: row.sold_at.slice(0, 10),
        exact: exactOnly,
      })),
    );

    const invoices = await this.db.select<{ id: string; number: string; issued_at: string }>(
      exactOnly
        ? 'SELECT id, number, issued_at FROM invoice WHERE number = ? AND deleted_at IS NULL LIMIT 5'
        : "SELECT id, number, issued_at FROM invoice WHERE number LIKE ? ESCAPE '\\' AND deleted_at IS NULL LIMIT 8",
      [pattern],
    );
    hits.push(
      ...invoices.map((row) => ({
        kind: 'INVOICE' as const,
        id: row.id,
        title: `Facture ${row.number}`,
        subtitle: row.issued_at.slice(0, 10),
        exact: exactOnly,
      })),
    );

    const transfers = await this.db.select<{ id: string; number: string; status: string }>(
      exactOnly
        ? 'SELECT id, number, status FROM transfer WHERE number = ? AND deleted_at IS NULL LIMIT 5'
        : "SELECT id, number, status FROM transfer WHERE number LIKE ? ESCAPE '\\' AND deleted_at IS NULL LIMIT 8",
      [pattern],
    );
    hits.push(
      ...transfers.map((row) => ({
        kind: 'TRANSFER' as const,
        id: row.id,
        title: `Transfert ${row.number}`,
        subtitle: row.status,
        exact: exactOnly,
      })),
    );

    const purchases = await this.db.select<{ id: string; number: string; status: string }>(
      exactOnly
        ? 'SELECT id, number, status FROM purchase WHERE number = ? AND deleted_at IS NULL LIMIT 5'
        : "SELECT id, number, status FROM purchase WHERE number LIKE ? ESCAPE '\\' AND deleted_at IS NULL LIMIT 8",
      [pattern],
    );
    hits.push(
      ...purchases.map((row) => ({
        kind: 'PURCHASE' as const,
        id: row.id,
        title: `Achat ${row.number}`,
        subtitle: row.status,
        exact: exactOnly,
      })),
    );

    return hits;
  }
}
