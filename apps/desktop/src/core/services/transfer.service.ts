import {
  MOVEMENT_TYPE,
  PERMISSIONS,
  SELLABLE_UNIT_STATUSES,
  SYNC_EVENT,
  TRANSFER_STATUS,
  UNIT_STATUS,
  nowIso,
} from '@boutique/shared';
import type { TransferStatus } from '@boutique/shared';
import { TransferRepository, type TransferLineDraft } from '../db/repositories/transfer.repository';
import { UnitRepository } from '../db/repositories/unit.repository';
import { StockRepository } from '../db/repositories/stock.repository';
import { ProductRepository } from '../db/repositories/product.repository';
import { ShopRepository } from '../db/repositories/shop.repository';
import { CounterRepository } from '../db/repositories/counter.repository';
import { OutboxRepository } from '../db/repositories/outbox.repository';
import { AUDIT_ACTIONS } from '../db/repositories/audit.repository';
import { AuditService } from './audit.service';
import { productSnapshot } from './catalog.service';
import { BusinessError, assertCan, type AppContext } from './context';

/**
 * Transferts entre boutiques (§17).
 *
 * CE QUI SE PASSE HORS LIGNE, ET CE QUI NE LE PEUT PAS.
 *
 * Toutes les étapes s'écrivent dans la base LOCALE, sans réseau : demander,
 * valider, expédier, recevoir. Ce qui exige une connexion, c'est uniquement de
 * PORTER ces étapes à l'autre boutique — et cela passe par la file de
 * synchronisation, jamais par un appel bloquant. Une boutique dont la clé 4G
 * est débranchée peut donc préparer et expédier un colis ; la boutique
 * destinataire l'apprendra à la prochaine synchronisation.
 *
 * OÙ SE TROUVE UN APPAREIL EN COURS DE ROUTE : il reste rattaché à la boutique
 * EXPÉDITRICE, au statut `IN_TRANSFER`, jusqu'à la réception. C'est le seul
 * choix qui ne perd jamais un appareil : s'il changeait de boutique à
 * l'expédition, un colis égaré disparaîtrait du stock des deux côtés.
 *
 * DOUBLE RÉCEPTION : impossible. La réception n'est acceptée que depuis les
 * statuts `SHIPPED` ou `IN_TRANSIT`, et le changement de statut de chaque unité
 * est conditionné par son statut d'origine.
 */

export interface CreateTransferInput {
  toShopId: string;
  lines: TransferLineDraft[];
  note?: string | null;
}

export interface ReceiveTransferLine {
  lineId: string;
  quantity: number;
}

export class TransferService {
  private readonly transfers: TransferRepository;
  private readonly units: UnitRepository;
  private readonly products: ProductRepository;
  private readonly stock: StockRepository;
  private readonly audit: AuditService;

  constructor(private readonly context: AppContext) {
    this.transfers = new TransferRepository(context.db);
    this.units = new UnitRepository(context.db);
    this.products = new ProductRepository(context.db);
    this.stock = new StockRepository(context.db);
    this.audit = new AuditService(context);
  }

  /** Demande de transfert, créée par la boutique qui DÉTIENT la marchandise. */
  async request(input: CreateTransferInput): Promise<{ transferId: string; number: string }> {
    assertCan(this.context, PERMISSIONS.transferCreate);
    const userId = this.context.session?.id;
    if (!userId) throw new BusinessError('Session requise.');
    if (input.lines.length === 0)
      throw new BusinessError('Un transfert doit comporter au moins une ligne.');
    if (input.toShopId === this.context.shopId) {
      throw new BusinessError('La boutique de destination doit être différente.');
    }

    const destination = await new ShopRepository(this.context.db).byId(input.toShopId);
    if (!destination || destination.deletedAt)
      throw new BusinessError('Boutique de destination introuvable.');

    const prepared = await this.prepareLines(input.lines);
    const number = await new CounterRepository(this.context.db).nextNumber(
      'transfer',
      this.context.shopId,
      this.context.shopCode,
      this.context.settings.numbering['transfer'],
    );

    let transferId = '';
    await this.context.db.transaction(async (tx) => {
      transferId = await new TransferRepository(tx).insert(
        tx,
        {
          number,
          fromShopId: this.context.shopId,
          toShopId: input.toShopId,
          requestedBy: userId,
          note: input.note ?? null,
          status: TRANSFER_STATUS.requested,
        },
        prepared,
      );

      // Les appareils sont RÉSERVÉS dès la demande : sans cela, un vendeur
      // pourrait encaisser un téléphone déjà promis à l'autre boutique, et le
      // colis partirait avec un appareil vendu.
      const units = new UnitRepository(tx);
      for (const line of prepared) {
        if (line.unitId) {
          await units.changeStatus(line.unitId, UNIT_STATUS.reserved, SELLABLE_UNIT_STATUSES, {
            transferId,
          });
        } else {
          await new StockRepository(tx).reserve(
            tx,
            line.productId,
            this.context.shopId,
            line.quantity,
          );
        }
      }

      await new OutboxRepository(tx).enqueue({
        type: SYNC_EVENT.transferRequested,
        entity: 'transfer',
        entityId: transferId,
        shopId: this.context.shopId,
        userId,
        payload: this.payloadFor(transferId, number, input.toShopId, prepared, input.note ?? null),
      });

      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.transfer,
        entity: 'transfer',
        entityId: transferId,
        after: { numero: number, destination: input.toShopId, lignes: prepared.length },
      });
    });

    return { transferId, number };
  }

  /** Validation par un responsable. Étape séparée, exigée par le §17. */
  async approve(transferId: string): Promise<void> {
    assertCan(this.context, PERMISSIONS.transferApprove);
    const transfer = await this.requireTransfer(transferId, [TRANSFER_STATUS.requested]);
    this.assertSource(transfer.fromShopId);

    await this.context.db.transaction(async (tx) => {
      await new TransferRepository(tx).setStatus(tx, transferId, TRANSFER_STATUS.approved, {
        approvedAt: nowIso(),
      });
      await new OutboxRepository(tx).enqueue({
        type: SYNC_EVENT.transferApproved,
        entity: 'transfer',
        entityId: transferId,
        shopId: this.context.shopId,
        userId: this.context.session?.id ?? null,
        payload: { transferId, number: transfer.number, approvedAt: nowIso() },
      });
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.transfer,
        entity: 'transfer',
        entityId: transferId,
        before: { statut: transfer.status },
        after: { statut: TRANSFER_STATUS.approved },
      });
    });
  }

  /**
   * Expédition : la marchandise quitte la boutique.
   *
   * C'est ici que le stock sort réellement. Les appareils passent en
   * `IN_TRANSFER` sans changer de boutique — ils restent sous la
   * responsabilité de l'expéditeur tant que le colis n'est pas arrivé.
   */
  async ship(transferId: string): Promise<void> {
    assertCan(this.context, PERMISSIONS.transferApprove);
    const transfer = await this.requireTransfer(transferId, [
      TRANSFER_STATUS.approved,
      TRANSFER_STATUS.requested,
    ]);
    this.assertSource(transfer.fromShopId);

    const lines = await this.transfers.lines(transferId);
    const at = nowIso();
    // L'événement d'expédition emporte de quoi RECONSTITUER la marchandise chez
    // le destinataire : produit, appareil, identifiants. Sans cela, la boutique
    // qui reçoit devrait déjà connaître un produit qu'elle n'a peut-être jamais
    // vendu, et la réception échouerait sur une référence introuvable.
    const snapshots = await this.snapshotLines(lines);

    await this.context.db.transaction(async (tx) => {
      const units = new UnitRepository(tx);
      const stock = new StockRepository(tx);

      for (const line of lines) {
        if (line.unitId) {
          await units.changeStatus(
            line.unitId,
            UNIT_STATUS.inTransfer,
            [UNIT_STATUS.reserved, UNIT_STATUS.inStock, UNIT_STATUS.returned],
            { transferId },
          );
        } else {
          // La réservation est levée en même temps que la sortie réelle : la
          // quantité ne doit pas être décomptée deux fois.
          await stock.reserve(tx, line.productId, transfer.fromShopId, -line.quantity);
        }
        await stock.record({
          shopId: transfer.fromShopId,
          productId: line.productId,
          unitId: line.unitId,
          type: MOVEMENT_TYPE.transferOut,
          quantity: -line.quantity,
          source: 'TRANSFER',
          sourceId: transferId,
          sourceLabel: transfer.number,
          userId: this.context.session?.id ?? null,
          occurredAt: at,
        });
      }

      await new TransferRepository(tx).setStatus(tx, transferId, TRANSFER_STATUS.shipped, {
        shippedAt: at,
      });

      await new OutboxRepository(tx).enqueue({
        type: SYNC_EVENT.transferShipped,
        entity: 'transfer',
        entityId: transferId,
        shopId: transfer.fromShopId,
        userId: this.context.session?.id ?? null,
        payload: {
          transferId,
          number: transfer.number,
          fromShopId: transfer.fromShopId,
          toShopId: transfer.toShopId,
          shippedAt: at,
          lines: snapshots,
        },
      });

      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.transfer,
        entity: 'transfer',
        entityId: transferId,
        before: { statut: transfer.status },
        after: { statut: TRANSFER_STATUS.shipped, appareils: lines.length },
      });
    });
  }

  /**
   * Réception par la boutique destinataire.
   *
   * C'est ICI que l'appareil change de boutique. Le contrôle du statut de
   * départ (`IN_TRANSFER`) fait que recevoir deux fois le même colis n'ajoute
   * rien la seconde fois.
   */
  async receive(transferId: string, received?: ReceiveTransferLine[]): Promise<void> {
    assertCan(this.context, PERMISSIONS.transferReceive);
    const transfer = await this.requireTransfer(transferId, [
      TRANSFER_STATUS.shipped,
      TRANSFER_STATUS.inTransit,
    ]);
    if (transfer.toShopId !== this.context.shopId) {
      throw new BusinessError(
        'Seule la boutique destinataire peut réceptionner ce transfert.',
        'WRONG_SHOP',
      );
    }

    const lines = await this.transfers.lines(transferId);
    const byId = new Map(lines.map((line) => [line.id, line]));
    const requested =
      received ??
      lines.map((line) => ({ lineId: line.id, quantity: line.quantity - line.receivedQuantity }));

    for (const entry of requested) {
      const line = byId.get(entry.lineId);
      if (!line) throw new BusinessError('Ligne de transfert introuvable.');
      const remaining = line.quantity - line.receivedQuantity;
      if (entry.quantity > remaining) {
        throw new BusinessError(
          `« ${line.label} » : ${entry.quantity} reçus pour ${remaining} attendus.`,
        );
      }
    }

    const at = nowIso();
    const userId = this.context.session?.id ?? null;

    await this.context.db.transaction(async (tx) => {
      const transfers = new TransferRepository(tx);
      const units = new UnitRepository(tx);
      const stock = new StockRepository(tx);

      for (const entry of requested) {
        const line = byId.get(entry.lineId);
        if (!line || entry.quantity <= 0) continue;

        if (line.unitId) {
          await units.changeStatus(line.unitId, UNIT_STATUS.inStock, [UNIT_STATUS.inTransfer], {
            shopId: transfer.toShopId,
          });
          await tx.execute('UPDATE product_unit SET transfer_id = NULL WHERE id = ?', [
            line.unitId,
          ]);
        }

        await stock.record({
          shopId: transfer.toShopId,
          productId: line.productId,
          unitId: line.unitId,
          type: MOVEMENT_TYPE.transferIn,
          quantity: entry.quantity,
          source: 'TRANSFER',
          sourceId: transferId,
          sourceLabel: transfer.number,
          userId,
          occurredAt: at,
        });

        await transfers.addReceivedQuantity(tx, line.id, entry.quantity);
      }

      const totalExpected = lines.reduce((sum, line) => sum + line.quantity, 0);
      const totalReceived =
        lines.reduce((sum, line) => sum + line.receivedQuantity, 0) +
        requested.reduce((sum, entry) => sum + entry.quantity, 0);

      await transfers.setStatus(
        tx,
        transferId,
        totalReceived >= totalExpected ? TRANSFER_STATUS.received : TRANSFER_STATUS.inTransit,
        { receivedAt: at, receivedBy: userId ?? undefined },
      );

      await new OutboxRepository(tx).enqueue({
        type: SYNC_EVENT.transferReceived,
        entity: 'transfer',
        entityId: transferId,
        shopId: transfer.toShopId,
        userId,
        payload: {
          transferId,
          number: transfer.number,
          toShopId: transfer.toShopId,
          receivedAt: at,
          lines: requested,
        },
      });

      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.transfer,
        entity: 'transfer',
        entityId: transferId,
        shopId: transfer.toShopId,
        before: { statut: transfer.status },
        after: { statut: TRANSFER_STATUS.received },
      });
    });
  }

  /** Refus par la destination : la marchandise revient à l'expéditeur. */
  async reject(transferId: string, reason: string): Promise<void> {
    assertCan(this.context, PERMISSIONS.transferReceive);
    if (reason.trim() === '') throw new BusinessError('Le motif du refus est obligatoire.');

    const transfer = await this.requireTransfer(transferId, [
      TRANSFER_STATUS.requested,
      TRANSFER_STATUS.approved,
      TRANSFER_STATUS.shipped,
      TRANSFER_STATUS.inTransit,
    ]);
    if (transfer.toShopId !== this.context.shopId) {
      throw new BusinessError('Seule la boutique destinataire peut refuser ce transfert.');
    }

    const lines = await this.transfers.lines(transferId);
    const at = nowIso();
    const shipped =
      transfer.status === TRANSFER_STATUS.shipped || transfer.status === TRANSFER_STATUS.inTransit;

    await this.context.db.transaction(async (tx) => {
      const units = new UnitRepository(tx);
      const stock = new StockRepository(tx);

      for (const line of lines) {
        if (line.unitId) {
          await units.changeStatus(
            line.unitId,
            UNIT_STATUS.inStock,
            [UNIT_STATUS.inTransfer, UNIT_STATUS.reserved],
            { shopId: transfer.fromShopId },
          );
          await tx.execute('UPDATE product_unit SET transfer_id = NULL WHERE id = ?', [
            line.unitId,
          ]);
        }
        if (shipped) {
          // La marchandise était sortie : elle rentre chez l'expéditeur.
          await stock.record({
            shopId: transfer.fromShopId,
            productId: line.productId,
            unitId: line.unitId,
            type: MOVEMENT_TYPE.transferIn,
            quantity: line.quantity,
            source: 'TRANSFER',
            sourceId: transferId,
            sourceLabel: transfer.number,
            userId: this.context.session?.id ?? null,
            occurredAt: at,
            note: `Transfert refusé : ${reason}`,
          });
        } else if (!line.unitId) {
          await stock.reserve(tx, line.productId, transfer.fromShopId, -line.quantity);
        }
      }

      await new TransferRepository(tx).setStatus(tx, transferId, TRANSFER_STATUS.rejected, {
        rejectionReason: reason,
      });
      await new OutboxRepository(tx).enqueue({
        type: SYNC_EVENT.transferRejected,
        entity: 'transfer',
        entityId: transferId,
        shopId: this.context.shopId,
        userId: this.context.session?.id ?? null,
        payload: { transferId, number: transfer.number, reason, rejectedAt: at },
      });
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.transfer,
        entity: 'transfer',
        entityId: transferId,
        before: { statut: transfer.status },
        after: { statut: TRANSFER_STATUS.rejected, motif: reason },
      });
    });
  }

  /** Annulation par l'expéditeur, tant que rien n'est parti. */
  async cancel(transferId: string, reason: string): Promise<void> {
    assertCan(this.context, PERMISSIONS.transferCreate);
    const transfer = await this.requireTransfer(transferId, [
      TRANSFER_STATUS.draft,
      TRANSFER_STATUS.requested,
      TRANSFER_STATUS.approved,
    ]);
    this.assertSource(transfer.fromShopId);

    const lines = await this.transfers.lines(transferId);
    await this.context.db.transaction(async (tx) => {
      const units = new UnitRepository(tx);
      const stock = new StockRepository(tx);
      for (const line of lines) {
        if (line.unitId) {
          await units.changeStatus(line.unitId, UNIT_STATUS.inStock, [UNIT_STATUS.reserved], {});
          await tx.execute('UPDATE product_unit SET transfer_id = NULL WHERE id = ?', [
            line.unitId,
          ]);
        } else {
          await stock.reserve(tx, line.productId, transfer.fromShopId, -line.quantity);
        }
      }
      await new TransferRepository(tx).setStatus(tx, transferId, TRANSFER_STATUS.cancelled, {
        rejectionReason: reason,
      });
      await new OutboxRepository(tx).enqueue({
        type: SYNC_EVENT.transferCancelled,
        entity: 'transfer',
        entityId: transferId,
        shopId: this.context.shopId,
        userId: this.context.session?.id ?? null,
        payload: { transferId, number: transfer.number, reason },
      });
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.transfer,
        entity: 'transfer',
        entityId: transferId,
        before: { statut: transfer.status },
        after: { statut: TRANSFER_STATUS.cancelled, motif: reason },
      });
    });
  }

  /* ─── Validations ─────────────────────────────────────────────────────── */

  private async requireTransfer(id: string, allowed: TransferStatus[]) {
    const transfer = await this.transfers.byId(id);
    if (!transfer) throw new BusinessError('Transfert introuvable.');
    if (!allowed.includes(transfer.status)) {
      throw new BusinessError(
        `Opération impossible sur un transfert au statut « ${transfer.status} ».`,
        'BAD_STATUS',
      );
    }
    return transfer;
  }

  private assertSource(fromShopId: string): void {
    if (fromShopId !== this.context.shopId) {
      throw new BusinessError(
        'Seule la boutique expéditrice peut effectuer cette opération.',
        'WRONG_SHOP',
      );
    }
  }

  /**
   * Vérifie la disponibilité de chaque ligne AVANT d'écrire quoi que ce soit :
   * un transfert à moitié réservé laisserait des appareils bloqués sans
   * document pour les libérer.
   */
  private async prepareLines(lines: TransferLineDraft[]): Promise<TransferLineDraft[]> {
    const prepared: TransferLineDraft[] = [];
    const seen = new Set<string>();

    for (const [index, line] of lines.entries()) {
      const position = index + 1;
      if (line.quantity <= 0) throw new BusinessError(`Ligne ${position} : quantité invalide.`);

      const product = await this.products.byId(line.productId);
      if (!product) throw new BusinessError(`Ligne ${position} : produit introuvable.`);

      if (product.tracking === 'QUANTITY') {
        if (line.unitId)
          throw new BusinessError(`Ligne ${position} : ce produit n'a pas d'unités.`);
        const level = await this.stock.levelOf(product.id, this.context.shopId);
        if (line.quantity > level.quantity - level.reserved) {
          throw new BusinessError(
            `Ligne ${position} : stock insuffisant pour « ${product.name} ».`,
            'INSUFFICIENT_STOCK',
          );
        }
        prepared.push({ ...line, label: product.name });
        continue;
      }

      if (!line.unitId) {
        throw new BusinessError(`Ligne ${position} : désignez l'appareil à transférer.`);
      }
      if (seen.has(line.unitId)) {
        throw new BusinessError(`Ligne ${position} : cet appareil figure déjà dans le transfert.`);
      }
      seen.add(line.unitId);

      const unit = await this.units.byId(line.unitId);
      if (!unit) throw new BusinessError(`Ligne ${position} : appareil introuvable.`);
      if (unit.shopId !== this.context.shopId) {
        throw new BusinessError(
          `Ligne ${position} : cet appareil n'est pas dans cette boutique.`,
          'WRONG_SHOP',
        );
      }
      if (!SELLABLE_UNIT_STATUSES.includes(unit.status)) {
        throw new BusinessError(
          `Ligne ${position} : appareil indisponible (${unit.status}).`,
          'UNIT_NOT_AVAILABLE',
        );
      }

      prepared.push({
        productId: unit.productId,
        unitId: unit.id,
        label: product.name,
        identifier: unit.imei1 ?? unit.serial ?? null,
        quantity: 1,
      });
    }

    return prepared;
  }

  /**
   * Instantané des lignes d'un transfert : produit et appareil complets.
   *
   * C'est la charge utile de l'événement d'expédition. Elle est volontairement
   * verbeuse : un événement doit se suffire à lui-même, sinon son application
   * dépendrait de ce que le destinataire a déjà reçu — et donc de l'ordre
   * exact des synchronisations, ce qu'on ne maîtrise pas.
   */
  private async snapshotLines(
    lines: readonly {
      id: string;
      productId: string;
      unitId: string | null;
      identifier: string | null;
      quantity: number;
    }[],
  ): Promise<Record<string, unknown>[]> {
    const snapshots: Record<string, unknown>[] = [];
    for (const line of lines) {
      const product = await this.products.byId(line.productId);
      const unit = line.unitId ? await this.units.byId(line.unitId) : null;
      snapshots.push({
        lineId: line.id,
        productId: line.productId,
        unitId: line.unitId,
        identifier: line.identifier,
        quantity: line.quantity,
        product: product ? productSnapshot(product) : null,
        unit: unit
          ? {
              id: unit.id,
              productId: unit.productId,
              status: unit.status,
              condition: unit.condition,
              imei1: unit.imei1,
              imei2: unit.imei2,
              serial: unit.serial,
              color: unit.color,
              capacity: unit.capacity,
              costPrice: unit.costPrice,
              supplierId: unit.supplierId,
              receivedAt: unit.receivedAt,
            }
          : null,
      });
    }
    return snapshots;
  }

  private payloadFor(
    transferId: string,
    number: string,
    toShopId: string,
    lines: TransferLineDraft[],
    note: string | null,
  ): Record<string, unknown> {
    return {
      transferId,
      number,
      fromShopId: this.context.shopId,
      toShopId,
      note,
      lines: lines.map((line) => ({
        productId: line.productId,
        unitId: line.unitId ?? null,
        identifier: line.identifier ?? null,
        label: line.label,
        quantity: line.quantity,
      })),
    };
  }
}
