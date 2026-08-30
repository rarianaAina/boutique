import {
  MOVEMENT_TYPE,
  PERMISSIONS,
  SALE_STATUS,
  SELLABLE_UNIT_STATUSES,
  SYNC_EVENT,
  UNIT_STATUS,
  nowIso,
} from '@boutique/shared';
import type { Money } from '@boutique/shared';
import { SaleRepository } from '../db/repositories/sale.repository';
import { ExchangeRepository, RefundRepository } from '../db/repositories/refund.repository';
import { UnitRepository } from '../db/repositories/unit.repository';
import { StockRepository } from '../db/repositories/stock.repository';
import { ProductRepository } from '../db/repositories/product.repository';
import { CounterRepository } from '../db/repositories/counter.repository';
import { OutboxRepository } from '../db/repositories/outbox.repository';
import { AUDIT_ACTIONS } from '../db/repositories/audit.repository';
import { AuditService } from './audit.service';
import { SaleService } from './sale.service';
import { proportionalAmount } from './refund.service';
import { BusinessError, assertCan, type AppContext } from './context';

/**
 * Échanges d'appareils (§15).
 *
 * MODÈLE RETENU, et pourquoi.
 *
 * La vente d'origine n'est JAMAIS modifiée : elle reste telle qu'elle a été
 * encaissée, avec son ticket et son total. L'échange est un document distinct
 * qui la référence, et qui produit :
 *
 *   - la reprise de l'ancien appareil, qui revient en stock avec son historique
 *     complet (on sait toujours à qui il avait été vendu) ;
 *   - une NOUVELLE vente pour l'appareil remis au client, portant une remise
 *     égale à la valeur créditée pour l'appareil rendu. Le total de cette vente
 *     est donc exactement la différence à payer.
 *
 * Pourquoi une nouvelle vente plutôt qu'une simple écriture de stock : sans
 * elle, le nouvel appareil n'aurait pas de ticket, pas de client rattaché, et
 * son IMEI n'apparaîtrait dans aucun document de sortie. Le jour où ce client
 * revient avec un problème, plus personne ne saurait d'où vient l'appareil.
 *
 * Quand l'appareil rendu vaut PLUS que le nouveau, la différence ne peut pas
 * devenir une vente négative : la remise est plafonnée au prix du nouvel
 * appareil, et le solde en faveur du client donne lieu à un remboursement
 * rattaché à la vente d'origine — le seul document où cet argent a été encaissé.
 */

export interface ExchangeInput {
  originalSaleId: string;
  /** Appareil rendu par le client. Il doit provenir de cette vente. */
  returnedUnitId: string;
  /** Appareil remis au client. */
  newUnitId: string;
  /** Prix du nouvel appareil. Par défaut, son prix catalogue. */
  newUnitPrice?: Money;
  /** Valeur créditée pour la reprise. Par défaut, ce qui avait été payé. */
  creditedValue?: Money;
  /** Règlement de la différence, quand elle est en faveur de la boutique. */
  settlement?: { method: string; amount: Money; reference?: string | null };
  reason?: string | null;
  /** Le repris revient-il en stock vendable ? Faux s'il est défectueux. */
  restock?: boolean;
}

export interface ExchangeResult {
  exchangeId: string;
  number: string;
  /** Positive : le client complète. Négative : la boutique rembourse. */
  priceDifference: Money;
  newSaleId: string | null;
  refundId: string | null;
}

export class ExchangeService {
  private readonly sales: SaleRepository;
  private readonly units: UnitRepository;
  private readonly products: ProductRepository;
  private readonly audit: AuditService;

  constructor(private readonly context: AppContext) {
    this.sales = new SaleRepository(context.db);
    this.units = new UnitRepository(context.db);
    this.products = new ProductRepository(context.db);
    this.audit = new AuditService(context);
  }

  async exchange(input: ExchangeInput): Promise<ExchangeResult> {
    assertCan(this.context, PERMISSIONS.exchangeCreate);
    const userId = this.context.session?.id;
    if (!userId) throw new BusinessError('Session requise.');

    /* 1. Retrouver la vente d'origine et vérifier que l'appareil en vient. */
    const detail = await this.sales.detail(input.originalSaleId);
    if (!detail) throw new BusinessError("Vente d'origine introuvable.");
    if (detail.sale.status === 'CANCELLED') {
      throw new BusinessError('Une vente annulée ne peut pas donner lieu à un échange.');
    }

    const originalLine = detail.lines.find((line) => line.unitId === input.returnedUnitId);
    if (!originalLine) {
      throw new BusinessError(
        "Cet appareil ne figure pas sur la vente indiquée : vérifiez l'IMEI ou le numéro de ticket.",
        'UNIT_NOT_ON_SALE',
      );
    }
    if (originalLine.refundedQuantity >= originalLine.quantity) {
      throw new BusinessError('Cet appareil a déjà été rendu ou remboursé.');
    }

    const returned = await this.units.byId(input.returnedUnitId);
    if (!returned) throw new BusinessError('Appareil rendu introuvable.');
    if (returned.status !== UNIT_STATUS.sold) {
      throw new BusinessError(
        `L'appareil rendu n'est pas au statut « vendu » (${returned.status}).`,
      );
    }

    /* 2. Vérifier l'appareil remis au client. */
    if (input.newUnitId === input.returnedUnitId) {
      throw new BusinessError('Le nouvel appareil doit être différent de celui repris.');
    }
    const replacement = await this.units.byId(input.newUnitId);
    if (!replacement) throw new BusinessError('Nouvel appareil introuvable.');
    if (replacement.shopId !== this.context.shopId) {
      throw new BusinessError('Le nouvel appareil se trouve dans une autre boutique.');
    }
    if (!SELLABLE_UNIT_STATUSES.includes(replacement.status)) {
      throw new BusinessError(
        `Le nouvel appareil n'est pas disponible (${replacement.status}).`,
        'UNIT_NOT_AVAILABLE',
      );
    }
    const newProduct = await this.products.byId(replacement.productId);
    if (!newProduct) throw new BusinessError('Produit du nouvel appareil introuvable.');

    /* 3. Arrêter les montants. */
    const newPrice = input.newUnitPrice ?? newProduct.salePrice;
    const credited = input.creditedValue ?? proportionalAmount(originalLine, 1);
    if (newPrice < 0 || credited < 0) throw new BusinessError('Montants invalides.');

    const priceDifference = newPrice - credited;
    // La remise ne peut pas dépasser le prix du nouvel appareil : une vente au
    // total négatif n'existe pas. Le reliquat part en remboursement.
    const tradeInDiscount = Math.min(credited, newPrice);
    const refundDue = credited - tradeInDiscount;
    const dueFromCustomer = Math.max(0, priceDifference);

    if (dueFromCustomer > 0) {
      const paid = input.settlement?.amount ?? 0;
      if (!input.settlement || paid < dueFromCustomer) {
        throw new BusinessError(
          `Le client doit compléter de ${dueFromCustomer} : saisissez le règlement.`,
          'SETTLEMENT_REQUIRED',
        );
      }
    }

    const number = await new CounterRepository(this.context.db).nextNumber(
      'exchange',
      this.context.shopId,
      this.context.shopCode,
      this.context.settings.numbering['exchange'],
    );
    const at = nowIso();

    /* 4. Reprise de l'ancien appareil : statut, mouvement, historique. */
    const restock = input.restock ?? true;
    await this.context.db.transaction(async (tx) => {
      await new UnitRepository(tx).changeStatus(
        input.returnedUnitId,
        restock ? UNIT_STATUS.returned : UNIT_STATUS.defective,
        [UNIT_STATUS.sold],
        { clearSale: true, notes: `Repris à l'échange ${number}` },
      );
      await new StockRepository(tx).record({
        shopId: this.context.shopId,
        productId: returned.productId,
        unitId: input.returnedUnitId,
        type: MOVEMENT_TYPE.exchangeIn,
        quantity: 1,
        unitCost: returned.costPrice,
        source: 'EXCHANGE',
        sourceLabel: number,
        userId,
        occurredAt: at,
        note: input.reason ?? null,
      });
      // La ligne d'origine est marquée rendue : elle ne pourra plus être
      // remboursée une seconde fois par un autre guichet.
      await new SaleRepository(tx).addRefundedQuantity(tx, originalLine.id, 1);
    });

    /* 5. Nouvelle vente pour l'appareil remis, remise de reprise incluse. */
    const newSale = await new SaleService(this.context).checkout({
      lines: [
        {
          productId: replacement.productId,
          unitId: replacement.id,
          quantity: 1,
          unitPrice: newPrice,
          discount: tradeInDiscount,
        },
      ],
      payments:
        dueFromCustomer > 0 && input.settlement
          ? [
              {
                method: input.settlement.method,
                amount: input.settlement.amount,
                reference: input.settlement.reference ?? null,
              },
            ]
          : [],
      customerId: detail.sale.customerId,
      note: `Échange ${number} — reprise ${returned.imei1 ?? returned.serial ?? ''}`.trim(),
      fromExchange: true,
    });

    /* 6. Solde en faveur du client : remboursement sur la vente d'origine.
     *
     * Le document de remboursement est écrit ICI plutôt que par le service des
     * remboursements : la reprise a déjà changé le statut de l'appareil et écrit
     * son mouvement d'entrée à l'étape 4. Repasser par le service produirait un
     * second mouvement pour le même appareil, et l'inventaire compterait deux
     * retours pour un seul téléphone. */
    let refundId: string | null = null;
    if (refundDue > 0) {
      const alreadyRefunded = await this.sales.refundedTotal(input.originalSaleId);
      const available = detail.sale.total - alreadyRefunded;
      if (refundDue > available) {
        throw new BusinessError(
          `Le solde à rendre (${refundDue}) dépasse ce qui reste remboursable sur la vente d'origine (${available}).`,
          'OVER_REFUND',
        );
      }

      const refundNumber = await new CounterRepository(this.context.db).nextNumber(
        'refund',
        this.context.shopId,
        this.context.shopCode,
        this.context.settings.numbering['refund'],
      );

      await this.context.db.transaction(async (tx) => {
        refundId = await new RefundRepository(tx).insert(
          tx,
          {
            shopId: this.context.shopId,
            number: refundNumber,
            saleId: input.originalSaleId,
            reason: `Solde de l'échange ${number}`,
            method: input.settlement?.method ?? 'CASH',
            total: refundDue,
            userId,
            refundedAt: at,
          },
          [
            {
              saleLineId: originalLine.id,
              productId: returned.productId,
              unitId: input.returnedUnitId,
              quantity: 1,
              amount: refundDue,
              restock,
            },
          ],
        );
        await new SaleRepository(tx).setStatus(
          tx,
          input.originalSaleId,
          alreadyRefunded + refundDue >= detail.sale.total
            ? SALE_STATUS.refunded
            : SALE_STATUS.partiallyRefunded,
        );
      });
    }

    /* 7. Document d'échange, événement et audit. */
    let exchangeId = '';
    await this.context.db.transaction(async (tx) => {
      exchangeId = await new ExchangeRepository(tx).insert(tx, {
        shopId: this.context.shopId,
        number,
        originalSaleId: input.originalSaleId,
        newSaleId: newSale.saleId,
        returnedUnitId: input.returnedUnitId,
        newUnitId: replacement.id,
        newProductId: replacement.productId,
        priceDifference,
        settledMethod: input.settlement?.method ?? null,
        reason: input.reason ?? null,
        userId,
        exchangedAt: at,
      });

      await new OutboxRepository(tx).enqueue({
        type: SYNC_EVENT.exchangeRecorded,
        entity: 'exchange',
        entityId: exchangeId,
        shopId: this.context.shopId,
        userId,
        payload: {
          exchangeId,
          number,
          originalSaleId: input.originalSaleId,
          newSaleId: newSale.saleId,
          returnedUnitId: input.returnedUnitId,
          newUnitId: replacement.id,
          priceDifference,
          exchangedAt: at,
        },
      });

      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.exchange,
        entity: 'sale',
        entityId: input.originalSaleId,
        after: {
          echange: number,
          repris: returned.imei1 ?? returned.serial,
          remis: replacement.imei1 ?? replacement.serial,
          difference: priceDifference,
        },
      });
    });

    return { exchangeId, number, priceDifference, newSaleId: newSale.saleId, refundId };
  }

  /**
   * Prépare un échange à partir d'un IMEI rendu : retrouve la vente d'origine
   * et la valeur créditée. C'est ce que l'écran appelle dès que le vendeur a
   * scanné l'appareil du client.
   */
  async prepare(identifier: string): Promise<{
    unitId: string;
    saleId: string;
    saleNumber: string;
    soldAt: string;
    customerId: string | null;
    creditedValue: Money;
    productName: string;
  }> {
    const unit = await this.units.byIdentifier(identifier);
    if (!unit) throw new BusinessError('Aucun appareil ne porte cet identifiant.');
    if (!unit.saleId) throw new BusinessError("Cet appareil n'a pas été vendu ici.");

    const detail = await this.sales.detail(unit.saleId);
    if (!detail) throw new BusinessError("Vente d'origine introuvable.");
    const line = detail.lines.find((entry) => entry.unitId === unit.id);
    if (!line) throw new BusinessError('La vente ne référence pas cet appareil.');

    const product = await this.products.byId(unit.productId);
    return {
      unitId: unit.id,
      saleId: detail.sale.id,
      saleNumber: detail.sale.number,
      soldAt: detail.sale.soldAt,
      customerId: detail.sale.customerId,
      creditedValue: proportionalAmount(line, 1),
      productName: product?.name ?? line.label,
    };
  }
}
