import { INVENTORY_STATUS, MOVEMENT_TYPE, PERMISSIONS, newId, nowIso } from '@boutique/shared';
import type { InventorySession, InventoryStatus } from '@boutique/shared';
import { StockRepository } from '../db/repositories/stock.repository';
import { CounterRepository } from '../db/repositories/counter.repository';
import { AUDIT_ACTIONS } from '../db/repositories/audit.repository';
import { AuditService } from './audit.service';
import { BusinessError, actorOf, assertCan, type AppContext } from './context';

/**
 * Inventaire physique.
 *
 * L'inventaire ne CORRIGE pas le stock ligne à ligne au fil du comptage : il
 * enregistre d'abord ce qui est attendu et ce qui est compté, puis n'écrit les
 * écarts qu'au moment de la VALIDATION. C'est ce qui permet de compter à
 * plusieurs, sur plusieurs heures, de recompter une allée, et de ne toucher au
 * stock qu'une fois, quand le responsable est sûr.
 *
 * Chaque écart produit un mouvement de type `INVENTORY` : un stock qui change
 * sans trace n'existe pas dans ce logiciel (§6).
 */

export interface InventoryLineView {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  unitId: string | null;
  identifier: string | null;
  expected: number;
  counted: number | null;
  note: string | null;
}

export class InventoryService {
  private readonly audit: AuditService;

  constructor(private readonly context: AppContext) {
    this.audit = new AuditService(context);
  }

  /**
   * Ouvre une session en photographiant le stock attendu.
   *
   * La photo est prise À L'OUVERTURE, pas à la validation : sinon les ventes
   * faites pendant le comptage se transformeraient en écarts, et l'inventaire
   * accuserait le magasin de pertes qui n'existent pas.
   */
  async open(note?: string | null): Promise<string> {
    assertCan(this.context, PERMISSIONS.inventoryManage);
    const userId = this.context.session?.id;
    if (!userId) throw new BusinessError('Session requise.');

    const open = await this.context.db.select<{ id: string; number: string }>(
      `SELECT id, number FROM inventory_session
       WHERE shop_id = ? AND status IN ('OPEN', 'COUNTED') AND deleted_at IS NULL`,
      [this.context.shopId],
    );
    if (open[0]) {
      throw new BusinessError(
        `L'inventaire ${open[0].number} est encore ouvert : terminez-le avant d'en commencer un autre.`,
      );
    }

    const number = await new CounterRepository(this.context.db).nextNumber(
      'inventory',
      this.context.shopId,
      this.context.shopCode,
      this.context.settings.numbering['inventory'],
    );

    // Produits par quantité : leur niveau. Appareils : une ligne par unité.
    const quantities = await this.context.db.select<{ product_id: string; quantity: number }>(
      `SELECT sl.product_id, sl.quantity FROM stock_level sl
       JOIN product p ON p.id = sl.product_id
       WHERE sl.shop_id = ? AND p.deleted_at IS NULL AND p.tracking = 'QUANTITY'`,
      [this.context.shopId],
    );
    const units = await this.context.db.select<{ id: string; product_id: string }>(
      `SELECT id, product_id FROM product_unit
       WHERE shop_id = ? AND deleted_at IS NULL AND status IN ('IN_STOCK', 'RETURNED')`,
      [this.context.shopId],
    );

    const sessionId = newId();
    const at = nowIso();
    await this.context.db.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO inventory_session (id, shop_id, number, status, started_by, started_at, note,
                                        created_at, updated_at)
         VALUES (?, ?, ?, 'OPEN', ?, ?, ?, ?, ?)`,
        [sessionId, this.context.shopId, number, userId, at, note ?? null, at, at],
      );
      for (const row of quantities) {
        await tx.execute(
          `INSERT INTO inventory_line (id, session_id, product_id, unit_id, expected_quantity)
           VALUES (?, ?, ?, NULL, ?)`,
          [newId(), sessionId, row.product_id, row.quantity],
        );
      }
      for (const unit of units) {
        await tx.execute(
          `INSERT INTO inventory_line (id, session_id, product_id, unit_id, expected_quantity)
           VALUES (?, ?, ?, ?, 1)`,
          [newId(), sessionId, unit.product_id, unit.id],
        );
      }
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.stockChange,
        entity: 'inventory_session',
        entityId: sessionId,
        after: { numero: number, lignes: quantities.length + units.length },
      });
    });

    return sessionId;
  }

  async lines(sessionId: string): Promise<InventoryLineView[]> {
    const rows = await this.context.db.select<{
      id: string;
      product_id: string;
      product_name: string;
      sku: string;
      unit_id: string | null;
      identifier: string | null;
      expected_quantity: number;
      counted_quantity: number | null;
      note: string | null;
    }>(
      `SELECT l.id, l.product_id, p.name AS product_name, p.sku, l.unit_id,
              COALESCE(u.imei1, u.serial) AS identifier,
              l.expected_quantity, l.counted_quantity, l.note
       FROM inventory_line l
       JOIN product p ON p.id = l.product_id
       LEFT JOIN v_unit u ON u.id = l.unit_id
       WHERE l.session_id = ?
       ORDER BY p.name, identifier`,
      [sessionId],
    );
    return rows.map((row) => ({
      id: row.id,
      productId: row.product_id,
      productName: row.product_name,
      sku: row.sku,
      unitId: row.unit_id,
      identifier: row.identifier,
      expected: row.expected_quantity,
      counted: row.counted_quantity,
      note: row.note,
    }));
  }

  async count(lineId: string, quantity: number, note?: string | null): Promise<void> {
    assertCan(this.context, PERMISSIONS.inventoryManage);
    if (quantity < 0) throw new BusinessError('Une quantité comptée ne peut pas être négative.');
    await this.context.db.execute(
      'UPDATE inventory_line SET counted_quantity = ?, note = COALESCE(?, note) WHERE id = ?',
      [quantity, note ?? null, lineId],
    );
  }

  /**
   * Valide l'inventaire : les écarts deviennent des mouvements.
   *
   * Les lignes NON COMPTÉES sont ignorées, pas mises à zéro. Un inventaire
   * partiel est la norme — on compte un rayon un jour, un autre la semaine
   * suivante — et considérer « non compté » comme « absent » ferait disparaître
   * du stock bien réel.
   */
  async apply(sessionId: string): Promise<{ adjusted: number; difference: number }> {
    assertCan(this.context, PERMISSIONS.inventoryManage);
    const session = await this.byId(sessionId);
    if (!session) throw new BusinessError('Inventaire introuvable.');
    if (session.status === INVENTORY_STATUS.applied) {
      throw new BusinessError('Cet inventaire a déjà été appliqué.');
    }

    const lines = await this.lines(sessionId);
    const discrepancies = lines.filter(
      (line) => line.counted !== null && line.counted !== line.expected,
    );

    const at = nowIso();
    let difference = 0;

    await this.context.db.transaction(async (tx) => {
      const stock = new StockRepository(tx);
      for (const line of discrepancies) {
        const delta = (line.counted ?? 0) - line.expected;
        difference += delta;

        await stock.record({
          shopId: this.context.shopId,
          productId: line.productId,
          unitId: line.unitId,
          type: MOVEMENT_TYPE.inventory,
          quantity: delta,
          source: 'INVENTORY',
          sourceId: sessionId,
          sourceLabel: session.number,
          userId: actorOf(this.context).userId,
          occurredAt: at,
          note: line.note ?? `Écart d'inventaire ${session.number}`,
        });

        // Un appareil compté absent est déclaré perdu : il quitte le stock
        // vendable sans disparaître, et pourra être retrouvé plus tard.
        if (line.unitId && (line.counted ?? 0) === 0) {
          await tx.execute(
            `UPDATE product_unit SET status = 'LOST', updated_at = ? WHERE id = ? AND status IN ('IN_STOCK', 'RETURNED')`,
            [at, line.unitId],
          );
        }
      }

      await tx.execute(
        `UPDATE inventory_session SET status = 'APPLIED', applied_at = ?, updated_at = ? WHERE id = ?`,
        [at, at, sessionId],
      );
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.stockChange,
        entity: 'inventory_session',
        entityId: sessionId,
        after: { numero: session.number, ecarts: discrepancies.length, difference },
      });
    });

    return { adjusted: discrepancies.length, difference };
  }

  async cancel(sessionId: string, reason: string): Promise<void> {
    assertCan(this.context, PERMISSIONS.inventoryManage);
    await this.context.db.transaction(async (tx) => {
      await tx.execute(
        `UPDATE inventory_session SET status = 'CANCELLED', note = ?, updated_at = ? WHERE id = ?`,
        [reason, nowIso(), sessionId],
      );
    });
  }

  async byId(id: string): Promise<InventorySession | null> {
    const rows = await this.context.db.select<{
      id: string;
      shop_id: string;
      number: string;
      status: InventoryStatus;
      started_by: string;
      started_at: string;
      applied_at: string | null;
      note: string | null;
      created_at: string;
      updated_at: string;
      deleted_at: string | null;
    }>('SELECT * FROM inventory_session WHERE id = ?', [id]);
    const row = rows[0];
    return row
      ? {
          id: row.id,
          shopId: row.shop_id,
          number: row.number,
          status: row.status,
          startedBy: row.started_by,
          startedAt: row.started_at,
          appliedAt: row.applied_at,
          note: row.note,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          deletedAt: row.deleted_at,
        }
      : null;
  }

  async list(limit = 50): Promise<InventorySession[]> {
    const rows = await this.context.db.select<{ id: string }>(
      `SELECT id FROM inventory_session WHERE shop_id = ? AND deleted_at IS NULL
       ORDER BY started_at DESC LIMIT ?`,
      [this.context.shopId, limit],
    );
    const sessions: InventorySession[] = [];
    for (const row of rows) {
      const session = await this.byId(row.id);
      if (session) sessions.push(session);
    }
    return sessions;
  }
}
