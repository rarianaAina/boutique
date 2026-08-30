import {
  MOVEMENT_TYPE,
  PERMISSIONS,
  SALE_STATUS,
  SYNC_EVENT,
  UNIT_STATUS,
  nowIso,
} from '@boutique/shared';
import type { Money, SaleLine } from '@boutique/shared';
import { SaleRepository } from '../db/repositories/sale.repository';
import { RefundRepository, type RefundLineDraft } from '../db/repositories/refund.repository';
import { StockRepository } from '../db/repositories/stock.repository';
import { UnitRepository } from '../db/repositories/unit.repository';
import { CounterRepository } from '../db/repositories/counter.repository';
import { OutboxRepository } from '../db/repositories/outbox.repository';
import { AUDIT_ACTIONS } from '../db/repositories/audit.repository';
import { AuditService } from './audit.service';
import { BusinessError, assertCan, type AppContext } from './context';

/**
 * Remboursements (§16).
 *
 * Deux garde-fous portent tout le module :
 *
 *  1. ON NE REMBOURSE PAS PLUS QU'ON N'A ENCAISSÉ. Le plafond est le montant
 *     réellement payé sur la vente, diminué de ce qui a déjà été remboursé.
 *     Rembourser deux fois la même vente est l'erreur la plus coûteuse d'un
 *     comptoir, et elle passe inaperçue si rien ne l'empêche.
 *
 *  2. ON NE REMBOURSE PAS PLUS D'ARTICLES QU'IL N'EN A ÉTÉ VENDU. Chaque ligne
 *     de vente porte sa quantité déjà remboursée ; c'est elle qui borne les
 *     retours suivants.
 *
 * Le retour en stock est un CHOIX par ligne : un téléphone rendu cassé est
 * remboursé sans revenir au stock vendable — il passe en défectueux.
 */

export interface RefundLineInput {
  saleLineId: string;
  quantity: number;
  /** Montant rendu. Par défaut, la part proportionnelle de la ligne. */
  amount?: Money;
  /** L'article revient-il en stock vendable ? */
  restock?: boolean;
}

export interface RefundInput {
  saleId: string;
  lines: RefundLineInput[];
  method: string;
  reason?: string | null;
}

export interface RefundResult {
  refundId: string;
  number: string;
  total: Money;
}

export class RefundService {
  private readonly sales: SaleRepository;
  private readonly audit: AuditService;

  constructor(private readonly context: AppContext) {
    this.sales = new SaleRepository(context.db);
    this.audit = new AuditService(context);
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    assertCan(this.context, PERMISSIONS.refundCreate);
    const userId = this.context.session?.id;
    if (!userId) throw new BusinessError('Session requise.');

    const detail = await this.sales.detail(input.saleId);
    if (!detail) throw new BusinessError('Vente introuvable.');
    if (detail.sale.status === SALE_STATUS.cancelled) {
      throw new BusinessError("Une vente annulée n'a rien à rembourser.");
    }
    if (input.lines.length === 0) throw new BusinessError('Aucun article à rembourser.');

    const byId = new Map(detail.lines.map((line) => [line.id, line]));
    const drafts: RefundLineDraft[] = [];
    const seen = new Set<string>();

    for (const line of input.lines) {
      if (seen.has(line.saleLineId)) {
        throw new BusinessError('La même ligne figure deux fois dans le remboursement.');
      }
      seen.add(line.saleLineId);

      const saleLine = byId.get(line.saleLineId);
      if (!saleLine) throw new BusinessError('Ligne de vente introuvable.');
      if (line.quantity <= 0) throw new BusinessError('La quantité rendue doit être positive.');

      const remaining = saleLine.quantity - saleLine.refundedQuantity;
      if (line.quantity > remaining) {
        throw new BusinessError(
          `« ${saleLine.label} » : ${line.quantity} rendus pour ${remaining} remboursables.`,
          'OVER_REFUND',
        );
      }

      const amount = line.amount ?? proportionalAmount(saleLine, line.quantity);
      if (amount < 0) throw new BusinessError('Un remboursement négatif ne veut rien dire.');
      const maxAmount = proportionalAmount(saleLine, remaining);
      if (amount > maxAmount) {
        throw new BusinessError(
          `« ${saleLine.label} » : montant supérieur à la part remboursable (${maxAmount}).`,
          'OVER_REFUND',
        );
      }

      drafts.push({
        saleLineId: saleLine.id,
        productId: saleLine.productId,
        unitId: saleLine.unitId,
        quantity: line.quantity,
        amount,
        restock: line.restock ?? true,
      });
    }

    const total = drafts.reduce((sum, line) => sum + line.amount, 0);
    const alreadyRefunded = await this.sales.refundedTotal(input.saleId);
    const refundable = detail.sale.total - alreadyRefunded;
    if (total > refundable) {
      throw new BusinessError(
        `Remboursement supérieur au montant restant : ${total} demandés, ${refundable} disponibles.`,
        'OVER_REFUND',
      );
    }

    const number = await new CounterRepository(this.context.db).nextNumber(
      'refund',
      this.context.shopId,
      this.context.shopCode,
      this.context.settings.numbering['refund'],
    );

    const at = nowIso();
    let refundId = '';

    await this.context.db.transaction(async (tx) => {
      refundId = await new RefundRepository(tx).insert(
        tx,
        {
          shopId: this.context.shopId,
          number,
          saleId: input.saleId,
          reason: input.reason ?? null,
          method: input.method,
          total,
          userId,
          refundedAt: at,
        },
        drafts,
      );

      const sales = new SaleRepository(tx);
      const stock = new StockRepository(tx);
      const units = new UnitRepository(tx);

      for (const draft of drafts) {
        await sales.addRefundedQuantity(tx, draft.saleLineId, draft.quantity);

        if (draft.unitId) {
          // L'appareil rendu quitte le statut « vendu ». Remis en vente s'il
          // est en état, marqué défectueux sinon — dans les deux cas il reste
          // rattaché à son historique.
          await units.changeStatus(
            draft.unitId,
            draft.restock ? UNIT_STATUS.returned : UNIT_STATUS.defective,
            [UNIT_STATUS.sold],
            { clearSale: true },
          );
        }

        // L'article revient physiquement : le retour est TOUJOURS écrit.
        await stock.record({
          shopId: this.context.shopId,
          productId: draft.productId,
          unitId: draft.unitId ?? null,
          type: MOVEMENT_TYPE.customerReturn,
          quantity: draft.quantity,
          unitCost: null,
          source: 'REFUND',
          sourceId: refundId,
          sourceLabel: number,
          userId,
          occurredAt: at,
          note: input.reason ?? null,
        });

        // Rendu cassé : il ressort aussitôt du stock vendable. Deux mouvements
        // plutôt qu'un seul net à zéro — l'inventaire doit pouvoir montrer que
        // l'article est revenu ET qu'il a été mis au rebut, pas croire qu'il
        // ne s'est rien passé.
        if (!draft.restock) {
          await stock.record({
            shopId: this.context.shopId,
            productId: draft.productId,
            unitId: draft.unitId ?? null,
            type: MOVEMENT_TYPE.breakage,
            quantity: -draft.quantity,
            unitCost: null,
            source: 'REFUND',
            sourceId: refundId,
            sourceLabel: number,
            userId,
            occurredAt: at,
            note: 'Rendu non remis en vente',
          });
        }
      }

      const refundedAfter = alreadyRefunded + total;
      await sales.setStatus(
        tx,
        input.saleId,
        refundedAfter >= detail.sale.total ? SALE_STATUS.refunded : SALE_STATUS.partiallyRefunded,
      );

      await new OutboxRepository(tx).enqueue({
        type: SYNC_EVENT.refundRecorded,
        entity: 'refund',
        entityId: refundId,
        shopId: this.context.shopId,
        userId,
        payload: {
          refundId,
          number,
          saleId: input.saleId,
          total,
          method: input.method,
          lines: drafts.map((draft) => ({
            unitId: draft.unitId ?? null,
            productId: draft.productId,
            quantity: draft.quantity,
            amount: draft.amount,
            restock: draft.restock,
          })),
        },
      });

      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.refund,
        entity: 'sale',
        entityId: input.saleId,
        after: { remboursement: number, total, motif: input.reason ?? null },
      });
    });

    return { refundId, number, total };
  }

  /** Ce qu'il reste remboursable sur une vente : montant et articles. */
  async refundable(saleId: string): Promise<{
    amount: Money;
    lines: { line: SaleLine; remaining: number; maxAmount: Money }[];
  }> {
    const detail = await this.sales.detail(saleId);
    if (!detail) throw new BusinessError('Vente introuvable.');
    const alreadyRefunded = await this.sales.refundedTotal(saleId);
    return {
      amount: Math.max(0, detail.sale.total - alreadyRefunded),
      lines: detail.lines
        .map((line) => {
          const remaining = line.quantity - line.refundedQuantity;
          return { line, remaining, maxAmount: proportionalAmount(line, remaining) };
        })
        .filter((entry) => entry.remaining > 0),
    };
  }
}

/**
 * Part d'une ligne correspondant à une quantité rendue.
 *
 * Calculée sur le total NET de la ligne (remise déduite) : rembourser le prix
 * catalogue d'un article vendu remisé rendrait plus que ce que le client a payé.
 */
export function proportionalAmount(line: SaleLine, quantity: number): Money {
  if (line.quantity <= 0) return 0;
  const capped = Math.min(quantity, line.quantity);
  return Math.round((line.lineTotal * capped) / line.quantity);
}
