import { newSortableId, nowIso } from '@boutique/shared';
import type { IsoDate, Money } from '@boutique/shared';
import type { SqlExecutor } from '../client';

/**
 * Historique des prix.
 *
 * Il répond à une question que se pose tout gérant dont les fournisseurs
 * bougent : « combien ce téléphone me coûtait-il il y a trois mois, et
 * combien me coûte-t-il aujourd'hui ? »
 *
 * DEUX NATURES D'INFORMATION, séparées par `kind` :
 *
 *  - le prix CATALOGUE (`PURCHASE`, `SALE`, `MIN`) est une décision — quelqu'un
 *    l'a saisie ou un import l'a modifiée ;
 *  - le prix CONSTATÉ (`OBSERVED_PURCHASE`) est un fait : ce que le fournisseur
 *    a réellement facturé sur une ligne d'achat, frais logistiques compris.
 *
 * Les mélanger donnerait une courbe où l'on ne saurait plus distinguer ce
 * qu'on a décidé de ce qu'on a subi.
 */

export type PriceKind = 'PURCHASE' | 'SALE' | 'MIN' | 'OBSERVED_PURCHASE';
export type PriceSource = 'MANUAL' | 'IMPORT' | 'PURCHASE' | 'SYNC';

export interface PricePoint {
  id: string;
  productId: string;
  kind: PriceKind;
  oldValue: Money | null;
  newValue: Money;
  source: PriceSource;
  sourceId: string | null;
  sourceLabel: string | null;
  supplierId: string | null;
  supplierName: string | null;
  userLabel: string | null;
  note: string | null;
  at: IsoDate;
}

export interface PricePointInput {
  productId: string;
  kind: PriceKind;
  oldValue?: Money | null;
  newValue: Money;
  source: PriceSource;
  sourceId?: string | null;
  sourceLabel?: string | null;
  supplierId?: string | null;
  shopId?: string | null;
  userId?: string | null;
  userLabel?: string | null;
  note?: string | null;
  at?: IsoDate;
}

interface PriceRow {
  id: string;
  product_id: string;
  kind: PriceKind;
  old_value: number | null;
  new_value: number;
  source: PriceSource;
  source_id: string | null;
  source_label: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  user_label: string | null;
  note: string | null;
  at: string;
}

const toPoint = (row: PriceRow): PricePoint => ({
  id: row.id,
  productId: row.product_id,
  kind: row.kind,
  oldValue: row.old_value,
  newValue: row.new_value,
  source: row.source,
  sourceId: row.source_id,
  sourceLabel: row.source_label,
  supplierId: row.supplier_id,
  supplierName: row.supplier_name,
  userLabel: row.user_label,
  note: row.note,
  at: row.at,
});

export class PriceHistoryRepository {
  constructor(private readonly db: SqlExecutor) {}

  /**
   * Consigne un point d'historique.
   *
   * L'identifiant est TRIÉ PAR DATE : deux changements tombant dans la même
   * milliseconde — un import qui modifie prix d'achat et prix de vente —
   * restent ordonnés, ce qu'un UUID aléatoire ne garantirait pas.
   */
  async record(input: PricePointInput): Promise<void> {
    // Un « changement » qui ne change rien n'a rien à faire dans un historique :
    // il le ferait grossir et noierait les vraies variations.
    if (
      input.oldValue !== null &&
      input.oldValue !== undefined &&
      input.oldValue === input.newValue
    ) {
      return;
    }

    await this.db.execute(
      `INSERT INTO price_history (id, product_id, kind, old_value, new_value, source, source_id,
                                  source_label, supplier_id, shop_id, user_id, user_label, note, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newSortableId(),
        input.productId,
        input.kind,
        input.oldValue ?? null,
        input.newValue,
        input.source,
        input.sourceId ?? null,
        input.sourceLabel ?? null,
        input.supplierId ?? null,
        input.shopId ?? null,
        input.userId ?? null,
        input.userLabel ?? null,
        input.note ?? null,
        input.at ?? nowIso(),
      ],
    );
  }

  /**
   * Historique complet d'un produit, du plus récent au plus ancien.
   *
   * L'ordre secondaire est le `rowid` — l'ordre d'insertion physique — et NON
   * l'identifiant : deux changements tombant dans la même milliseconde portent
   * le même horodatage, et le départage se ferait alors sur la part aléatoire
   * de la clé. Un prix modifié deux fois de suite apparaîtrait dans le
   * désordre, et la dernière valeur affichée serait fausse.
   */
  async forProduct(productId: string, kind?: PriceKind, limit = 200): Promise<PricePoint[]> {
    const rows = await this.db.select<PriceRow>(
      `SELECT h.*, s.name AS supplier_name
       FROM price_history h
       LEFT JOIN supplier s ON s.id = h.supplier_id
       WHERE h.product_id = ? ${kind ? 'AND h.kind = ?' : ''}
       ORDER BY h.at DESC, h.rowid DESC
       LIMIT ?`,
      kind ? [productId, kind, limit] : [productId, limit],
    );
    return rows.map(toPoint);
  }

  /**
   * Dernier prix RÉELLEMENT payé, par fournisseur.
   *
   * C'est le chiffre à comparer au prix catalogue avant de repasser commande :
   * si le fournisseur a augmenté de 12 % et que la fiche produit ne l'a pas
   * suivi, la marge affichée est fausse depuis la dernière livraison.
   */
  async lastObservedBySupplier(
    productId: string,
  ): Promise<
    { supplierId: string | null; supplierName: string | null; value: Money; at: IsoDate }[]
  > {
    const rows = await this.db.select<{
      supplier_id: string | null;
      supplier_name: string | null;
      new_value: number;
      at: string;
    }>(
      `SELECT h.supplier_id, s.name AS supplier_name, h.new_value, h.at
       FROM price_history h
       LEFT JOIN supplier s ON s.id = h.supplier_id
       WHERE h.product_id = ? AND h.kind = 'OBSERVED_PURCHASE'
         AND h.at = (
           SELECT MAX(i.at) FROM price_history i
           WHERE i.product_id = h.product_id AND i.kind = 'OBSERVED_PURCHASE'
             AND (i.supplier_id IS h.supplier_id)
         )
       ORDER BY h.at DESC`,
      [productId],
    );
    return rows.map((row) => ({
      supplierId: row.supplier_id,
      supplierName: row.supplier_name,
      value: row.new_value,
      at: row.at,
    }));
  }

  /**
   * Produits dont le coût réel s'est éloigné du prix catalogue.
   *
   * L'écart est ce qui doit alerter : un prix d'achat catalogue périmé fausse
   * la marge de chaque vente, en silence, jusqu'à ce que quelqu'un compare.
   */
  async divergences(
    seuilPourcent = 5,
    limit = 100,
  ): Promise<
    {
      productId: string;
      name: string;
      sku: string;
      cataloguePrice: Money;
      observedPrice: Money;
      supplierName: string | null;
      at: IsoDate;
      variationPercent: number;
    }[]
  > {
    const rows = await this.db.select<{
      product_id: string;
      name: string;
      sku: string;
      catalogue: number;
      observed: number;
      supplier_name: string | null;
      at: string;
    }>(
      `SELECT p.id AS product_id, p.name, p.sku, p.purchase_price AS catalogue,
              h.new_value AS observed, s.name AS supplier_name, h.at
       FROM product p
       JOIN price_history h ON h.product_id = p.id AND h.kind = 'OBSERVED_PURCHASE'
       LEFT JOIN supplier s ON s.id = h.supplier_id
       WHERE p.deleted_at IS NULL
         AND h.at = (SELECT MAX(i.at) FROM price_history i
                     WHERE i.product_id = p.id AND i.kind = 'OBSERVED_PURCHASE')
         AND p.purchase_price > 0
         AND ABS(h.new_value - p.purchase_price) * 100.0 / p.purchase_price >= ?
       ORDER BY ABS(h.new_value - p.purchase_price) * 1.0 / p.purchase_price DESC
       LIMIT ?`,
      [seuilPourcent, limit],
    );
    return rows.map((row) => ({
      productId: row.product_id,
      name: row.name,
      sku: row.sku,
      cataloguePrice: row.catalogue,
      observedPrice: row.observed,
      supplierName: row.supplier_name,
      at: row.at,
      variationPercent: Math.round(((row.observed - row.catalogue) / row.catalogue) * 1000) / 10,
    }));
  }
}
