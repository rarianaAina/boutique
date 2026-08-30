import { dayRange, localDay, periodRange, startOfMonth } from '@boutique/shared';
import type { Money } from '@boutique/shared';
import type { SqlExecutor } from '../db/client';

/**
 * Rapports et tableau de bord (§22, §25).
 *
 * Toutes les agrégations sont faites par SQLite, jamais en JavaScript : le
 * cahier des charges prévoit des centaines de milliers de mouvements (§31), et
 * charger une année de ventes pour en faire la somme ferait tomber
 * l'application bien avant.
 *
 * La MARGE est calculée à partir du coût FIGÉ sur la ligne de vente, pas du
 * prix d'achat courant du produit : c'est la seule façon d'obtenir une marge
 * historique qui ne change pas quand un fournisseur augmente ses tarifs.
 */

export interface Period {
  from: string;
  to: string;
}

export interface DashboardFigures {
  revenueToday: Money;
  revenueMonth: Money;
  salesToday: number;
  marginToday: Money;
  marginMonth: Money;
  refundsToday: Money;
  averageBasket: Money;
  stockUnits: number;
  stockValue: Money;
  lowStockCount: number;
  pendingTransfersIn: number;
  pendingTransfersOut: number;
  pendingSyncEvents: number;
  syncConflicts: number;
}

export interface SalesReportRow {
  day: string;
  sales: number;
  revenue: Money;
  margin: Money;
  discount: Money;
}

export interface TransferSummaryRow {
  direction: 'ENVOI' | 'RECEPTION';
  status: string;
  transfers: number;
  items: number;
}

export interface TopProductRow {
  productId: string;
  name: string;
  sku: string;
  quantity: number;
  revenue: Money;
  margin: Money;
}

export class ReportService {
  constructor(
    private readonly db: SqlExecutor,
    private readonly shopId: string,
  ) {}

  /** Période « aujourd'hui », en bornes UTC du jour civil local. */
  static today(): Period {
    return dayRange(localDay());
  }

  static thisMonth(): Period {
    return periodRange(startOfMonth(), localDay());
  }

  /**
   * Chiffres du tableau de bord.
   *
   * Une seule méthode plutôt que dix appels séparés : l'écran d'accueil doit
   * s'afficher d'un coup, pas se remplir case par case.
   */
  async dashboard(lowStockFallback = 3): Promise<DashboardFigures> {
    const today = ReportService.today();
    const month = ReportService.thisMonth();

    const [todayFigures, monthFigures, refunds, stock, lowStock, transfers, sync] =
      await Promise.all([
        this.salesTotals(today),
        this.salesTotals(month),
        this.refundTotal(today),
        this.stockValue(),
        this.lowStockCount(lowStockFallback),
        this.pendingTransfers(),
        this.syncCounts(),
      ]);

    return {
      revenueToday: todayFigures.revenue,
      revenueMonth: monthFigures.revenue,
      salesToday: todayFigures.count,
      marginToday: todayFigures.margin,
      marginMonth: monthFigures.margin,
      refundsToday: refunds,
      averageBasket:
        todayFigures.count > 0 ? Math.round(todayFigures.revenue / todayFigures.count) : 0,
      stockUnits: stock.units,
      stockValue: stock.value,
      lowStockCount: lowStock,
      pendingTransfersIn: transfers.incoming,
      pendingTransfersOut: transfers.outgoing,
      pendingSyncEvents: sync.pending,
      syncConflicts: sync.conflicts,
    };
  }

  /**
   * Chiffre d'affaires et marge d'une période.
   *
   * Les ventes annulées sont exclues ; les remboursements sont comptés à part,
   * jamais soustraits ici — mélanger les deux ferait disparaître de la vue une
   * journée où l'on aurait beaucoup vendu ET beaucoup remboursé.
   */
  async salesTotals(
    period: Period,
  ): Promise<{ count: number; revenue: Money; margin: Money; discount: Money }> {
    const rows = await this.db.select<{
      count: number;
      revenue: number;
      cost: number;
      discount: number;
    }>(
      `SELECT COUNT(DISTINCT s.id) AS count,
              COALESCE(SUM(l.line_total), 0) AS revenue,
              COALESCE(SUM(l.unit_cost * l.quantity), 0) AS cost,
              COALESCE(SUM(l.discount), 0) AS discount
       FROM sale s
       JOIN sale_line l ON l.sale_id = s.id
       WHERE s.shop_id = ? AND s.deleted_at IS NULL AND s.status <> 'CANCELLED'
         AND s.sold_at >= ? AND s.sold_at < ?`,
      [this.shopId, period.from, period.to],
    );
    const row = rows[0];
    return {
      count: row?.count ?? 0,
      revenue: row?.revenue ?? 0,
      margin: (row?.revenue ?? 0) - (row?.cost ?? 0),
      discount: row?.discount ?? 0,
    };
  }

  /** Ventes agrégées par jour : la courbe du rapport de ventes. */
  async salesByDay(period: Period, sellerId?: string | null): Promise<SalesReportRow[]> {
    const conditions = [
      's.shop_id = ?',
      's.deleted_at IS NULL',
      "s.status <> 'CANCELLED'",
      's.sold_at >= ?',
      's.sold_at < ?',
    ];
    const params: unknown[] = [this.shopId, period.from, period.to];
    if (sellerId) {
      conditions.push('s.user_id = ?');
      params.push(sellerId);
    }

    const rows = await this.db.select<{
      day: string;
      sales: number;
      revenue: number;
      cost: number;
      discount: number;
    }>(
      `SELECT substr(s.sold_at, 1, 10) AS day,
              COUNT(DISTINCT s.id) AS sales,
              COALESCE(SUM(l.line_total), 0) AS revenue,
              COALESCE(SUM(l.unit_cost * l.quantity), 0) AS cost,
              COALESCE(SUM(l.discount), 0) AS discount
       FROM sale s JOIN sale_line l ON l.sale_id = s.id
       WHERE ${conditions.join(' AND ')}
       GROUP BY day ORDER BY day`,
      params,
    );
    return rows.map((row) => ({
      day: row.day,
      sales: row.sales,
      revenue: row.revenue,
      margin: row.revenue - row.cost,
      discount: row.discount,
    }));
  }

  /** Produits les plus vendus d'une période. */
  async topProducts(period: Period, limit = 20): Promise<TopProductRow[]> {
    const rows = await this.db.select<{
      product_id: string;
      name: string;
      sku: string;
      quantity: number;
      revenue: number;
      cost: number;
    }>(
      `SELECT l.product_id, p.name, p.sku,
              SUM(l.quantity) AS quantity,
              SUM(l.line_total) AS revenue,
              SUM(l.unit_cost * l.quantity) AS cost
       FROM sale_line l
       JOIN sale s ON s.id = l.sale_id
       JOIN product p ON p.id = l.product_id
       WHERE s.shop_id = ? AND s.deleted_at IS NULL AND s.status <> 'CANCELLED'
         AND s.sold_at >= ? AND s.sold_at < ?
       GROUP BY l.product_id
       ORDER BY revenue DESC
       LIMIT ?`,
      [this.shopId, period.from, period.to, limit],
    );
    return rows.map((row) => ({
      productId: row.product_id,
      name: row.name,
      sku: row.sku,
      quantity: row.quantity,
      revenue: row.revenue,
      margin: row.revenue - row.cost,
    }));
  }

  /** Ventes par vendeur : le rapport que réclame tout gérant. */
  async salesBySeller(
    period: Period,
  ): Promise<{ userId: string; name: string; sales: number; revenue: Money }[]> {
    const rows = await this.db.select<{
      user_id: string;
      name: string;
      sales: number;
      revenue: number;
    }>(
      `SELECT s.user_id, u.full_name AS name, COUNT(*) AS sales, COALESCE(SUM(s.total), 0) AS revenue
       FROM sale s JOIN app_user u ON u.id = s.user_id
       WHERE s.shop_id = ? AND s.deleted_at IS NULL AND s.status <> 'CANCELLED'
         AND s.sold_at >= ? AND s.sold_at < ?
       GROUP BY s.user_id ORDER BY revenue DESC`,
      [this.shopId, period.from, period.to],
    );
    return rows.map((row) => ({
      userId: row.user_id,
      name: row.name,
      sales: row.sales,
      revenue: row.revenue,
    }));
  }

  /** Répartition des encaissements par mode de paiement. */
  async paymentBreakdown(
    period: Period,
  ): Promise<{ method: string; label: string; amount: Money }[]> {
    return this.db.select<{ method: string; label: string; amount: number }>(
      `SELECT p.method, m.label, COALESCE(SUM(p.amount), 0) AS amount
       FROM sale_payment p
       JOIN sale s ON s.id = p.sale_id
       JOIN payment_method m ON m.code = p.method
       WHERE s.shop_id = ? AND s.deleted_at IS NULL AND s.status <> 'CANCELLED'
         AND p.paid_at >= ? AND p.paid_at < ?
       GROUP BY p.method ORDER BY amount DESC`,
      [this.shopId, period.from, period.to],
    );
  }

  async refundTotal(period: Period): Promise<Money> {
    const rows = await this.db.select<{ total: number }>(
      `SELECT COALESCE(SUM(total), 0) AS total FROM refund
       WHERE shop_id = ? AND status = 'COMPLETED' AND refunded_at >= ? AND refunded_at < ?`,
      [this.shopId, period.from, period.to],
    );
    return rows[0]?.total ?? 0;
  }

  async purchaseTotals(period: Period): Promise<{ count: number; total: Money; landed: Money }> {
    const rows = await this.db.select<{ count: number; total: number; landed: number }>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS total,
              COALESCE(SUM(landed_cost_total), 0) AS landed
       FROM purchase
       WHERE shop_id = ? AND deleted_at IS NULL AND status <> 'CANCELLED'
         AND COALESCE(ordered_at, created_at) >= ? AND COALESCE(ordered_at, created_at) < ?`,
      [this.shopId, period.from, period.to],
    );
    const row = rows[0];
    return { count: row?.count ?? 0, total: row?.total ?? 0, landed: row?.landed ?? 0 };
  }

  /** Mouvements agrégés par type : le rapport de mouvements de stock. */
  async movementsByType(
    period: Period,
  ): Promise<{ type: string; entries: number; quantity: number }[]> {
    return this.db.select<{ type: string; entries: number; quantity: number }>(
      `SELECT type, COUNT(*) AS entries, COALESCE(SUM(quantity), 0) AS quantity
       FROM stock_movement
       WHERE shop_id = ? AND occurred_at >= ? AND occurred_at < ?
       GROUP BY type ORDER BY entries DESC`,
      [this.shopId, period.from, period.to],
    );
  }

  /**
   * Transferts de la période, vus des deux côtés.
   *
   * Une boutique a besoin de savoir ce qu'elle a envoyé ET ce qu'elle a reçu :
   * ne compter qu'un sens donnerait un solde de mouvements incompréhensible.
   */
  async transferSummary(period: Period): Promise<TransferSummaryRow[]> {
    const rows = await this.db.select<TransferSummaryRow>(
      `SELECT CASE WHEN t.from_shop_id = ? THEN 'ENVOI' ELSE 'RECEPTION' END AS direction,
              t.status,
              COUNT(DISTINCT t.id) AS transfers,
              COALESCE(SUM(l.quantity), 0) AS items
       FROM transfer t
       LEFT JOIN transfer_line l ON l.transfer_id = t.id
       WHERE t.deleted_at IS NULL
         AND (t.from_shop_id = ? OR t.to_shop_id = ?)
         AND t.requested_at >= ? AND t.requested_at < ?
       GROUP BY direction, t.status
       ORDER BY direction, t.status`,
      [this.shopId, this.shopId, this.shopId, period.from, period.to],
    );
    return rows;
  }

  async exchangeCount(period: Period): Promise<number> {
    const rows = await this.db.select<{ total: number }>(
      `SELECT COUNT(*) AS total FROM exchange
       WHERE shop_id = ? AND deleted_at IS NULL AND exchanged_at >= ? AND exchanged_at < ?`,
      [this.shopId, period.from, period.to],
    );
    return rows[0]?.total ?? 0;
  }

  async stockValue(): Promise<{ units: number; value: Money }> {
    const units = await this.db.select<{ total: number; value: number }>(
      `SELECT COUNT(*) AS total, COALESCE(SUM(cost_price), 0) AS value
       FROM product_unit
       WHERE shop_id = ? AND deleted_at IS NULL AND status IN ('IN_STOCK', 'RESERVED', 'RETURNED')`,
      [this.shopId],
    );
    const quantities = await this.db.select<{ total: number; value: number }>(
      `SELECT COALESCE(SUM(sl.quantity), 0) AS total,
              COALESCE(SUM(sl.quantity * p.purchase_price), 0) AS value
       FROM stock_level sl JOIN product p ON p.id = sl.product_id
       WHERE sl.shop_id = ? AND sl.quantity > 0 AND p.deleted_at IS NULL`,
      [this.shopId],
    );
    return {
      units: (units[0]?.total ?? 0) + (quantities[0]?.total ?? 0),
      value: (units[0]?.value ?? 0) + (quantities[0]?.value ?? 0),
    };
  }

  /**
   * Produits sous leur seuil d'alerte.
   *
   * Le seuil du produit l'emporte sur le seuil général : un iPhone à une pièce
   * n'a pas le même seuil qu'un câble à cent.
   */
  async lowStockCount(fallback = 3): Promise<number> {
    const rows = await this.db.select<{ total: number }>(
      `SELECT COUNT(*) AS total FROM product p
       WHERE p.deleted_at IS NULL AND p.status = 'ACTIVE'
         AND (CASE WHEN p.tracking = 'QUANTITY'
                THEN COALESCE((SELECT quantity FROM stock_level
                               WHERE product_id = p.id AND shop_id = ?), 0)
                ELSE (SELECT COUNT(*) FROM product_unit u
                      WHERE u.product_id = p.id AND u.shop_id = ? AND u.deleted_at IS NULL
                        AND u.status IN ('IN_STOCK', 'RETURNED'))
              END) <= CASE WHEN p.min_stock > 0 THEN p.min_stock ELSE ? END`,
      [this.shopId, this.shopId, fallback],
    );
    return rows[0]?.total ?? 0;
  }

  private async pendingTransfers(): Promise<{ incoming: number; outgoing: number }> {
    const rows = await this.db.select<{ incoming: number; outgoing: number }>(
      `SELECT
         SUM(CASE WHEN to_shop_id = ? AND status IN ('REQUESTED','APPROVED','SHIPPED','IN_TRANSIT')
                  THEN 1 ELSE 0 END) AS incoming,
         SUM(CASE WHEN from_shop_id = ? AND status IN ('REQUESTED','APPROVED','SHIPPED','IN_TRANSIT')
                  THEN 1 ELSE 0 END) AS outgoing
       FROM transfer WHERE deleted_at IS NULL`,
      [this.shopId, this.shopId],
    );
    return { incoming: rows[0]?.incoming ?? 0, outgoing: rows[0]?.outgoing ?? 0 };
  }

  private async syncCounts(): Promise<{ pending: number; conflicts: number }> {
    const rows = await this.db.select<{ pending: number; conflicts: number }>(
      `SELECT
         SUM(CASE WHEN status IN ('PENDING', 'FAILED') THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'CONFLICT' THEN 1 ELSE 0 END) AS conflicts
       FROM sync_outbox`,
    );
    return { pending: rows[0]?.pending ?? 0, conflicts: rows[0]?.conflicts ?? 0 };
  }
}
