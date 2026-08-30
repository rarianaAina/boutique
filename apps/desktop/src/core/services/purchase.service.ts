import { PERMISSIONS, PURCHASE_STATUS, allocate, nowIso } from '@boutique/shared';
import type {
  CostAllocation,
  LandedCostKind,
  Money,
  PurchaseLine,
  PurchaseStatus,
} from '@boutique/shared';
import {
  PurchaseRepository,
  computeTotals,
  type PurchaseLineInput,
} from '../db/repositories/purchase.repository';
import { ProductRepository } from '../db/repositories/product.repository';
import { CounterRepository } from '../db/repositories/counter.repository';
import { PriceHistoryRepository } from '../db/repositories/price-history.repository';
import { AUDIT_ACTIONS } from '../db/repositories/audit.repository';
import { AuditService } from './audit.service';
import { StockService, type UnitDraft } from './stock.service';
import { BusinessError, assertCan, type AppContext } from './context';

/**
 * Achats et réceptions (§10).
 *
 * Cycle : Brouillon -> Commandé -> Réception partielle -> Réception complète ->
 * Clôturé. Chaque passage est explicite ; on ne devine jamais l'état d'un achat
 * à partir des quantités reçues, sauf pour distinguer « partielle » de
 * « complète », où la comparaison est justement le critère.
 *
 * COÛT RÉEL D'ACQUISITION (§11) : les frais logistiques sont ventilés sur les
 * lignes, et c'est le coût VENTILÉ qui est porté par chaque unité entrée en
 * stock. C'est la seule façon d'avoir une marge juste : un téléphone acheté
 * 2 400 000 dont le transport et la douane ajoutent 60 000 n'a pas coûté
 * 2 400 000.
 */

export interface CreatePurchaseInput {
  supplierId: string;
  supplierReference?: string | null;
  expectedAt?: string | null;
  notes?: string | null;
  lines: PurchaseLineInput[];
}

/** Ce qui est réellement arrivé, ligne par ligne. */
export interface ReceiptLineInput {
  purchaseLineId: string;
  quantity: number;
  /** Pour les produits suivis à l'unité : un exemplaire par appareil reçu. */
  units?: UnitDraft[];
}

export class PurchaseService {
  private readonly purchases: PurchaseRepository;
  private readonly products: ProductRepository;
  private readonly audit: AuditService;

  constructor(private readonly context: AppContext) {
    this.purchases = new PurchaseRepository(context.db);
    this.products = new ProductRepository(context.db);
    this.audit = new AuditService(context);
  }

  async create(input: CreatePurchaseInput): Promise<string> {
    assertCan(this.context, PERMISSIONS.purchaseCreate);
    if (input.lines.length === 0)
      throw new BusinessError('Un achat doit comporter au moins une ligne.');
    for (const line of input.lines) {
      if (line.quantity <= 0) throw new BusinessError(`Quantité invalide pour « ${line.label} ».`);
      if (line.unitPrice < 0) throw new BusinessError(`Prix invalide pour « ${line.label} ».`);
    }

    const userId = this.context.session?.id;
    if (!userId) throw new BusinessError('Session requise.');

    const number = await new CounterRepository(this.context.db).nextNumber(
      'purchase',
      this.context.shopId,
      this.context.shopCode,
      this.context.settings.numbering['purchase'],
    );

    let purchaseId = '';
    await this.context.db.transaction(async (tx) => {
      purchaseId = await new PurchaseRepository(tx).create(
        tx,
        {
          shopId: this.context.shopId,
          number,
          supplierId: input.supplierId,
          supplierReference: input.supplierReference ?? null,
          expectedAt: input.expectedAt ?? null,
          notes: input.notes ?? null,
          createdBy: userId,
        },
        input.lines,
      );
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.purchase,
        entity: 'purchase',
        entityId: purchaseId,
        after: { numero: number, fournisseur: input.supplierId, lignes: input.lines.length },
      });
    });
    return purchaseId;
  }

  async updateLines(purchaseId: string, lines: PurchaseLineInput[]): Promise<void> {
    assertCan(this.context, PERMISSIONS.purchaseCreate);
    const purchase = await this.purchases.byId(purchaseId);
    if (!purchase) throw new BusinessError('Achat introuvable.');
    if (purchase.status !== PURCHASE_STATUS.draft) {
      throw new BusinessError(
        "Les lignes d'un achat déjà commandé ne se modifient plus : créez un avoir ou un nouvel achat.",
      );
    }

    await this.context.db.transaction(async (tx) => {
      await new PurchaseRepository(tx).replaceLines(tx, purchaseId, lines);
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.update,
        entity: 'purchase',
        entityId: purchaseId,
        after: { lignes: lines.length, total: computeTotals(lines).total },
      });
    });
    await this.reallocate(purchaseId);
  }

  /** Passage à « Commandé » : l'achat est envoyé au fournisseur. */
  async markOrdered(purchaseId: string): Promise<void> {
    assertCan(this.context, PERMISSIONS.purchaseCreate);
    const purchase = await this.purchases.byId(purchaseId);
    if (!purchase) throw new BusinessError('Achat introuvable.');
    if (purchase.status !== PURCHASE_STATUS.draft) {
      throw new BusinessError('Seul un brouillon peut être commandé.');
    }
    const lines = await this.purchases.lines(purchaseId);
    if (lines.length === 0) throw new BusinessError('Un achat vide ne peut pas être commandé.');

    await this.context.db.transaction(async (tx) => {
      await new PurchaseRepository(tx).setStatus(tx, purchaseId, PURCHASE_STATUS.ordered, nowIso());
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.purchase,
        entity: 'purchase',
        entityId: purchaseId,
        before: { statut: purchase.status },
        after: { statut: PURCHASE_STATUS.ordered },
      });
    });
  }

  /* ─── Coûts logistiques ───────────────────────────────────────────────── */

  async addLandedCost(
    purchaseId: string,
    input: {
      kind: LandedCostKind;
      label?: string | null;
      amount: Money;
      allocation?: CostAllocation;
    },
  ): Promise<void> {
    assertCan(this.context, PERMISSIONS.landedCostManage);
    if (input.amount <= 0) throw new BusinessError('Le montant doit être positif.');
    const purchase = await this.purchases.byId(purchaseId);
    if (!purchase) throw new BusinessError('Achat introuvable.');

    await this.context.db.transaction(async (tx) => {
      await new PurchaseRepository(tx).addCost(tx, purchaseId, input);
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.update,
        entity: 'purchase',
        entityId: purchaseId,
        after: { fraisAjoute: input.kind, montant: input.amount },
      });
    });
    await this.reallocate(purchaseId);
  }

  async removeLandedCost(purchaseId: string, costId: string): Promise<void> {
    assertCan(this.context, PERMISSIONS.landedCostManage);
    await this.context.db.transaction(async (tx) => {
      await new PurchaseRepository(tx).removeCost(tx, costId);
    });
    await this.reallocate(purchaseId);
  }

  /**
   * Recalcule la ventilation des frais sur les lignes.
   *
   * Deux clés possibles par frais : au prorata de la VALEUR (une douane suit le
   * prix) ou des QUANTITÉS (un transport suit le volume). La répartition ne perd
   * pas une seule unité monétaire : `allocate` attribue les restes selon la
   * méthode du plus fort reste, et la somme des parts égale exactement le total
   * des frais — un comptable peut la refaire à la main.
   */
  async reallocate(purchaseId: string): Promise<{ lineId: string; allocatedCost: Money }[]> {
    const [lines, costs] = await Promise.all([
      this.purchases.lines(purchaseId),
      this.purchases.costs(purchaseId),
    ]);
    if (lines.length === 0) return [];

    const totals = new Map<string, number>(lines.map((line) => [line.id, 0]));
    for (const cost of costs) {
      const weights = lines.map((line) =>
        cost.allocation === 'BY_QUANTITY' ? line.quantity : line.lineTotal,
      );
      const parts = allocate(cost.amount, weights);
      lines.forEach((line, index) => {
        totals.set(line.id, (totals.get(line.id) ?? 0) + (parts[index] ?? 0));
      });
    }

    const allocation = lines.map((line) => ({
      lineId: line.id,
      allocatedCost: totals.get(line.id) ?? 0,
    }));
    const landedTotal = costs.reduce((sum, cost) => sum + cost.amount, 0);

    await this.context.db.transaction(async (tx) => {
      await new PurchaseRepository(tx).applyAllocation(tx, purchaseId, allocation, landedTotal);
    });
    return allocation;
  }

  /* ─── Réception ───────────────────────────────────────────────────────── */

  /**
   * Réception de marchandise.
   *
   * Elle fait entrer le stock, crée les unités et leurs IMEI, écrit les
   * mouvements et fait avancer le statut de l'achat — en une seule opération
   * cohérente. Une réception à moitié appliquée est le pire état possible : le
   * fournisseur est payé, la marchandise est là, et le logiciel ne le sait pas.
   */
  async receive(
    purchaseId: string,
    lines: ReceiptLineInput[],
    note?: string | null,
  ): Promise<{ receiptId: string; unitIds: string[] }> {
    assertCan(this.context, PERMISSIONS.purchaseReceive);
    const userId = this.context.session?.id;
    if (!userId) throw new BusinessError('Session requise.');

    const detail = await this.purchases.detail(purchaseId);
    if (!detail) throw new BusinessError('Achat introuvable.');
    if (
      detail.purchase.status === PURCHASE_STATUS.draft ||
      detail.purchase.status === PURCHASE_STATUS.cancelled ||
      detail.purchase.status === PURCHASE_STATUS.closed
    ) {
      throw new BusinessError(
        `Un achat au statut « ${detail.purchase.status} » ne peut pas être réceptionné.`,
      );
    }

    const byId = new Map(detail.lines.map((line) => [line.id, line]));
    const requested = lines.filter((line) => line.quantity > 0);
    if (requested.length === 0) throw new BusinessError('Aucune quantité à réceptionner.');

    // Tout est validé avant la moindre écriture : quantités, appareils, IMEI.
    for (const line of requested) {
      const purchaseLine = byId.get(line.purchaseLineId);
      if (!purchaseLine) throw new BusinessError("Ligne d'achat introuvable.");
      const remaining = purchaseLine.quantity - purchaseLine.receivedQuantity;
      if (line.quantity > remaining) {
        throw new BusinessError(
          `« ${purchaseLine.label} » : ${line.quantity} reçus pour ${remaining} attendus.`,
        );
      }
      const product = await this.products.byId(purchaseLine.productId);
      if (!product) throw new BusinessError('Produit introuvable.');
      if (product.tracking !== 'QUANTITY') {
        const provided = line.units?.length ?? 0;
        if (provided !== line.quantity) {
          throw new BusinessError(
            `« ${purchaseLine.label} » : ${line.quantity} appareils annoncés mais ${provided} identifiants saisis.`,
          );
        }
      }
    }

    // Le coût unitaire réel de la ligne, frais logistiques ventilés compris.
    const unitCostOf = (line: PurchaseLine): Money =>
      line.quantity > 0
        ? Math.round((line.lineTotal + line.allocatedCost) / line.quantity)
        : line.unitPrice;

    let receiptId = '';
    await this.context.db.transaction(async (tx) => {
      // Le prix RÉELLEMENT payé est consigné à la réception, pas à la commande :
      // c'est là qu'on connaît le coût complet, frais logistiques ventilés
      // compris. C'est ce chiffre — et non le prix catalogue — qui reflète le
      // cours du fournisseur.
      const historique = new PriceHistoryRepository(tx);
      for (const ligne of requested) {
        const purchaseLine = byId.get(ligne.purchaseLineId);
        if (!purchaseLine) continue;
        await historique.record({
          productId: purchaseLine.productId,
          kind: 'OBSERVED_PURCHASE',
          newValue: unitCostOf(purchaseLine),
          source: 'PURCHASE',
          sourceId: purchaseId,
          sourceLabel: detail.purchase.number,
          supplierId: detail.purchase.supplierId,
          shopId: this.context.shopId,
          userId,
          userLabel: this.context.session?.fullName ?? null,
          note:
            purchaseLine.allocatedCost > 0
              ? `Frais logistiques ventilés inclus (${purchaseLine.allocatedCost}).`
              : null,
        });
      }

      receiptId = await new PurchaseRepository(tx).recordReceipt(
        tx,
        { purchaseId, shopId: this.context.shopId, userId, note: note ?? null },
        requested.map((line) => ({
          purchaseLineId: line.purchaseLineId,
          quantity: line.quantity,
        })),
      );
    });

    const stock = new StockService(this.context);
    const unitIds: string[] = [];

    for (const line of requested) {
      const purchaseLine = byId.get(line.purchaseLineId);
      if (!purchaseLine) continue;
      const product = await this.products.byId(purchaseLine.productId);
      if (!product) continue;
      const cost = unitCostOf(purchaseLine);

      if (product.tracking === 'QUANTITY') {
        await stock.receiveQuantity({
          productId: product.id,
          quantity: line.quantity,
          unitCost: cost,
          source: 'PURCHASE',
          sourceId: purchaseId,
          sourceLabel: detail.purchase.number,
          note: note ?? null,
        });
      } else {
        const created = await stock.receiveUnits({
          productId: product.id,
          units: (line.units ?? []).map((unit) => ({ ...unit, costPrice: unit.costPrice ?? cost })),
          supplierId: detail.purchase.supplierId,
          purchaseId,
          source: 'PURCHASE',
          sourceId: purchaseId,
          sourceLabel: detail.purchase.number,
          note: note ?? null,
        });
        unitIds.push(...created);
      }
    }

    await this.refreshStatus(purchaseId);
    await this.context.db.transaction(async (tx) => {
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.receipt,
        entity: 'purchase',
        entityId: purchaseId,
        after: {
          reception: receiptId,
          lignes: requested.length,
          quantite: requested.reduce((sum, line) => sum + line.quantity, 0),
        },
      });
    });

    return { receiptId, unitIds };
  }

  /** Aligne le statut sur ce qui a réellement été reçu. */
  private async refreshStatus(purchaseId: string): Promise<PurchaseStatus> {
    const lines = await this.purchases.lines(purchaseId);
    const ordered = lines.reduce((sum, line) => sum + line.quantity, 0);
    const received = lines.reduce((sum, line) => sum + line.receivedQuantity, 0);

    const status: PurchaseStatus =
      received === 0
        ? PURCHASE_STATUS.ordered
        : received >= ordered
          ? PURCHASE_STATUS.received
          : PURCHASE_STATUS.partiallyReceived;

    await this.context.db.transaction(async (tx) => {
      await new PurchaseRepository(tx).setStatus(tx, purchaseId, status);
    });
    return status;
  }

  /**
   * Clôture : l'achat est soldé, même si tout n'est pas arrivé.
   *
   * C'est le cas courant d'un reliquat jamais livré : sans clôture explicite,
   * l'achat resterait indéfiniment « en réception partielle » et polluerait le
   * tableau de bord.
   */
  async close(purchaseId: string, reason?: string | null): Promise<void> {
    assertCan(this.context, PERMISSIONS.purchaseCreate);
    const purchase = await this.purchases.byId(purchaseId);
    if (!purchase) throw new BusinessError('Achat introuvable.');
    if (purchase.status === PURCHASE_STATUS.draft) {
      throw new BusinessError('Un brouillon se supprime, il ne se clôture pas.');
    }

    await this.context.db.transaction(async (tx) => {
      await new PurchaseRepository(tx).setStatus(tx, purchaseId, PURCHASE_STATUS.closed);
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.purchase,
        entity: 'purchase',
        entityId: purchaseId,
        before: { statut: purchase.status },
        after: { statut: PURCHASE_STATUS.closed, motif: reason ?? null },
      });
    });
  }

  /** Annulation d'un achat non réceptionné. */
  async cancel(purchaseId: string, reason: string): Promise<void> {
    assertCan(this.context, PERMISSIONS.purchaseCreate);
    const purchase = await this.purchases.byId(purchaseId);
    if (!purchase) throw new BusinessError('Achat introuvable.');

    const lines = await this.purchases.lines(purchaseId);
    if (lines.some((line) => line.receivedQuantity > 0)) {
      throw new BusinessError(
        "Cet achat a déjà reçu de la marchandise : clôturez-le plutôt que de l'annuler.",
      );
    }

    await this.context.db.transaction(async (tx) => {
      await new PurchaseRepository(tx).setStatus(tx, purchaseId, PURCHASE_STATUS.cancelled);
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.purchase,
        entity: 'purchase',
        entityId: purchaseId,
        before: { statut: purchase.status },
        after: { statut: PURCHASE_STATUS.cancelled, motif: reason },
      });
    });
  }
}
