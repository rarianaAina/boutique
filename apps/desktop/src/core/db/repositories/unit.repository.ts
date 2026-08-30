import { checkImei, newId, normalizeSerial, nowIso } from '@boutique/shared';
import type { ImeiOptions } from '@boutique/shared';
import type { Money, ProductUnit, UnitCondition, UnitStatus } from '@boutique/shared';
import { chunk, placeholders } from '../chunk';
import type { SqlExecutor } from '../client';

/**
 * Unités physiques et identifiants (IMEI, numéro de série).
 *
 * C'est le dépôt le plus sensible du logiciel. Deux invariants y sont tenus,
 * et tous deux le sont par la BASE, jamais par une vérification préalable :
 *
 *  1. UNICITÉ GLOBALE DE L'IMEI — l'index `ux_identifier_value` porte sur
 *     (kind, value), donc l'IMEI 1 d'un appareil ne peut pas être l'IMEI 2 d'un
 *     autre. Une vérification en JavaScript avant l'insertion ne suffirait pas :
 *     entre le contrôle et l'écriture, une seconde fenêtre peut insérer.
 *
 *  2. UN SEUL IDENTIFIANT PAR EMPLACEMENT — `ux_identifier_slot` empêche deux
 *     « IMEI 1 » sur la même unité.
 *
 * Les erreurs d'unicité remontées par SQLite sont retraduites en messages
 * lisibles : « IMEI déjà enregistré » plutôt que « UNIQUE constraint failed ».
 */

interface UnitRow {
  id: string;
  product_id: string;
  shop_id: string;
  status: UnitStatus;
  condition: UnitCondition;
  color: string | null;
  capacity: string | null;
  cost_price: number;
  supplier_id: string | null;
  purchase_id: string | null;
  received_at: string | null;
  sold_at: string | null;
  sale_id: string | null;
  transfer_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  imei1: string | null;
  imei2: string | null;
  serial: string | null;
}

const toUnit = (row: UnitRow): ProductUnit => ({
  id: row.id,
  productId: row.product_id,
  shopId: row.shop_id,
  status: row.status,
  condition: row.condition,
  imei1: row.imei1,
  imei2: row.imei2,
  serial: row.serial,
  color: row.color,
  capacity: row.capacity,
  costPrice: row.cost_price,
  supplierId: row.supplier_id,
  purchaseId: row.purchase_id,
  receivedAt: row.received_at,
  soldAt: row.sold_at,
  saleId: row.sale_id,
  transferId: row.transfer_id,
  notes: row.notes,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
});

export interface UnitInput {
  productId: string;
  shopId: string;
  imei1?: string | null;
  imei2?: string | null;
  serial?: string | null;
  color?: string | null;
  capacity?: string | null;
  condition?: UnitCondition;
  status?: UnitStatus;
  costPrice?: Money;
  supplierId?: string | null;
  purchaseId?: string | null;
  receivedAt?: string | null;
  notes?: string | null;
}

/** Unité enrichie du nom de son produit : ce que les listes affichent. */
export interface UnitListItem extends ProductUnit {
  productName: string;
  productSku: string;
  brand: string | null;
  shopName: string;
}

export interface UnitQuery {
  shopId?: string | null;
  productId?: string | null;
  status?: UnitStatus | null;
  /** Recherche sur IMEI, numéro de série, SKU ou nom du produit. */
  query?: string;
  limit?: number;
  offset?: number;
}

/**
 * Erreur d'identifiant en double.
 *
 * Type distinct pour que l'import Excel puisse la compter comme « doublon »
 * plutôt que comme « échec technique », et que le POS affiche un message précis.
 */
export class DuplicateIdentifierError extends Error {
  constructor(
    readonly kind: string,
    readonly value: string,
  ) {
    super(
      kind === 'IMEI'
        ? `L'IMEI ${value} est déjà enregistré sur un autre appareil.`
        : `Le numéro de série ${value} est déjà enregistré.`,
    );
    this.name = 'DuplicateIdentifierError';
  }
}

const LIST_SELECT = `
  SELECT u.*, p.name AS product_name, p.sku AS product_sku, p.brand AS brand,
         s.name AS shop_name
  FROM v_unit u
  JOIN product p ON p.id = u.product_id
  JOIN shop s ON s.id = u.shop_id`;

export class UnitRepository {
  constructor(private readonly db: SqlExecutor) {}

  async byId(id: string): Promise<ProductUnit | null> {
    const rows = await this.db.select<UnitRow>('SELECT * FROM v_unit WHERE id = ?', [id]);
    return rows[0] ? toUnit(rows[0]) : null;
  }

  async byIds(ids: readonly string[]): Promise<Map<string, ProductUnit>> {
    const result = new Map<string, ProductUnit>();
    for (const batch of chunk(ids)) {
      const rows = await this.db.select<UnitRow>(
        `SELECT * FROM v_unit WHERE id IN (${placeholders(batch.length)})`,
        [...batch],
      );
      for (const row of rows) result.set(row.id, toUnit(row));
    }
    return result;
  }

  /**
   * Recherche par identifiant exact — le chemin le plus emprunté du logiciel.
   *
   * Une seule lecture d'index, quel que soit le nombre d'appareils : c'est
   * l'exigence de rapidité du §31. L'IMEI est normalisé avant la requête, pour
   * qu'un numéro collé avec des tirets trouve quand même son appareil.
   */
  async byIdentifier(value: string): Promise<ProductUnit | null> {
    const cleaned = value.trim();
    if (cleaned === '') return null;
    const candidates = [cleaned, cleaned.replace(/\D/g, ''), normalizeSerial(cleaned)].filter(
      (candidate, index, list) => candidate !== '' && list.indexOf(candidate) === index,
    );

    const rows = await this.db.select<UnitRow>(
      `SELECT u.* FROM unit_identifier i
       JOIN v_unit u ON u.id = i.unit_id
       WHERE i.value IN (${placeholders(candidates.length)})
       LIMIT 1`,
      candidates,
    );
    return rows[0] ? toUnit(rows[0]) : null;
  }

  /** Identifiants déjà présents parmi ceux proposés. Utilisé par l'import. */
  async existingIdentifiers(values: readonly string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (const batch of chunk(values)) {
      const rows = await this.db.select<{ value: string }>(
        `SELECT value FROM unit_identifier WHERE value IN (${placeholders(batch.length)})`,
        [...batch],
      );
      for (const row of rows) found.add(row.value);
    }
    return found;
  }

  async list(query: UnitQuery): Promise<{ items: UnitListItem[]; total: number }> {
    const limit = Math.min(query.limit ?? 50, 500);
    const offset = Math.max(0, query.offset ?? 0);

    const conditions = ['u.deleted_at IS NULL'];
    const params: unknown[] = [];
    if (query.shopId) {
      conditions.push('u.shop_id = ?');
      params.push(query.shopId);
    }
    if (query.productId) {
      conditions.push('u.product_id = ?');
      params.push(query.productId);
    }
    if (query.status) {
      conditions.push('u.status = ?');
      params.push(query.status);
    }
    const term = (query.query ?? '').trim();
    if (term !== '') {
      // Le préfixe est suffisant : un utilisateur qui tape les six derniers
      // chiffres d'un IMEI utilise la recherche globale, pas cette liste.
      conditions.push(
        `(u.imei1 LIKE ? OR u.imei2 LIKE ? OR u.serial LIKE ? OR p.sku LIKE ? OR p.name LIKE ?)`,
      );
      const like = `${term}%`;
      params.push(like, like, like, like, `%${term}%`);
    }

    const where = conditions.join(' AND ');
    const rows = await this.db.select<UnitRow & Record<string, string>>(
      `${LIST_SELECT} WHERE ${where} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    const totals = await this.db.select<{ total: number }>(
      `SELECT COUNT(*) AS total FROM v_unit u JOIN product p ON p.id = u.product_id WHERE ${where}`,
      params,
    );

    return {
      items: rows.map((row) => ({
        ...toUnit(row),
        productName: row['product_name'] ?? '',
        productSku: row['product_sku'] ?? '',
        brand: row['brand'] ?? null,
        shopName: row['shop_name'] ?? '',
      })),
      total: totals[0]?.total ?? 0,
    };
  }

  /**
   * Crée une unité et ses identifiants.
   *
   * Les IMEI sont validés (format et clé de Luhn) AVANT écriture : un IMEI
   * fautif entré en stock ne se rattrape pas, l'appareil part avec un mauvais
   * numéro et son historique ment jusqu'à la fin de sa vie.
   */
  async create(input: UnitInput, id = newId()): Promise<string> {
    const identifiers = buildIdentifiers(input);
    const at = nowIso();

    await this.db.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO product_unit (id, product_id, shop_id, status, condition, color, capacity,
                                   cost_price, supplier_id, purchase_id, received_at, notes,
                                   created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.productId,
          input.shopId,
          input.status ?? 'IN_STOCK',
          input.condition ?? 'NEW',
          input.color ?? null,
          input.capacity ?? null,
          input.costPrice ?? 0,
          input.supplierId ?? null,
          input.purchaseId ?? null,
          input.receivedAt ?? at,
          input.notes ?? null,
          at,
          at,
        ],
      );
      for (const identifier of identifiers) {
        await tx.execute(
          'INSERT INTO unit_identifier (id, unit_id, kind, slot, value) VALUES (?, ?, ?, ?, ?)',
          [identifier.id, id, identifier.kind, identifier.slot, identifier.value],
        );
      }
    });

    return id;
  }

  /**
   * Change le statut d'une unité, en refusant les transitions impossibles.
   *
   * Le `WHERE status IN (…)` fait la vérification et l'écriture en une seule
   * instruction : c'est ce qui empêche de vendre deux fois le même appareil
   * depuis deux fenêtres. Le nombre de lignes affectées n'étant pas remonté par
   * le lot transactionnel, l'appelant vérifie l'état AVANT (message clair) et la
   * base garantit APRÈS (aucune double sortie possible).
   */
  async changeStatus(
    id: string,
    status: UnitStatus,
    allowedFrom: readonly UnitStatus[],
    extra: {
      saleId?: string | null;
      soldAt?: string | null;
      transferId?: string | null;
      shopId?: string;
      notes?: string | null;
      /**
       * Détache l'unité de sa vente.
       *
       * Un simple `saleId: null` ne suffirait pas : les autres champs sont
       * écrits avec `COALESCE`, qui interprète NULL comme « ne change pas ».
       * Il faut donc dire explicitement qu'on veut effacer — c'est le cas d'un
       * retour, d'un échange ou d'une annulation, où l'appareil redevient
       * disponible et ne doit plus pointer vers un ticket.
       */
      clearSale?: boolean;
    } = {},
  ): Promise<void> {
    const clear = extra.clearSale ? 1 : 0;
    await this.db.execute(
      `UPDATE product_unit SET
         status = ?,
         sale_id = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(?, sale_id) END,
         sold_at = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(?, sold_at) END,
         transfer_id = ?,
         shop_id = COALESCE(?, shop_id),
         notes = COALESCE(?, notes),
         updated_at = ?
       WHERE id = ? AND status IN (${placeholders(allowedFrom.length)})`,
      [
        status,
        clear,
        extra.saleId ?? null,
        clear,
        extra.soldAt ?? null,
        extra.transferId ?? null,
        extra.shopId ?? null,
        extra.notes ?? null,
        nowIso(),
        id,
        ...allowedFrom,
      ],
    );
  }

  /** Écriture directe du statut, sans garde : réservée aux corrections d'administration. */
  async forceStatus(id: string, status: UnitStatus, note: string): Promise<void> {
    await this.db.execute(
      'UPDATE product_unit SET status = ?, notes = ?, updated_at = ? WHERE id = ?',
      [status, note, nowIso(), id],
    );
  }

  async setCost(id: string, costPrice: Money): Promise<void> {
    await this.db.execute('UPDATE product_unit SET cost_price = ?, updated_at = ? WHERE id = ?', [
      costPrice,
      nowIso(),
      id,
    ]);
  }

  /** Unités disponibles à la vente d'un produit, dans une boutique. */
  async availableFor(productId: string, shopId: string, limit = 100): Promise<ProductUnit[]> {
    const rows = await this.db.select<UnitRow>(
      `SELECT * FROM v_unit
       WHERE product_id = ? AND shop_id = ? AND deleted_at IS NULL
         AND status IN ('IN_STOCK', 'RETURNED')
       ORDER BY received_at, created_at
       LIMIT ?`,
      [productId, shopId, limit],
    );
    return rows.map(toUnit);
  }

  async countAvailable(productId: string, shopId: string): Promise<number> {
    const rows = await this.db.select<{ total: number }>(
      `SELECT COUNT(*) AS total FROM product_unit
       WHERE product_id = ? AND shop_id = ? AND deleted_at IS NULL
         AND status IN ('IN_STOCK', 'RETURNED')`,
      [productId, shopId],
    );
    return rows[0]?.total ?? 0;
  }

  /** Répartition par statut, pour le tableau de bord du stock. */
  async statusBreakdown(shopId: string): Promise<{ status: UnitStatus; total: number }[]> {
    return this.db.select<{ status: UnitStatus; total: number }>(
      `SELECT status, COUNT(*) AS total FROM product_unit
       WHERE shop_id = ? AND deleted_at IS NULL
       GROUP BY status ORDER BY total DESC`,
      [shopId],
    );
  }
}

/**
 * Construit et valide les identifiants d'une unité.
 *
 * Exporté pour que l'import Excel puisse valider un lot entier avant d'écrire
 * quoi que ce soit : rien n'est plus difficile à réparer qu'un import à moitié
 * passé.
 */
export function buildIdentifiers(
  input: Pick<UnitInput, 'imei1' | 'imei2' | 'serial'>,
  options: ImeiOptions = {},
): { id: string; kind: 'IMEI' | 'SERIAL'; slot: number; value: string }[] {
  const identifiers: { id: string; kind: 'IMEI' | 'SERIAL'; slot: number; value: string }[] = [];

  for (const [slot, raw] of [
    [1, input.imei1],
    [2, input.imei2],
  ] as const) {
    if (!raw || raw.trim() === '') continue;
    const check = checkImei(raw, options);
    if (!check.valid || !check.value) {
      throw new Error(`IMEI ${slot} invalide : ${check.message ?? 'format inattendu'}`);
    }
    identifiers.push({ id: newId(), kind: 'IMEI', slot, value: check.value });
  }

  if (identifiers.length === 2 && identifiers[0]?.value === identifiers[1]?.value) {
    throw new Error("Les deux IMEI d'un appareil bi-SIM doivent être différents.");
  }

  if (input.serial && input.serial.trim() !== '') {
    identifiers.push({
      id: newId(),
      kind: 'SERIAL',
      slot: 1,
      value: normalizeSerial(input.serial),
    });
  }

  return identifiers;
}

/**
 * Retraduit une violation d'unicité SQLite en erreur métier.
 *
 * Le message brut de SQLite (« UNIQUE constraint failed:
 * unit_identifier.kind, unit_identifier.value ») n'apprend rien à un vendeur
 * devant un client.
 */
export function describeIdentifierConflict(
  cause: unknown,
  identifiers: { kind: string; value: string }[],
): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (!message.includes('UNIQUE') && !message.includes('constraint')) {
    return cause instanceof Error ? cause : new Error(message);
  }
  const first = identifiers[0];
  return first ? new DuplicateIdentifierError(first.kind, first.value) : new Error(message);
}
