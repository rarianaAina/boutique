import {
  MOVEMENT_TYPE,
  PERMISSIONS,
  SYNC_EVENT,
  UNIT_STATUS,
  checkImei,
  newId,
  normalizeSerial,
  nowIso,
} from '@boutique/shared';
import type {
  Money,
  MovementSource,
  MovementType,
  Tracking,
  UnitCondition,
  UnitStatus,
} from '@boutique/shared';
import { ProductRepository } from '../db/repositories/product.repository';
import { StockRepository } from '../db/repositories/stock.repository';
import { UnitRepository, buildIdentifiers } from '../db/repositories/unit.repository';
import { OutboxRepository } from '../db/repositories/outbox.repository';
import { AUDIT_ACTIONS } from '../db/repositories/audit.repository';
import { AuditService } from './audit.service';
import { BusinessError, actorOf, assertCan, type AppContext } from './context';
import type { SqlExecutor } from '../db/client';

/**
 * Entrées, sorties et corrections de stock.
 *
 * C'est le seul point d'entrée autorisé pour faire bouger du stock. Trois
 * choses y sont faites ENSEMBLE, dans une seule transaction, ou pas du tout :
 *
 *   1. l'état (unité créée / quantité modifiée) ;
 *   2. le mouvement qui l'explique (§6) ;
 *   3. l'événement de synchronisation et l'entrée d'audit.
 *
 * Les séparer laisserait la porte ouverte à un stock qui bouge sans trace, ou à
 * une vente enregistrée localement que le serveur n'apprendrait jamais.
 */

export interface UnitDraft {
  imei1?: string | null;
  imei2?: string | null;
  serial?: string | null;
  color?: string | null;
  capacity?: string | null;
  condition?: UnitCondition;
  costPrice?: Money;
  notes?: string | null;
}

export interface ReceiveUnitsInput {
  productId: string;
  units: UnitDraft[];
  supplierId?: string | null;
  purchaseId?: string | null;
  source?: MovementSource;
  sourceId?: string | null;
  sourceLabel?: string | null;
  occurredAt?: string;
  note?: string | null;
  /** Boutique destinataire. Par défaut, celle de la session. */
  shopId?: string;
}

export interface ReceiveQuantityInput {
  productId: string;
  quantity: number;
  unitCost?: Money | null;
  source?: MovementSource;
  sourceId?: string | null;
  sourceLabel?: string | null;
  occurredAt?: string;
  note?: string | null;
  shopId?: string;
}

export interface AdjustInput {
  productId: string;
  unitId?: string | null;
  /** Signée : la correction peut aller dans les deux sens. */
  quantity: number;
  type?: MovementType;
  note: string;
  unitCost?: Money | null;
}

export class StockService {
  private readonly units: UnitRepository;
  private readonly stock: StockRepository;
  private readonly products: ProductRepository;
  private readonly audit: AuditService;

  constructor(private readonly context: AppContext) {
    this.units = new UnitRepository(context.db);
    this.stock = new StockRepository(context.db);
    this.products = new ProductRepository(context.db);
    this.audit = new AuditService(context);
  }

  /**
   * Entrée en stock d'appareils identifiés (§7).
   *
   * Le lot est validé ENTIÈREMENT avant la moindre écriture : format des IMEI,
   * doublons à l'intérieur du lot, doublons déjà en base. Un import de trente
   * téléphones dont le vingt-huitième porte un IMEI déjà connu ne doit pas
   * laisser vingt-sept appareils écrits et le reste perdu — c'est exactement le
   * genre d'état à moitié appliqué qu'on ne sait plus démêler ensuite.
   */
  async receiveUnits(input: ReceiveUnitsInput): Promise<string[]> {
    assertCan(this.context, PERMISSIONS.stockAdjust);

    const shopId = input.shopId ?? this.context.shopId;
    const product = await this.products.byId(input.productId);
    if (!product) throw new BusinessError('Produit introuvable.');
    if (product.tracking === 'QUANTITY') {
      throw new BusinessError(
        `« ${product.name} » est suivi par quantité : il n'a pas d'IMEI ni de numéro de série.`,
      );
    }
    if (input.units.length === 0) throw new BusinessError('Aucun appareil à enregistrer.');

    const prepared = this.prepareUnits(product.tracking, input.units);
    await this.assertIdentifiersFree(prepared.flatMap((entry) => entry.identifiers));

    const at = nowIso();
    const occurredAt = input.occurredAt ?? at;
    const source = input.source ?? 'MANUAL';

    await this.context.db.transaction(async (tx) => {
      const stock = new StockRepository(tx);
      const outbox = new OutboxRepository(tx);

      for (const entry of prepared) {
        await tx.execute(
          `INSERT INTO product_unit (id, product_id, shop_id, status, condition, color, capacity,
                                     cost_price, supplier_id, purchase_id, received_at, notes,
                                     created_at, updated_at)
           VALUES (?, ?, ?, 'IN_STOCK', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            entry.id,
            product.id,
            shopId,
            entry.draft.condition ?? 'NEW',
            entry.draft.color ?? null,
            entry.draft.capacity ?? null,
            entry.draft.costPrice ?? product.purchasePrice,
            input.supplierId ?? product.defaultSupplierId ?? null,
            input.purchaseId ?? null,
            occurredAt,
            entry.draft.notes ?? null,
            at,
            at,
          ],
        );

        for (const identifier of entry.identifiers) {
          await tx.execute(
            'INSERT INTO unit_identifier (id, unit_id, kind, slot, value) VALUES (?, ?, ?, ?, ?)',
            [identifier.id, entry.id, identifier.kind, identifier.slot, identifier.value],
          );
        }

        await stock.record({
          shopId,
          productId: product.id,
          unitId: entry.id,
          type: MOVEMENT_TYPE.purchaseReceipt,
          quantity: 1,
          unitCost: entry.draft.costPrice ?? product.purchasePrice,
          source,
          sourceId: input.sourceId ?? null,
          sourceLabel: input.sourceLabel ?? null,
          userId: actorOf(this.context).userId,
          occurredAt,
          note: input.note ?? null,
        });

        await outbox.enqueue({
          type: SYNC_EVENT.stockReceived,
          entity: 'product_unit',
          entityId: entry.id,
          shopId,
          userId: actorOf(this.context).userId,
          payload: {
            unitId: entry.id,
            productId: product.id,
            sku: product.sku,
            shopId,
            identifiers: entry.identifiers.map(({ kind, slot, value }) => ({ kind, slot, value })),
            costPrice: entry.draft.costPrice ?? product.purchasePrice,
            condition: entry.draft.condition ?? 'NEW',
            receivedAt: occurredAt,
            source,
            sourceId: input.sourceId ?? null,
          },
        });
      }

      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.stockChange,
        entity: 'product',
        entityId: product.id,
        shopId,
        after: {
          operation: 'RECEPTION',
          quantite: prepared.length,
          identifiants: prepared.flatMap((entry) =>
            entry.identifiers.map((identifier) => identifier.value),
          ),
        },
      });
    });

    return prepared.map((entry) => entry.id);
  }

  /** Entrée en stock d'un produit suivi par quantité. */
  async receiveQuantity(input: ReceiveQuantityInput): Promise<void> {
    assertCan(this.context, PERMISSIONS.stockAdjust);
    if (input.quantity <= 0) throw new BusinessError('La quantité reçue doit être positive.');

    const shopId = input.shopId ?? this.context.shopId;
    const product = await this.products.byId(input.productId);
    if (!product) throw new BusinessError('Produit introuvable.');
    if (product.tracking !== 'QUANTITY') {
      throw new BusinessError(
        `« ${product.name} » est suivi à l'unité : chaque exemplaire doit être identifié.`,
      );
    }

    const occurredAt = input.occurredAt ?? nowIso();
    await this.context.db.transaction(async (tx) => {
      await new StockRepository(tx).record({
        shopId,
        productId: product.id,
        type: MOVEMENT_TYPE.purchaseReceipt,
        quantity: input.quantity,
        unitCost: input.unitCost ?? product.purchasePrice,
        source: input.source ?? 'MANUAL',
        sourceId: input.sourceId ?? null,
        sourceLabel: input.sourceLabel ?? null,
        userId: actorOf(this.context).userId,
        occurredAt,
        note: input.note ?? null,
      });
      await new OutboxRepository(tx).enqueue({
        type: SYNC_EVENT.stockReceived,
        entity: 'product',
        entityId: product.id,
        shopId,
        userId: actorOf(this.context).userId,
        payload: {
          productId: product.id,
          sku: product.sku,
          shopId,
          quantity: input.quantity,
          unitCost: input.unitCost ?? product.purchasePrice,
          receivedAt: occurredAt,
        },
      });
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.stockChange,
        entity: 'product',
        entityId: product.id,
        shopId,
        after: { operation: 'RECEPTION', quantite: input.quantity },
      });
    });
  }

  /**
   * Correction de stock (§6).
   *
   * Le motif est OBLIGATOIRE : une correction sans explication est
   * indéfendable à l'inventaire suivant, et c'est précisément le moment où
   * quelqu'un cherchera à comprendre.
   */
  async adjust(input: AdjustInput): Promise<void> {
    assertCan(this.context, PERMISSIONS.stockAdjust);
    if (input.quantity === 0) {
      throw new BusinessError("Une correction de zéro n'est pas une correction.");
    }
    if (input.note.trim() === '') {
      throw new BusinessError('Le motif de la correction est obligatoire.');
    }

    const product = await this.products.byId(input.productId);
    if (!product) throw new BusinessError('Produit introuvable.');

    if (product.tracking !== 'QUANTITY' && !input.unitId) {
      throw new BusinessError(
        "Ce produit est suivi à l'unité : la correction doit désigner un appareil précis.",
      );
    }

    await this.assertNotNegative(
      product.tracking,
      product.id,
      input.quantity,
      input.unitId ?? null,
    );

    await this.context.db.transaction(async (tx) => {
      await new StockRepository(tx).record({
        shopId: this.context.shopId,
        productId: product.id,
        unitId: input.unitId ?? null,
        type: input.type ?? MOVEMENT_TYPE.adjustment,
        quantity: input.quantity,
        unitCost: input.unitCost ?? null,
        source: 'MANUAL',
        userId: actorOf(this.context).userId,
        note: input.note,
      });
      await new OutboxRepository(tx).enqueue({
        type: SYNC_EVENT.stockAdjusted,
        entity: input.unitId ? 'product_unit' : 'product',
        entityId: input.unitId ?? product.id,
        shopId: this.context.shopId,
        userId: actorOf(this.context).userId,
        payload: {
          productId: product.id,
          unitId: input.unitId ?? null,
          quantity: input.quantity,
          note: input.note,
        },
      });
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.stockChange,
        entity: input.unitId ? 'product_unit' : 'product',
        entityId: input.unitId ?? product.id,
        after: { operation: 'CORRECTION', quantite: input.quantity, motif: input.note },
      });
    });
  }

  /**
   * Sort un appareil du stock vendable sans le vendre : perte, casse, panne.
   *
   * L'unité n'est pas supprimée — son historique reste consultable, et un
   * appareil « perdu » qui ressort d'un tiroir peut être remis en stock par une
   * correction, ce qui laisse une trace des deux opérations.
   */
  async writeOffUnit(
    unitId: string,
    status: Extract<UnitStatus, 'LOST' | 'DEFECTIVE' | 'BLOCKED'>,
    note: string,
  ): Promise<void> {
    assertCan(this.context, PERMISSIONS.stockAdjust);
    if (note.trim() === '') throw new BusinessError('Le motif est obligatoire.');

    const unit = await this.units.byId(unitId);
    if (!unit) throw new BusinessError('Appareil introuvable.');
    if (unit.status === UNIT_STATUS.sold) {
      throw new BusinessError('Cet appareil est vendu : passez par un retour ou un remboursement.');
    }

    const type =
      status === 'LOST'
        ? MOVEMENT_TYPE.loss
        : status === 'DEFECTIVE'
          ? MOVEMENT_TYPE.breakage
          : MOVEMENT_TYPE.adjustment;

    await this.context.db.transaction(async (tx) => {
      await new UnitRepository(tx).changeStatus(unitId, status, [
        UNIT_STATUS.inStock,
        UNIT_STATUS.reserved,
        UNIT_STATUS.returned,
        UNIT_STATUS.defective,
      ]);
      await new StockRepository(tx).record({
        shopId: unit.shopId,
        productId: unit.productId,
        unitId,
        type,
        quantity: -1,
        unitCost: unit.costPrice,
        source: 'MANUAL',
        userId: actorOf(this.context).userId,
        note,
      });
      await new OutboxRepository(tx).enqueue({
        type: SYNC_EVENT.unitStatusChanged,
        entity: 'product_unit',
        entityId: unitId,
        shopId: unit.shopId,
        userId: actorOf(this.context).userId,
        payload: { unitId, status, note },
      });
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.stockChange,
        entity: 'product_unit',
        entityId: unitId,
        before: { statut: unit.status },
        after: { statut: status, motif: note },
      });
    });
  }

  /* ─── Validations ─────────────────────────────────────────────────────── */

  /**
   * Valide un lot d'appareils : format des identifiants, cohérence avec le mode
   * de suivi du produit, absence de doublon À L'INTÉRIEUR du lot.
   */
  private prepareUnits(
    tracking: Tracking,
    drafts: UnitDraft[],
  ): { id: string; draft: UnitDraft; identifiers: ReturnType<typeof buildIdentifiers> }[] {
    const seen = new Map<string, number>();
    return drafts.map((draft, index) => {
      const line = index + 1;

      const imeiOptions = { requireChecksum: this.context.settings.strictImeiChecksum };

      if (tracking === 'IMEI') {
        const check = checkImei(draft.imei1 ?? '', imeiOptions);
        if (!check.valid) {
          throw new BusinessError(`Ligne ${line} — IMEI : ${check.message ?? 'invalide'}`);
        }
      }
      if (tracking === 'SERIAL' && normalizeSerial(draft.serial ?? '') === '') {
        throw new BusinessError(`Ligne ${line} — le numéro de série est obligatoire.`);
      }

      const id = newId();
      let identifiers: ReturnType<typeof buildIdentifiers>;
      try {
        identifiers = buildIdentifiers(draft, imeiOptions);
      } catch (cause) {
        throw new BusinessError(
          `Ligne ${line} — ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }

      for (const identifier of identifiers) {
        const previous = seen.get(identifier.value);
        if (previous !== undefined) {
          throw new BusinessError(
            `Ligne ${line} — ${identifier.value} apparaît déjà à la ligne ${previous}.`,
          );
        }
        seen.set(identifier.value, line);
      }
      return { id, draft, identifiers };
    });
  }

  /** Refuse un lot dont un identifiant existe déjà, en nommant le fautif. */
  private async assertIdentifiersFree(
    identifiers: { kind: string; value: string }[],
  ): Promise<void> {
    if (identifiers.length === 0) return;
    const existing = await this.units.existingIdentifiers(
      identifiers.map((identifier) => identifier.value),
    );
    const clash = identifiers.find((identifier) => existing.has(identifier.value));
    if (!clash) return;

    const owner = await this.units.byIdentifier(clash.value);
    const where = owner ? ` (appareil ${owner.id.slice(0, 8)}, statut ${owner.status})` : '';
    throw new BusinessError(
      clash.kind === 'IMEI'
        ? `L'IMEI ${clash.value} est déjà enregistré${where}.`
        : `Le numéro de série ${clash.value} est déjà enregistré${where}.`,
      'DUPLICATE_IDENTIFIER',
    );
  }

  /**
   * Empêche une sortie qui rendrait le stock négatif, sauf si les paramètres
   * l'autorisent explicitement (§33). Un stock négatif sur des appareils
   * identifiés signale presque toujours une erreur de saisie qu'il vaut mieux
   * corriger tout de suite que découvrir à l'inventaire.
   */
  private async assertNotNegative(
    tracking: Tracking,
    productId: string,
    delta: number,
    unitId: string | null,
  ): Promise<void> {
    if (delta >= 0 || unitId) return;
    if (this.context.settings.allowNegativeStock) return;
    if (tracking !== 'QUANTITY') return;

    const level = await this.stock.levelOf(productId, this.context.shopId);
    if (level.quantity + delta < 0) {
      throw new BusinessError(
        `Stock insuffisant : ${level.quantity} en stock, ${Math.abs(delta)} demandés.`,
        'INSUFFICIENT_STOCK',
      );
    }
  }
}

/** Lecture seule du stock : partagée par les écrans et les rapports. */
export class StockQueries {
  private readonly stock: StockRepository;
  private readonly units: UnitRepository;

  constructor(private readonly db: SqlExecutor) {
    this.stock = new StockRepository(db);
    this.units = new UnitRepository(db);
  }

  movements(query: Parameters<StockRepository['list']>[0]) {
    return this.stock.list(query);
  }

  unitHistory(unitId: string) {
    return this.stock.unitHistory(unitId);
  }

  statusBreakdown(shopId: string) {
    return this.units.statusBreakdown(shopId);
  }

  /** Valeur du stock au coût d'acquisition, pour le tableau de bord. */
  async stockValue(
    shopId: string,
  ): Promise<{ units: number; unitsValue: number; quantityValue: number }> {
    const unitRows = await this.db.select<{ total: number; value: number }>(
      `SELECT COUNT(*) AS total, COALESCE(SUM(cost_price), 0) AS value
       FROM product_unit
       WHERE shop_id = ? AND deleted_at IS NULL AND status IN ('IN_STOCK', 'RESERVED', 'RETURNED')`,
      [shopId],
    );
    const quantityRows = await this.db.select<{ value: number }>(
      `SELECT COALESCE(SUM(sl.quantity * p.purchase_price), 0) AS value
       FROM stock_level sl
       JOIN product p ON p.id = sl.product_id
       WHERE sl.shop_id = ? AND sl.quantity > 0 AND p.deleted_at IS NULL`,
      [shopId],
    );
    return {
      units: unitRows[0]?.total ?? 0,
      unitsValue: unitRows[0]?.value ?? 0,
      quantityValue: quantityRows[0]?.value ?? 0,
    };
  }
}
