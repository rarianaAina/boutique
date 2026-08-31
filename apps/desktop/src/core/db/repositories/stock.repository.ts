import { newId, nowIso } from '@boutique/shared';
import type { Money, MovementSource, MovementType, StockMovement } from '@boutique/shared';
import { chunk, placeholders } from '../chunk';
import type { SqlExecutor } from '../client';

/**
 * Stock et mouvements.
 *
 * RÈGLE ABSOLUE (§6) : aucune quantité ne bouge sans un mouvement. Les méthodes
 * de ce dépôt qui touchent `stock_level` écrivent TOUJOURS le mouvement dans la
 * même transaction — il n'existe pas d'API publique pour modifier une quantité
 * seule. C'est ce qui permet de recalculer un stock si un total venait à
 * diverger, et de répondre à « d'où vient cet appareil » un an plus tard.
 *
 * Les mouvements ne sont jamais modifiés ni supprimés : une correction s'écrit
 * en ajoutant un mouvement inverse.
 */

interface MovementRow {
  id: string;
  shop_id: string;
  product_id: string;
  unit_id: string | null;
  type: MovementType;
  quantity: number;
  unit_cost: number | null;
  source: MovementSource;
  source_id: string | null;
  source_label: string | null;
  user_id: string | null;
  occurred_at: string;
  note: string | null;
  created_at: string;
}

const toMovement = (row: MovementRow): StockMovement => ({
  id: row.id,
  shopId: row.shop_id,
  productId: row.product_id,
  unitId: row.unit_id,
  type: row.type,
  quantity: row.quantity,
  unitCost: row.unit_cost,
  source: row.source,
  sourceId: row.source_id,
  sourceLabel: row.source_label,
  userId: row.user_id,
  occurredAt: row.occurred_at,
  note: row.note,
  createdAt: row.created_at,
});

export interface MovementInput {
  shopId: string;
  productId: string;
  unitId?: string | null;
  type: MovementType;
  /** Signée : positive à l'entrée, négative à la sortie. */
  quantity: number;
  unitCost?: Money | null;
  source: MovementSource;
  sourceId?: string | null;
  sourceLabel?: string | null;
  userId?: string | null;
  occurredAt?: string;
  note?: string | null;
}

export interface MovementQuery {
  shopId?: string | null;
  productId?: string | null;
  unitId?: string | null;
  type?: MovementType | null;
  from?: string | null;
  to?: string | null;
  limit?: number;
  offset?: number;
}

export interface ArrivalQuery {
  shopId?: string | null;
  /** Origine : IMPORT, PURCHASE, TRANSFER, INVENTORY, MANUAL… */
  source?: string | null;
  from?: string | null;
  to?: string | null;
  limit?: number;
}

/** Une livraison, telle qu'on la retrouve dans l'historique. */
export interface ArrivalGroup {
  /** Jour local de l'arrivage, AAAA-MM-JJ. */
  day: string;
  source: string;
  sourceId: string | null;
  /** Numéro de document ou nom de fichier, recopié à l'entrée. */
  label: string | null;
  firstAt: string;
  lastAt: string;
  /** Nombre de produits DISTINCTS. */
  products: number;
  /** Nombre de pièces, toutes lignes confondues. */
  units: number;
  /** Parmi elles, celles suivies à l'unité — un IMEI, un numéro de série. */
  identified: number;
  /** Coût total de l'arrivage, quand il est connu. */
  cost: number;
  userLabel: string | null;
}

interface ArrivalRow {
  day: string;
  source: string;
  source_id: string;
  label: string | null;
  first_at: string;
  last_at: string;
  products: number;
  units: number;
  identified: number;
  cost: number;
  user_label: string | null;
}

/** Mouvement enrichi de quoi l'afficher sans jointure supplémentaire. */
export interface MovementListItem extends StockMovement {
  productName: string;
  productSku: string;
  identifier: string | null;
  userLabel: string | null;
}

export class StockRepository {
  constructor(private readonly db: SqlExecutor) {}

  /**
   * Enregistre un mouvement ET met à jour le stock du produit non sérialisé.
   *
   * Pour un produit suivi à l'unité, `stock_level` n'est pas touché : le stock
   * se compte alors en unités disponibles, et tenir un second compteur
   * ouvrirait la porte à une divergence entre les deux.
   */
  async record(input: MovementInput): Promise<string> {
    const id = newId();
    const at = nowIso();
    const occurredAt = input.occurredAt ?? at;

    await this.db.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO stock_movement (id, shop_id, product_id, unit_id, type, quantity, unit_cost,
                                     source, source_id, source_label, user_id, occurred_at, note,
                                     created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.shopId,
          input.productId,
          input.unitId ?? null,
          input.type,
          input.quantity,
          input.unitCost ?? null,
          input.source,
          input.sourceId ?? null,
          input.sourceLabel ?? null,
          input.userId ?? null,
          occurredAt,
          input.note ?? null,
          at,
        ],
      );

      if (!input.unitId) {
        await applyLevel(tx, input.productId, input.shopId, input.quantity, at);
      }
    });

    return id;
  }

  /** Variante transactionnelle : à utiliser à l'intérieur d'un bloc existant. */
  async recordIn(tx: SqlExecutor, input: MovementInput): Promise<string> {
    return new StockRepository(tx).record(input);
  }

  async list(query: MovementQuery): Promise<{ items: MovementListItem[]; total: number }> {
    const limit = Math.min(query.limit ?? 50, 500);
    const offset = Math.max(0, query.offset ?? 0);

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (query.shopId) {
      conditions.push('m.shop_id = ?');
      params.push(query.shopId);
    }
    if (query.productId) {
      conditions.push('m.product_id = ?');
      params.push(query.productId);
    }
    if (query.unitId) {
      conditions.push('m.unit_id = ?');
      params.push(query.unitId);
    }
    if (query.type) {
      conditions.push('m.type = ?');
      params.push(query.type);
    }
    if (query.from) {
      conditions.push('m.occurred_at >= ?');
      params.push(query.from);
    }
    if (query.to) {
      conditions.push('m.occurred_at < ?');
      params.push(query.to);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await this.db.select<MovementRow & Record<string, string | null>>(
      `SELECT m.*, p.name AS product_name, p.sku AS product_sku,
              COALESCE(u.imei1, u.serial) AS identifier,
              a.full_name AS user_label
       FROM stock_movement m
       JOIN product p ON p.id = m.product_id
       LEFT JOIN v_unit u ON u.id = m.unit_id
       LEFT JOIN app_user a ON a.id = m.user_id
       ${where}
       ORDER BY m.occurred_at DESC, m.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    const totals = await this.db.select<{ total: number }>(
      `SELECT COUNT(*) AS total FROM stock_movement m ${where}`,
      params,
    );

    return {
      items: rows.map((row) => ({
        ...toMovement(row),
        productName: row['product_name'] ?? '',
        productSku: row['product_sku'] ?? '',
        identifier: row['identifier'] ?? null,
        userLabel: row['user_label'] ?? null,
      })),
      total: totals[0]?.total ?? 0,
    };
  }

  /* ─── Arrivages ───────────────────────────────────────────────────────── */

  /**
   * Ce qui est ENTRÉ en stock, regroupé par arrivage.
   *
   * POURQUOI CE REGROUPEMENT. La liste des mouvements répond à « qu'est-il
   * arrivé à cet article ? ». Elle ne répond pas à « qu'est-ce qui est arrivé
   * le 12 mars ? » : un import de deux cents téléphones y occupe deux cents
   * lignes, et l'on ne voit plus la livraison, seulement ses grains.
   *
   * Un arrivage est identifié par son ORIGINE — un fichier d'import, une
   * réception de commande, un transfert reçu, une correction d'inventaire — et
   * par le jour où il a eu lieu. Les colonnes `source` et `source_id` du
   * journal des mouvements portent déjà cette identité, et un index les couvre.
   *
   * Le jour est calculé en heure LOCALE (`localtime`) et non en UTC : une
   * livraison de 22 h à Antananarivo tomberait sinon au lendemain, et le gérant
   * ne la trouverait pas à la date où il l'a reçue.
   */
  async arrivals(query: ArrivalQuery): Promise<ArrivalGroup[]> {
    const conditions = ['m.quantity > 0'];
    const params: unknown[] = [];
    if (query.shopId) {
      conditions.push('m.shop_id = ?');
      params.push(query.shopId);
    }
    if (query.source) {
      conditions.push('m.source = ?');
      params.push(query.source);
    }
    if (query.from) {
      conditions.push('m.occurred_at >= ?');
      params.push(query.from);
    }
    if (query.to) {
      conditions.push('m.occurred_at < ?');
      params.push(query.to);
    }

    const rows = await this.db.select<ArrivalRow>(
      `SELECT date(m.occurred_at, 'localtime')      AS day,
              m.source                              AS source,
              COALESCE(m.source_id, '')             AS source_id,
              MIN(m.source_label)                   AS label,
              MIN(m.occurred_at)                    AS first_at,
              MAX(m.occurred_at)                    AS last_at,
              COUNT(DISTINCT m.product_id)          AS products,
              SUM(m.quantity)                       AS units,
              -- Les appareils identifiés se comptent à part : ce sont eux
              -- qu'on retrouve un par un, IMEI en main.
              COUNT(m.unit_id)                      AS identified,
              SUM(m.quantity * COALESCE(m.unit_cost, 0)) AS cost,
              MIN(a.full_name)                      AS user_label
         FROM stock_movement m
         LEFT JOIN app_user a ON a.id = m.user_id
        WHERE ${conditions.join(' AND ')}
        GROUP BY day, m.source, COALESCE(m.source_id, '')
        ORDER BY last_at DESC
        LIMIT ?`,
      [...params, Math.min(query.limit ?? 200, 1000)],
    );

    return rows.map((row) => ({
      day: row.day,
      source: row.source,
      sourceId: row.source_id === '' ? null : row.source_id,
      label: row.label,
      firstAt: row.first_at,
      lastAt: row.last_at,
      products: row.products,
      units: row.units,
      identified: row.identified,
      cost: row.cost,
      userLabel: row.user_label,
    }));
  }

  /**
   * Le détail d'un arrivage : ce qui est entré, ligne par ligne.
   *
   * On cherche par origine ET par jour. Sans le jour, une origine réutilisée —
   * une commande reçue en deux fois — mêlerait les deux livraisons, et l'écart
   * constaté à la seconde deviendrait introuvable.
   */
  async arrivalDetail(
    source: string,
    sourceId: string | null,
    day: string,
  ): Promise<MovementListItem[]> {
    const rows = await this.db.select<MovementRow & Record<string, string | null>>(
      `SELECT m.*, p.name AS product_name, p.sku AS product_sku,
              COALESCE(u.imei1, u.serial) AS identifier,
              a.full_name AS user_label
         FROM stock_movement m
         JOIN product p ON p.id = m.product_id
         LEFT JOIN v_unit u ON u.id = m.unit_id
         LEFT JOIN app_user a ON a.id = m.user_id
        WHERE m.quantity > 0 AND m.source = ?
          AND COALESCE(m.source_id, '') = ?
          AND date(m.occurred_at, 'localtime') = ?
        ORDER BY p.name, m.occurred_at`,
      [source, sourceId ?? '', day],
    );

    return rows.map((row) => ({
      ...toMovement(row),
      productName: row['product_name'] ?? '',
      productSku: row['product_sku'] ?? '',
      identifier: row['identifier'] ?? null,
      userLabel: row['user_label'] ?? null,
    }));
  }

  /** Historique complet d'un appareil (§23) : achat, transferts, vente, retour. */
  async unitHistory(unitId: string): Promise<MovementListItem[]> {
    const { items } = await this.list({ unitId, limit: 500 });
    // Ordre chronologique croissant : une fiche d'appareil se lit du début.
    return [...items].reverse();
  }

  async levelOf(
    productId: string,
    shopId: string,
  ): Promise<{ quantity: number; reserved: number }> {
    const rows = await this.db.select<{ quantity: number; reserved: number }>(
      'SELECT quantity, reserved FROM stock_level WHERE product_id = ? AND shop_id = ?',
      [productId, shopId],
    );
    return rows[0] ?? { quantity: 0, reserved: 0 };
  }

  async levelsFor(
    productIds: readonly string[],
    shopId: string,
  ): Promise<Map<string, { quantity: number; reserved: number }>> {
    const result = new Map<string, { quantity: number; reserved: number }>();
    for (const batch of chunk(productIds)) {
      const rows = await this.db.select<{
        product_id: string;
        quantity: number;
        reserved: number;
      }>(
        `SELECT product_id, quantity, reserved FROM stock_level
         WHERE shop_id = ? AND product_id IN (${placeholders(batch.length)})`,
        [shopId, ...batch],
      );
      for (const row of rows) {
        result.set(row.product_id, { quantity: row.quantity, reserved: row.reserved });
      }
    }
    return result;
  }

  /** Réserve une quantité (panier en attente, transfert demandé). */
  async reserve(
    tx: SqlExecutor,
    productId: string,
    shopId: string,
    quantity: number,
  ): Promise<void> {
    await tx.execute(
      `INSERT INTO stock_level (product_id, shop_id, quantity, reserved, updated_at)
       VALUES (?, ?, 0, ?, ?)
       ON CONFLICT (product_id, shop_id)
       DO UPDATE SET reserved = MAX(0, reserved + ?), updated_at = excluded.updated_at`,
      [productId, shopId, Math.max(0, quantity), nowIso(), quantity],
    );
  }

  /**
   * Recalcule `stock_level` à partir des mouvements.
   *
   * Filet de sécurité : si un total venait à diverger — coupure au mauvais
   * moment, import fautif, bogue — les mouvements font foi et permettent de
   * reconstruire la vérité. Sans eux, il n'y aurait rien à quoi se raccrocher.
   */
  async rebuildLevels(shopId: string): Promise<number> {
    const rows = await this.db.select<{ product_id: string; quantity: number }>(
      `SELECT m.product_id, SUM(m.quantity) AS quantity
       FROM stock_movement m
       JOIN product p ON p.id = m.product_id
       WHERE m.shop_id = ? AND m.unit_id IS NULL AND p.tracking = 'QUANTITY'
       GROUP BY m.product_id`,
      [shopId],
    );

    const at = nowIso();
    await this.db.transaction(async (tx) => {
      for (const row of rows) {
        await tx.execute(
          `INSERT INTO stock_level (product_id, shop_id, quantity, reserved, updated_at)
           VALUES (?, ?, ?, 0, ?)
           ON CONFLICT (product_id, shop_id)
           DO UPDATE SET quantity = excluded.quantity, updated_at = excluded.updated_at`,
          [row.product_id, shopId, row.quantity, at],
        );
      }
    });
    return rows.length;
  }
}

/**
 * Applique une variation de quantité.
 *
 * `MAX(0, …)` n'est PAS employé ici : un stock négatif doit rester visible. Le
 * masquer donnerait un inventaire faux et ferait disparaître l'erreur de saisie
 * qui l'a produit ; l'autorisation d'y descendre est un choix de service, pas
 * une décision du dépôt.
 */
async function applyLevel(
  tx: SqlExecutor,
  productId: string,
  shopId: string,
  delta: number,
  at: string,
): Promise<void> {
  await tx.execute(
    `INSERT INTO stock_level (product_id, shop_id, quantity, reserved, updated_at)
     VALUES (?, ?, ?, 0, ?)
     ON CONFLICT (product_id, shop_id)
     DO UPDATE SET quantity = quantity + ?, updated_at = excluded.updated_at`,
    [productId, shopId, delta, at, delta],
  );
}
