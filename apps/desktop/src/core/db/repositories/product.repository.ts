import { buildSearchKey, escapeLike, newId, nowIso, searchTerms } from '@boutique/shared';
import type { Money, Product, ProductStatus, Tracking } from '@boutique/shared';
import { parseJson, toJson, toNumber } from '../rows';
import { chunk, placeholders } from '../chunk';
import type { SqlExecutor } from '../client';

/**
 * Catalogue produits.
 *
 * Un produit est le MODÈLE (« iPhone 15 128 Go noir ») ; l'exemplaire vendu est
 * une `ProductUnit`. Cette séparation est ce qui permet de savoir lequel de deux
 * téléphones identiques est parti chez quel client.
 *
 * PERFORMANCE (§31) : aucune méthode ne charge le catalogue entier. Les listes
 * sont paginées et la recherche s'appuie sur `search_key`, une colonne
 * précalculée et indexée — un LIKE sur `name` ferait un balayage complet à
 * chaque frappe, ce qui se sent dès quelques milliers de produits.
 */

interface ProductRow {
  id: string;
  sku: string;
  reference: string | null;
  barcode: string | null;
  name: string;
  brand: string | null;
  model: string | null;
  category_id: string | null;
  description: string | null;
  tracking: Tracking;
  purchase_price: number;
  sale_price: number;
  min_price: number | null;
  tax_rate: number | null;
  default_supplier_id: string | null;
  unit: string;
  min_stock: number;
  photo_path: string | null;
  status: ProductStatus;
  attributes: string;
  color: string | null;
  capacity: string | null;
  variant_group: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const toProduct = (row: ProductRow): Product => ({
  id: row.id,
  sku: row.sku,
  reference: row.reference,
  barcode: row.barcode,
  name: row.name,
  brand: row.brand,
  model: row.model,
  categoryId: row.category_id,
  description: row.description,
  tracking: row.tracking,
  purchasePrice: row.purchase_price,
  salePrice: row.sale_price,
  minPrice: row.min_price,
  taxRate: row.tax_rate,
  defaultSupplierId: row.default_supplier_id,
  unit: row.unit,
  minStock: row.min_stock,
  photoPath: row.photo_path,
  status: row.status,
  attributes: parseJson<Record<string, string>>(row.attributes, {}),
  color: row.color,
  capacity: row.capacity,
  variantGroup: row.variant_group,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
});

export interface ProductInput {
  /**
   * Référence interne. FACULTATIVE : `ProductService` en dérive une du modèle
   * quand elle manque. Le dépôt, lui, reçoit toujours une valeur — la colonne
   * est NOT NULL et porte un index unique.
   */
  sku?: string;
  name: string;
  reference?: string | null;
  barcode?: string | null;
  brand?: string | null;
  model?: string | null;
  categoryId?: string | null;
  description?: string | null;
  tracking: Tracking;
  purchasePrice: Money;
  salePrice: Money;
  minPrice?: Money | null;
  taxRate?: number | null;
  defaultSupplierId?: string | null;
  unit?: string;
  minStock?: number;
  photoPath?: string | null;
  status?: ProductStatus;
  attributes?: Record<string, string>;
  /** Axes de variation d'un modèle : « Rouge », « 256 Go ». */
  color?: string | null;
  capacity?: string | null;
  /** Clé de regroupement, calculée par le service. */
  variantGroup?: string | null;
}

/** Produit accompagné de son stock dans une boutique donnée. */
export interface ProductWithStock extends Product {
  /** Unités disponibles (IMEI/série) ou quantité en stock (non sérialisé). */
  available: number;
  /** Total détenu, statuts non disponibles compris. */
  onHand: number;
  /** Nombre de déclinaisons du même modèle, celle-ci comprise. */
  variantCount?: number;
}

export interface ProductQuery {
  shopId: string;
  query?: string;
  categoryId?: string | null;
  brand?: string | null;
  tracking?: Tracking | null;
  status?: ProductStatus | null;
  /** N'afficher que ce qui est sous le seuil d'alerte. */
  lowStockOnly?: boolean;
  lowStockFallback?: number;
  limit?: number;
  offset?: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

const searchKeyOf = (input: ProductInput): string =>
  buildSearchKey(
    input.name,
    input.sku,
    input.reference,
    input.barcode,
    input.brand,
    input.model,
    input.color,
    input.capacity,
    ...Object.values(input.attributes ?? {}),
  );

/**
 * Expression du stock disponible, réutilisée par la liste et par le comptage.
 *
 * Elle traite les deux modèles en une seule requête : les produits suivis à
 * l'unité comptent leurs unités disponibles, les autres lisent `stock_level`.
 * Écrite une fois ici, elle ne peut pas diverger entre l'écran et le total.
 */
const AVAILABLE_SQL = `
  CASE WHEN p.tracking = 'QUANTITY'
    THEN COALESCE((SELECT sl.quantity - sl.reserved FROM stock_level sl
                   WHERE sl.product_id = p.id AND sl.shop_id = ?), 0)
    ELSE (SELECT COUNT(*) FROM product_unit u
          WHERE u.product_id = p.id AND u.shop_id = ? AND u.deleted_at IS NULL
            AND u.status IN ('IN_STOCK', 'RETURNED'))
  END`;

const ON_HAND_SQL = `
  CASE WHEN p.tracking = 'QUANTITY'
    THEN COALESCE((SELECT sl.quantity FROM stock_level sl
                   WHERE sl.product_id = p.id AND sl.shop_id = ?), 0)
    ELSE (SELECT COUNT(*) FROM product_unit u
          WHERE u.product_id = p.id AND u.shop_id = ? AND u.deleted_at IS NULL
            AND u.status IN ('IN_STOCK', 'RESERVED', 'RETURNED'))
  END`;

export class ProductRepository {
  constructor(private readonly db: SqlExecutor) {}

  async byId(id: string): Promise<Product | null> {
    const rows = await this.db.select<ProductRow>('SELECT * FROM product WHERE id = ?', [id]);
    return rows[0] ? toProduct(rows[0]) : null;
  }

  async bySku(sku: string): Promise<Product | null> {
    const rows = await this.db.select<ProductRow>(
      'SELECT * FROM product WHERE sku = ? AND deleted_at IS NULL',
      [sku],
    );
    return rows[0] ? toProduct(rows[0]) : null;
  }

  async byBarcode(barcode: string): Promise<Product | null> {
    const rows = await this.db.select<ProductRow>(
      'SELECT * FROM product WHERE barcode = ? AND deleted_at IS NULL LIMIT 1',
      [barcode],
    );
    return rows[0] ? toProduct(rows[0]) : null;
  }

  /** Lecture groupée, par lots : utilisée par le POS et les rapports. */
  async byIds(ids: readonly string[]): Promise<Map<string, Product>> {
    const result = new Map<string, Product>();
    for (const batch of chunk(ids)) {
      const rows = await this.db.select<ProductRow>(
        `SELECT * FROM product WHERE id IN (${placeholders(batch.length)})`,
        [...batch],
      );
      for (const row of rows) result.set(row.id, toProduct(row));
    }
    return result;
  }

  /**
   * Liste paginée, avec le stock de la boutique.
   *
   * Le total est compté par une requête séparée qui reprend exactement les
   * mêmes conditions : afficher « 1-50 sur 12 843 » sans charger 12 843 lignes.
   */
  async search(query: ProductQuery): Promise<Page<ProductWithStock>> {
    const limit = Math.min(query.limit ?? 50, 500);
    const offset = Math.max(0, query.offset ?? 0);

    const conditions = ['p.deleted_at IS NULL'];
    const filters: unknown[] = [];

    if (query.status) {
      conditions.push('p.status = ?');
      filters.push(query.status);
    } else {
      conditions.push("p.status <> 'ARCHIVED'");
    }
    if (query.categoryId) {
      conditions.push('p.category_id = ?');
      filters.push(query.categoryId);
    }
    if (query.brand) {
      conditions.push('p.brand = ?');
      filters.push(query.brand);
    }
    if (query.tracking) {
      conditions.push('p.tracking = ?');
      filters.push(query.tracking);
    }
    for (const term of searchTerms(query.query ?? '')) {
      conditions.push("p.search_key LIKE ? ESCAPE '\\'");
      filters.push(`%${escapeLike(term)}%`);
    }

    const where = conditions.join(' AND ');
    // L'ordre des paramètres suit celui des `?` dans le SQL : d'abord les deux
    // de l'expression de disponibilité, puis les filtres.
    const stockParams = [query.shopId, query.shopId];

    const havingLow = query.lowStockOnly
      ? `AND (${AVAILABLE_SQL}) <= CASE WHEN p.min_stock > 0 THEN p.min_stock ELSE ? END`
      : '';
    const lowParams = query.lowStockOnly
      ? [...stockParams, query.lowStockFallback ?? 3]
      : ([] as unknown[]);

    const items = await this.db.select<
      ProductRow & { available: number; on_hand: number; variant_count: number }
    >(
      `SELECT p.*, (${AVAILABLE_SQL}) AS available, (${ON_HAND_SQL}) AS on_hand,
              (SELECT COUNT(*) FROM product v
               WHERE v.variant_group = p.variant_group AND v.deleted_at IS NULL
                 AND v.status <> 'ARCHIVED') AS variant_count
       FROM product p
       WHERE ${where} ${havingLow}
       ORDER BY p.name, p.capacity, p.color
       LIMIT ? OFFSET ?`,
      [...stockParams, ...stockParams, ...filters, ...lowParams, limit, offset],
    );

    const totals = await this.db.select<{ total: number }>(
      `SELECT COUNT(*) AS total FROM product p WHERE ${where} ${havingLow}`,
      [...filters, ...lowParams],
    );

    return {
      items: items.map((row) => ({
        ...toProduct(row),
        available: toNumber(row.available),
        onHand: toNumber(row.on_hand),
        variantCount: toNumber(row.variant_count, 1),
      })),
      total: totals[0]?.total ?? 0,
      offset,
      limit,
    };
  }

  /**
   * Déclinaisons d'un modèle, avec leur disponibilité.
   *
   * C'est ce que le comptoir affiche après avoir choisi « iPhone 17 Pro Max » :
   * les couleurs et les capacités réellement en stock, et celles qui manquent.
   * On montre AUSSI les variantes à zéro — un vendeur doit pouvoir répondre
   * « le rouge, je ne l'ai plus » plutôt que de laisser croire qu'il n'existe
   * pas.
   */
  async variantsOf(variantGroup: string, shopId: string): Promise<ProductWithStock[]> {
    const rows = await this.db.select<ProductRow & { available: number; on_hand: number }>(
      `SELECT p.*, (${AVAILABLE_SQL}) AS available, (${ON_HAND_SQL}) AS on_hand
       FROM product p
       WHERE p.variant_group = ? AND p.deleted_at IS NULL AND p.status <> 'ARCHIVED'
       ORDER BY p.capacity, p.color, p.name`,
      [shopId, shopId, shopId, shopId, variantGroup],
    );
    return rows.map((row) => ({
      ...toProduct(row),
      available: toNumber(row.available),
      onHand: toNumber(row.on_hand),
    }));
  }

  /** Marques présentes au catalogue, pour alimenter un filtre. */
  async brands(): Promise<string[]> {
    const rows = await this.db.select<{ brand: string }>(
      `SELECT DISTINCT brand FROM product
       WHERE brand IS NOT NULL AND brand <> '' AND deleted_at IS NULL
       ORDER BY brand`,
    );
    return rows.map((row) => row.brand);
  }

  async create(input: ProductInput & { sku: string }, id = newId()): Promise<string> {
    const at = nowIso();
    await this.db.execute(
      `INSERT INTO product (id, sku, reference, barcode, name, brand, model, category_id,
                            description, tracking, purchase_price, sale_price, min_price, tax_rate,
                            default_supplier_id, unit, min_stock, photo_path, status, attributes,
                            color, capacity, variant_group, search_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.sku,
        input.reference ?? null,
        input.barcode ?? null,
        input.name,
        input.brand ?? null,
        input.model ?? null,
        input.categoryId ?? null,
        input.description ?? null,
        input.tracking,
        input.purchasePrice,
        input.salePrice,
        input.minPrice ?? null,
        input.taxRate ?? null,
        input.defaultSupplierId ?? null,
        input.unit ?? 'pièce',
        input.minStock ?? 0,
        input.photoPath ?? null,
        input.status ?? 'ACTIVE',
        toJson(input.attributes ?? {}),
        input.color ?? null,
        input.capacity ?? null,
        input.variantGroup ?? null,
        searchKeyOf(input),
        at,
        at,
      ],
    );
    return id;
  }

  async update(id: string, input: ProductInput & { sku: string }): Promise<void> {
    await this.db.execute(
      `UPDATE product SET
         sku = ?, reference = ?, barcode = ?, name = ?, brand = ?, model = ?, category_id = ?,
         description = ?, tracking = ?, purchase_price = ?, sale_price = ?, min_price = ?,
         tax_rate = ?, default_supplier_id = ?, unit = ?, min_stock = ?, photo_path = ?,
         status = ?, attributes = ?, color = ?, capacity = ?, variant_group = ?,
         search_key = ?, updated_at = ?
       WHERE id = ?`,
      [
        input.sku,
        input.reference ?? null,
        input.barcode ?? null,
        input.name,
        input.brand ?? null,
        input.model ?? null,
        input.categoryId ?? null,
        input.description ?? null,
        input.tracking,
        input.purchasePrice,
        input.salePrice,
        input.minPrice ?? null,
        input.taxRate ?? null,
        input.defaultSupplierId ?? null,
        input.unit ?? 'pièce',
        input.minStock ?? 0,
        input.photoPath ?? null,
        input.status ?? 'ACTIVE',
        toJson(input.attributes ?? {}),
        input.color ?? null,
        input.capacity ?? null,
        input.variantGroup ?? null,
        searchKeyOf(input),
        nowIso(),
        id,
      ],
    );
  }

  /**
   * Suppression logique.
   *
   * Le produit reste référencé par des ventes et des mouvements : l'effacer
   * vraiment rendrait illisible tout l'historique qui le cite.
   */
  async softDelete(id: string): Promise<void> {
    const at = nowIso();
    await this.db.execute(
      `UPDATE product SET deleted_at = ?, status = 'ARCHIVED', updated_at = ? WHERE id = ?`,
      [at, at, id],
    );
  }

  /**
   * Reconstruit les clés de recherche manquantes.
   *
   * Utile après un import fait par une version antérieure : les produits
   * existent en base mais restent introuvables à l'écran, ce qui ressemble à
   * une perte de données alors que ce n'en est pas une.
   */
  async rebuildSearchKeys(): Promise<number> {
    const rows = await this.db.select<ProductRow>(
      "SELECT * FROM product WHERE search_key = '' OR search_key IS NULL",
    );
    if (rows.length === 0) return 0;
    await this.db.transaction(async (tx) => {
      for (const row of rows) {
        const product = toProduct(row);
        await tx.execute('UPDATE product SET search_key = ? WHERE id = ?', [
          buildSearchKey(
            product.name,
            product.sku,
            product.reference,
            product.barcode,
            product.brand,
            product.model,
            ...Object.values(product.attributes),
          ),
          product.id,
        ]);
      }
    });
    return rows.length;
  }
}
