import {
  MOVEMENT_TYPE,
  PERMISSIONS,
  SALE_STATUS,
  SELLABLE_UNIT_STATUSES,
  SYNC_EVENT,
  UNIT_STATUS,
  applyRate,
  nowIso,
} from '@boutique/shared';
import type { Money, Product, ProductUnit } from '@boutique/shared';
import {
  SaleRepository,
  type PaymentDraft,
  type SaleLineDraft,
} from '../db/repositories/sale.repository';
import { ProductRepository } from '../db/repositories/product.repository';
import { UnitRepository } from '../db/repositories/unit.repository';
import { StockRepository } from '../db/repositories/stock.repository';
import { CounterRepository } from '../db/repositories/counter.repository';
import { OutboxRepository } from '../db/repositories/outbox.repository';
import { AUDIT_ACTIONS } from '../db/repositories/audit.repository';
import { AuditService } from './audit.service';
import { BusinessError, assertCan, mayNot, type AppContext } from './context';
import { fifoUnitCost } from './cost.service';

/**
 * Encaissement (§12).
 *
 * UNE vente = UNE transaction. Sont écrits ensemble, ou pas du tout : le
 * ticket, ses lignes, ses règlements, les mouvements de stock, le changement de
 * statut des appareils, l'événement de synchronisation et l'audit. Toute autre
 * répartition laisserait la porte ouverte à un téléphone marqué vendu sur un
 * ticket qui n'existe pas — ou l'inverse, bien pire.
 *
 * DOUBLE VENTE D'UN MÊME APPAREIL : elle est empêchée à deux niveaux. Le
 * service vérifie le statut avant d'écrire (message clair au vendeur), et la
 * mise à jour est conditionnée par `WHERE status IN ('IN_STOCK', 'RETURNED')`,
 * si bien que deux fenêtres qui encaisseraient le même IMEI au même instant ne
 * peuvent pas toutes les deux réussir.
 */

export interface CartLine {
  productId: string;
  /** Obligatoire pour un produit suivi par IMEI ou numéro de série. */
  unitId?: string | null;
  quantity: number;
  /** Prix négocié. Absent : le prix de vente du catalogue s'applique. */
  unitPrice?: Money;
  discount?: Money;
}

export interface CheckoutInput {
  lines: CartLine[];
  payments: PaymentDraft[];
  customerId?: string | null;
  note?: string | null;
  /** Monnaie rendue, pour reproduire le ticket à l'identique. */
  changeGiven?: Money;
  soldAt?: string;
  /**
   * Vente issue d'un autre document (reprise d'échange).
   *
   * Elle porte une remise égale à la valeur de l'appareil repris, que le
   * vendeur n'a pas « accordée » : la permission qui l'autorise est celle de
   * l'échange, déjà vérifiée par le service appelant. Sans cette distinction,
   * un caissier autorisé à échanger mais pas à remiser ne pourrait pas
   * enregistrer une reprise.
   */
  fromExchange?: boolean;
}

export interface CheckoutResult {
  saleId: string;
  number: string;
  total: Money;
  paid: Money;
  change: Money;
}

/** Ligne prête à écrire : produit et unité résolus, prix arrêtés. */
interface ResolvedLine extends SaleLineDraft {
  product: Product;
  unit: ProductUnit | null;
}

export class SaleService {
  private readonly sales: SaleRepository;
  private readonly products: ProductRepository;
  private readonly units: UnitRepository;
  private readonly stock: StockRepository;
  private readonly audit: AuditService;

  constructor(private readonly context: AppContext) {
    this.sales = new SaleRepository(context.db);
    this.products = new ProductRepository(context.db);
    this.units = new UnitRepository(context.db);
    this.stock = new StockRepository(context.db);
    this.audit = new AuditService(context);
  }

  async checkout(input: CheckoutInput): Promise<CheckoutResult> {
    assertCan(this.context, PERMISSIONS.saleCreate);
    const userId = this.context.session?.id;
    if (!userId) throw new BusinessError('Session requise.');
    if (input.lines.length === 0) throw new BusinessError('Le panier est vide.');

    const resolved = await this.resolveLines(input.lines, input.fromExchange ?? false);
    const totals = computeSaleTotals(resolved);
    const paid = input.payments.reduce((sum, payment) => sum + payment.amount, 0);

    // Un total nul se passe de règlement : c'est le cas d'un échange à valeur
    // égale, où la reprise couvre exactement le nouvel appareil.
    if (input.payments.length === 0 && totals.total > 0) {
      throw new BusinessError('Aucun règlement saisi.');
    }
    if (paid < totals.total) {
      throw new BusinessError(
        `Règlement insuffisant : ${paid} encaissés pour ${totals.total} dus.`,
        'UNDERPAID',
      );
    }
    await this.assertPaymentMethods(input.payments);

    const number = await new CounterRepository(this.context.db).nextNumber(
      'sale',
      this.context.shopId,
      this.context.shopCode,
      this.context.settings.numbering['sale'],
    );

    const soldAt = input.soldAt ?? nowIso();
    const change = input.changeGiven ?? Math.max(0, paid - totals.total);
    let saleId = '';

    await this.context.db.transaction(async (tx) => {
      const sales = new SaleRepository(tx);
      const stock = new StockRepository(tx);
      const unitRepository = new UnitRepository(tx);
      const outbox = new OutboxRepository(tx);

      saleId = await sales.insert(
        tx,
        {
          shopId: this.context.shopId,
          number,
          customerId: input.customerId ?? null,
          userId,
          soldAt,
          note: input.note ?? null,
          changeGiven: change,
        },
        resolved,
        input.payments,
        { ...totals, paid },
      );

      for (const line of resolved) {
        if (line.unit) {
          // La garde est ici, pas dans une lecture préalable : deux fenêtres
          // qui vendraient le même appareil ne peuvent pas réussir toutes deux.
          await unitRepository.changeStatus(
            line.unit.id,
            UNIT_STATUS.sold,
            SELLABLE_UNIT_STATUSES,
            { saleId, soldAt },
          );
        }
        await stock.record({
          shopId: this.context.shopId,
          productId: line.productId,
          unitId: line.unitId ?? null,
          type: MOVEMENT_TYPE.sale,
          quantity: -line.quantity,
          unitCost: line.unitCost ?? 0,
          source: 'SALE',
          sourceId: saleId,
          sourceLabel: number,
          userId,
          occurredAt: soldAt,
        });
      }

      await outbox.enqueue({
        type: SYNC_EVENT.stockSold,
        entity: 'sale',
        entityId: saleId,
        shopId: this.context.shopId,
        userId,
        payload: {
          saleId,
          number,
          shopId: this.context.shopId,
          soldAt,
          total: totals.total,
          customerId: input.customerId ?? null,
          lines: resolved.map((line) => ({
            productId: line.productId,
            unitId: line.unitId ?? null,
            identifier: line.identifier ?? null,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            discount: line.discount ?? 0,
          })),
        },
      });

      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.sale,
        entity: 'sale',
        entityId: saleId,
        after: {
          numero: number,
          total: totals.total,
          lignes: resolved.length,
          appareils: resolved.filter((line) => line.unitId).map((line) => line.identifier),
        },
      });
    });

    return { saleId, number, total: totals.total, paid, change };
  }

  /**
   * Annulation d'une vente.
   *
   * La vente n'est PAS supprimée (§27) : son statut passe à « Annulée », les
   * appareils retournent en stock et des mouvements inverses sont écrits. Un
   * ticket annulé reste consultable, avec la trace de qui l'a annulé et quand.
   */
  async cancel(saleId: string, reason: string): Promise<void> {
    assertCan(this.context, PERMISSIONS.saleCancel);
    const userId = this.context.session?.id;
    if (!userId) throw new BusinessError('Session requise.');
    if (reason.trim() === '') throw new BusinessError("Le motif d'annulation est obligatoire.");

    const detail = await this.sales.detail(saleId);
    if (!detail) throw new BusinessError('Vente introuvable.');
    if (detail.sale.status === SALE_STATUS.cancelled) {
      throw new BusinessError('Cette vente est déjà annulée.');
    }
    if ((await this.sales.refundedTotal(saleId)) > 0) {
      throw new BusinessError(
        'Cette vente a déjà été remboursée : son annulation ferait double emploi.',
      );
    }

    const at = nowIso();
    await this.context.db.transaction(async (tx) => {
      const sales = new SaleRepository(tx);
      const stock = new StockRepository(tx);
      const unitRepository = new UnitRepository(tx);

      await sales.setStatus(tx, saleId, SALE_STATUS.cancelled, { at, by: userId });

      for (const line of detail.lines) {
        if (line.unitId) {
          await unitRepository.changeStatus(line.unitId, UNIT_STATUS.inStock, [UNIT_STATUS.sold], {
            clearSale: true,
          });
        }
        await stock.record({
          shopId: detail.sale.shopId,
          productId: line.productId,
          unitId: line.unitId,
          type: MOVEMENT_TYPE.saleCancelled,
          quantity: line.quantity,
          unitCost: line.unitCost,
          source: 'SALE',
          sourceId: saleId,
          sourceLabel: detail.sale.number,
          userId,
          occurredAt: at,
          note: reason,
        });
      }

      await new OutboxRepository(tx).enqueue({
        type: SYNC_EVENT.saleCancelled,
        entity: 'sale',
        entityId: saleId,
        shopId: detail.sale.shopId,
        userId,
        payload: { saleId, number: detail.sale.number, reason, cancelledAt: at },
      });

      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.saleCancel,
        entity: 'sale',
        entityId: saleId,
        before: { statut: detail.sale.status },
        after: { statut: SALE_STATUS.cancelled, motif: reason },
      });
    });
  }

  /* ─── Résolution du panier ────────────────────────────────────────────── */

  /**
   * Transforme un panier en lignes prêtes à écrire.
   *
   * Tout est vérifié ICI, avant la moindre écriture : existence du produit,
   * disponibilité de l'appareil, cohérence entre mode de suivi et quantité,
   * respect du prix plancher, permission de remise. Un panier partiellement
   * encaissé n'existe pas.
   */
  private async resolveLines(lines: CartLine[], fromExchange: boolean): Promise<ResolvedLine[]> {
    const resolved: ResolvedLine[] = [];
    const seenUnits = new Set<string>();
    const requestedQuantities = new Map<string, number>();

    for (const [index, line] of lines.entries()) {
      const position = index + 1;
      if (line.quantity <= 0) throw new BusinessError(`Ligne ${position} : quantité invalide.`);

      const product = await this.products.byId(line.productId);
      if (!product || product.deletedAt) {
        throw new BusinessError(`Ligne ${position} : produit introuvable.`);
      }

      const unitPrice = line.unitPrice ?? product.salePrice;
      const discount = line.discount ?? 0;
      if (unitPrice < 0) throw new BusinessError(`Ligne ${position} : prix négatif.`);
      if (discount < 0) throw new BusinessError(`Ligne ${position} : remise négative.`);
      if (discount > unitPrice * line.quantity) {
        throw new BusinessError(`Ligne ${position} : la remise dépasse le montant de la ligne.`);
      }

      // Une remise, c'est aussi bien une ligne remisée qu'un prix descendu
      // sous le tarif : les deux passent par la même permission.
      const discounted = discount > 0 || unitPrice < product.salePrice;
      if (discounted && !fromExchange && mayNot(this.context, PERMISSIONS.saleDiscount)) {
        throw new BusinessError(
          `Ligne ${position} : vous n'êtes pas autorisé à accorder une remise.`,
          'NO_DISCOUNT',
        );
      }
      const netUnitPrice = unitPrice - Math.round(discount / line.quantity);
      // Le plancher ne s'applique pas à une reprise d'échange : la remise y
      // représente la valeur de l'appareil rendu, pas une négociation.
      if (!fromExchange && product.minPrice !== null && netUnitPrice < product.minPrice) {
        throw new BusinessError(
          `Ligne ${position} : le prix plancher de « ${product.name} » est ${product.minPrice}.`,
          'BELOW_MIN_PRICE',
        );
      }

      if (product.tracking === 'QUANTITY') {
        if (line.unitId) {
          throw new BusinessError(
            `Ligne ${position} : « ${product.name} » n'est pas suivi à l'unité.`,
          );
        }
        const total = (requestedQuantities.get(product.id) ?? 0) + line.quantity;
        requestedQuantities.set(product.id, total);
        await this.assertQuantityAvailable(product, total, position);

        // Le coût d'une sortie non identifiable relève d'une CONVENTION : prix
        // catalogue, ou couches consommées dans l'ordre d'arrivée. Un appareil
        // identifié, lui, porte son propre coût — il n'a besoin d'aucune
        // convention, et n'en emploie aucune.
        const unitCost =
          this.context.settings.costMethod === 'FIFO'
            ? await fifoUnitCost(
                this.context.db,
                product.id,
                this.context.shopId,
                line.quantity,
                product.purchasePrice,
              )
            : product.purchasePrice;

        resolved.push({
          product,
          unit: null,
          productId: product.id,
          label: product.name,
          quantity: line.quantity,
          unitPrice,
          discount,
          taxRate: this.context.settings.taxEnabled ? product.taxRate : null,
          unitCost,
        });
        continue;
      }

      // Produit suivi à l'unité : un exemplaire précis, quantité 1.
      if (!line.unitId) {
        throw new BusinessError(
          `Ligne ${position} : sélectionnez l'appareil à vendre (IMEI ou numéro de série).`,
        );
      }
      if (line.quantity !== 1) {
        throw new BusinessError(
          `Ligne ${position} : un appareil identifié se vend à l'unité — ajoutez une ligne par appareil.`,
        );
      }
      if (seenUnits.has(line.unitId)) {
        throw new BusinessError(`Ligne ${position} : cet appareil figure déjà dans le panier.`);
      }
      seenUnits.add(line.unitId);

      const unit = await this.units.byId(line.unitId);
      if (!unit) throw new BusinessError(`Ligne ${position} : appareil introuvable.`);
      if (unit.shopId !== this.context.shopId) {
        throw new BusinessError(
          `Ligne ${position} : cet appareil se trouve dans une autre boutique.`,
          'WRONG_SHOP',
        );
      }
      if (!SELLABLE_UNIT_STATUSES.includes(unit.status)) {
        throw new BusinessError(
          `Ligne ${position} : cet appareil n'est pas disponible (${unit.status}).`,
          'UNIT_NOT_AVAILABLE',
        );
      }

      resolved.push({
        product,
        unit,
        productId: product.id,
        unitId: unit.id,
        label: product.name,
        identifier: unit.imei1 ?? unit.serial ?? null,
        quantity: 1,
        unitPrice,
        discount,
        taxRate: this.context.settings.taxEnabled ? product.taxRate : null,
        unitCost: unit.costPrice,
      });
    }

    return resolved;
  }

  private async assertQuantityAvailable(
    product: Product,
    requested: number,
    position: number,
  ): Promise<void> {
    if (this.context.settings.allowNegativeStock) return;
    const level = await this.stock.levelOf(product.id, this.context.shopId);
    const available = level.quantity - level.reserved;
    if (requested > available) {
      throw new BusinessError(
        `Ligne ${position} : stock insuffisant pour « ${product.name} » (${available} disponibles).`,
        'INSUFFICIENT_STOCK',
      );
    }
  }

  private async assertPaymentMethods(payments: PaymentDraft[]): Promise<void> {
    const rows = await this.context.db.select<{ code: string }>(
      'SELECT code FROM payment_method WHERE is_active = 1',
    );
    const active = new Set(rows.map((row) => row.code));
    for (const payment of payments) {
      if (payment.amount <= 0) throw new BusinessError('Un règlement doit être positif.');
      if (!active.has(payment.method)) {
        throw new BusinessError(`Mode de paiement inconnu ou désactivé : ${payment.method}.`);
      }
    }
  }
}

/**
 * Totaux d'une vente.
 *
 * Une seule définition, partagée par l'encaissement, l'aperçu du panier et le
 * ticket : trois calculs séparés finiraient par afficher trois totaux.
 */
export function computeSaleTotals(lines: readonly SaleLineDraft[]): {
  subtotal: Money;
  discount: Money;
  tax: Money;
  total: Money;
} {
  let subtotal = 0;
  let discount = 0;
  let tax = 0;
  for (const line of lines) {
    const gross = line.quantity * line.unitPrice;
    const lineDiscount = line.discount ?? 0;
    subtotal += gross;
    discount += lineDiscount;
    if (line.taxRate) tax += applyRate(gross - lineDiscount, line.taxRate);
  }
  return { subtotal, discount, tax, total: subtotal - discount + tax };
}
