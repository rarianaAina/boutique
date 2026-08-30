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
   * Lots d'approvisionnement d'un produit.
   *
   * C'est la vue que réclame un gérant qui réapprovisionne au fil des cours :
   * « le lot de lundi m'a coûté 12 000 et je l'ai vendu 15 000 ; celui de
   * jeudi m'a coûté 13 000 et je l'ai vendu 16 000 ». Un simple historique de
   * prix ne le dit pas — il faut relier le COÛT d'une entrée à la QUANTITÉ
   * qu'elle a apportée, à ce qu'il en reste, et au prix de vente en vigueur à
   * ce moment-là.
   *
   * Les deux modèles de stock sont réunis dans la même vue : un lot d'appareils
   * identifiés se compte en unités, un lot de produits par quantité se compte
   * en mouvements d'entrée. Un gérant ne veut pas savoir lequel des deux il
   * consulte, il veut voir ses arrivages.
   */
  async lotsOf(
    productId: string,
    shopId: string,
  ): Promise<
    {
      at: IsoDate;
      unitCost: Money;
      received: number;
      remaining: number;
      supplierName: string | null;
      sourceLabel: string | null;
      /** Prix de vente en vigueur à la date du lot, si l'historique le sait. */
      salePriceThen: Money | null;
    }[]
  > {
    const unites = await this.db.select<{
      at: string;
      unit_cost: number;
      received: number;
      remaining: number;
      supplier_name: string | null;
      source_label: string | null;
    }>(
      `SELECT substr(COALESCE(u.received_at, u.created_at), 1, 10) AS at,
              u.cost_price AS unit_cost,
              COUNT(*) AS received,
              SUM(CASE WHEN u.status IN ('IN_STOCK','RESERVED','RETURNED') THEN 1 ELSE 0 END)
                AS remaining,
              s.name AS supplier_name,
              p.number AS source_label
       FROM product_unit u
       LEFT JOIN supplier s ON s.id = u.supplier_id
       LEFT JOIN purchase p ON p.id = u.purchase_id
       WHERE u.product_id = ? AND u.shop_id = ? AND u.deleted_at IS NULL
       GROUP BY at, u.cost_price, u.supplier_id, u.purchase_id
       ORDER BY at DESC`,
      [productId, shopId],
    );

    const quantites = await this.db.select<{
      at: string;
      unit_cost: number;
      received: number;
      supplier_name: string | null;
      source_label: string | null;
    }>(
      `SELECT substr(m.occurred_at, 1, 10) AS at,
              COALESCE(m.unit_cost, 0) AS unit_cost,
              SUM(m.quantity) AS received,
              s.name AS supplier_name,
              m.source_label
       FROM stock_movement m
       LEFT JOIN purchase p ON p.id = m.source_id AND m.source = 'PURCHASE'
       LEFT JOIN supplier s ON s.id = p.supplier_id
       WHERE m.product_id = ? AND m.shop_id = ? AND m.unit_id IS NULL AND m.quantity > 0
       GROUP BY at, m.unit_cost, m.source_label
       ORDER BY at DESC`,
      [productId, shopId],
    );

    const ventes = await this.db.select<{ at: string; new_value: number }>(
      `SELECT at, new_value FROM price_history
       WHERE product_id = ? AND kind = 'SALE' ORDER BY at`,
      [productId],
    );

    /**
     * Prix de vente en vigueur à une date : le dernier fixé AVANT elle.
     *
     * Quand aucun point ne la précède, on retient le PREMIER connu plutôt que
     * rien. Le cas se présente pour les lots antérieurs à l'historique — un
     * stock déjà en rayon quand le logiciel a été installé. Le premier prix
     * enregistré est celui du produit à sa création : c'est l'approximation la
     * plus proche, et infiniment plus utile qu'une case vide.
     *
     * Sans aucun point, on renvoie `null` : inventer un prix produirait une
     * marge fausse, ce qui est pire que de ne rien afficher.
     */
    const prixAlors = (jour: string): Money | null => {
      let valeur: number | null = null;
      for (const point of ventes) {
        if (point.at.slice(0, 10) <= jour) valeur = point.new_value;
        else break;
      }
      return valeur ?? ventes[0]?.new_value ?? null;
    };

    const lots = [
      ...unites.map((ligne) => ({
        at: ligne.at,
        unitCost: ligne.unit_cost,
        received: ligne.received,
        remaining: ligne.remaining,
        supplierName: ligne.supplier_name,
        sourceLabel: ligne.source_label,
        salePriceThen: prixAlors(ligne.at),
      })),
      ...quantites.map((ligne) => ({
        at: ligne.at,
        unitCost: ligne.unit_cost,
        received: ligne.received,
        // Un produit par quantité n'a pas d'exemplaire à suivre : ce qui reste
        // d'un lot précis n'est pas connaissable ligne à ligne.
        remaining: -1,
        supplierName: ligne.supplier_name,
        sourceLabel: ligne.source_label,
        salePriceThen: prixAlors(ligne.at),
      })),
    ];

    return lots.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
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
