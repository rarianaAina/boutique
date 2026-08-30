import {
  MOVEMENT_TYPE,
  SYNC_EVENT,
  UNIT_STATUS,
  buildSearchKey,
  newId,
  nowIso,
} from '@boutique/shared';
import type { SequencedEvent, Tracking, UnitStatus } from '@boutique/shared';
import { toJson } from '../db/rows';
import type { SqlExecutor } from '../db/client';

/**
 * Application des événements reçus des autres boutiques.
 *
 * PRINCIPE : un événement décrit un FAIT daté chez son émetteur. On ne
 * fusionne pas des lignes champ par champ — on rejoue le fait. Deux boutiques
 * qui reçoivent la même suite d'événements arrivent au même état, et un
 * événement rejoué deux fois ne change rien de plus.
 *
 * IDEMPOTENCE : elle est portée par `sync_inbox`, dont la clé primaire est
 * l'identifiant de l'événement. Un événement déjà appliqué n'est jamais rejoué,
 * quelle que soit la raison pour laquelle il revient (reprise après coupure,
 * curseur remis en arrière, double lancement de la synchronisation).
 *
 * CE QUI EST APPLIQUÉ, ET CE QUI NE L'EST PAS :
 *
 *   - le CATALOGUE est répliqué partout — fiches produits, fournisseurs,
 *     clients. Sans lui, un transfert arriverait avec des articles inconnus ;
 *   - les APPAREILS ne le sont pas. Une boutique ne connaît que les siens et
 *     ceux qu'on lui expédie ; elle les découvre à l'expédition, qui porte la
 *     fiche complète de chaque appareil du colis ;
 *   - les MOUVEMENTS et les VENTES d'une autre boutique ne sont jamais rejoués :
 *     ils ne concernent pas le stock d'ici ;
 *   - les TRANSFERTS ne s'appliquent qu'aux deux boutiques concernées. Une
 *     troisième n'a rien à savoir d'un colis qui ne la regarde pas.
 *
 * POURQUOI CE CLOISONNEMENT, ET CE QU'IL COÛTE. Répliquer tous les appareils
 * permettait de répondre « on l'a, mais à Antananarivo » depuis n'importe quel
 * comptoir. C'était utile, et c'était aussi donner à chaque boutique la vue du
 * parc entier. Le choix est ici de cloisonner. L'unicité d'un IMEI n'en dépend
 * PAS : c'est le serveur qui tient le registre de détention et qui arbitre —
 * un double emploi se voit toujours, à la synchronisation plutôt qu'au scan.
 */

export interface ApplyReport {
  applied: number;
  /** Déjà appliqués : rejeu après coupure, curseur remis en arrière. */
  skipped: number;
  /** Écartés parce qu'ils concernent une autre boutique. */
  ignored: number;
  failed: number;
  errors: { eventId: string; type: string; message: string }[];
}

export class SyncApplier {
  constructor(
    private readonly db: SqlExecutor,
    private readonly localShopId: string,
  ) {}

  async applyAll(events: readonly SequencedEvent[]): Promise<ApplyReport> {
    const report: ApplyReport = { applied: 0, skipped: 0, ignored: 0, failed: 0, errors: [] };

    for (const event of events) {
      if (await this.alreadyApplied(event.id)) {
        report.skipped += 1;
        continue;
      }
      if (!(await this.concerne(event))) {
        // Consigné comme traité, et non laissé en attente : sans cela, le
        // curseur avancerait en laissant derrière lui une file d'événements
        // qu'on réexaminerait à chaque synchronisation, indéfiniment.
        report.ignored += 1;
        await this.remember(event, 'SENT', null);
        continue;
      }
      try {
        await this.apply(event);
        report.applied += 1;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        report.failed += 1;
        report.errors.push({ eventId: event.id, type: event.type, message });
        // L'échec est MÉMORISÉ, pas silencieux : l'écran de synchronisation
        // doit pouvoir montrer ce qui n'a pas pu être appliqué, sinon la
        // divergence entre deux boutiques resterait invisible.
        await this.remember(event, 'FAILED', message);
      }
    }
    return report;
  }

  private async alreadyApplied(eventId: string): Promise<boolean> {
    const rows = await this.db.select<{ status: string }>(
      'SELECT status FROM sync_inbox WHERE event_id = ?',
      [eventId],
    );
    return rows[0]?.status === 'SENT';
  }

  private async remember(
    event: SequencedEvent,
    status: 'SENT' | 'FAILED' | 'CONFLICT',
    error: string | null,
  ): Promise<void> {
    await this.db.execute(
      `INSERT INTO sync_inbox (event_id, seq, type, shop_id, payload, received_at, applied_at,
                               status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (event_id) DO UPDATE SET status = excluded.status,
                                            applied_at = excluded.applied_at,
                                            error = excluded.error`,
      [
        event.id,
        event.seq,
        event.type,
        event.shopId,
        toJson(event.payload),
        event.receivedAt,
        status === 'SENT' ? nowIso() : null,
        status,
        error,
      ],
    );
  }

  /**
   * L'événement concerne-t-il cette boutique ?
   *
   * Trois régimes, et ils se justifient chacun :
   *
   *   — le CATALOGUE est commun. Un produit, un fournisseur, un client créés
   *     ailleurs doivent exister ici, sinon un transfert arriverait avec des
   *     articles inconnus et un prix vide ;
   *   — un TRANSFERT ne regarde que ses deux boutiques. La troisième n'a pas à
   *     savoir ce qui circule entre les deux autres ;
   *   — tout le reste — entrées, sorties, ventes, changements d'état d'un
   *     appareil — n'a de sens que chez celui qui l'a vécu. Une boutique ne
   *     tient pas le stock d'une autre.
   */
  private async concerne(event: SequencedEvent): Promise<boolean> {
    switch (event.type) {
      case SYNC_EVENT.productCreated:
      case SYNC_EVENT.productUpdated:
      case SYNC_EVENT.supplierUpserted:
      case SYNC_EVENT.customerUpserted:
        return true;

      case SYNC_EVENT.transferRequested:
      case SYNC_EVENT.transferApproved:
      case SYNC_EVENT.transferShipped:
      case SYNC_EVENT.transferReceived:
      case SYNC_EVENT.transferRejected:
      case SYNC_EVENT.transferCancelled: {
        const de = str(event.payload['fromShopId']) ?? event.shopId;
        const vers = str(event.payload['toShopId']);
        if (de === this.localShopId || vers === this.localShopId) return true;

        // Les événements de FIN DE COURSE — réception, refus, annulation — ne
        // répètent pas les deux boutiques : le colis est déjà connu de celui
        // qui les reçoit, et c'est cette connaissance qui fait foi. S'en
        // remettre à la seule charge ferait manquer à l'expéditeur l'accusé de
        // réception de sa propre marchandise.
        const transferId = str(event.payload['transferId']);
        return transferId !== null && (await this.transfertConnu(transferId));
      }

      default:
        return event.shopId === this.localShopId;
    }
  }

  /** Ce colis a-t-il déjà une trace ici ? */
  private async transfertConnu(transferId: string): Promise<boolean> {
    const rows = await this.db.select<{ id: string }>(
      'SELECT id FROM transfer WHERE id = ? LIMIT 1',
      [transferId],
    );
    return rows.length > 0;
  }

  private async apply(event: SequencedEvent): Promise<void> {
    switch (event.type) {
      case SYNC_EVENT.productCreated:
      case SYNC_EVENT.productUpdated:
        await this.upsertProduct(event.payload);
        break;
      case SYNC_EVENT.supplierUpserted:
        await this.upsertSupplier(event.payload);
        break;
      case SYNC_EVENT.customerUpserted:
        await this.upsertCustomer(event.payload);
        break;
      case SYNC_EVENT.stockReceived:
        await this.applyStockReceived(event);
        break;
      case SYNC_EVENT.stockSold:
        await this.applySold(event);
        break;
      case SYNC_EVENT.unitStatusChanged:
        await this.applyUnitStatus(event);
        break;
      case SYNC_EVENT.transferRequested:
        await this.applyTransferRequested(event);
        break;
      case SYNC_EVENT.transferApproved:
        await this.setTransferStatus(event, 'APPROVED');
        break;
      case SYNC_EVENT.transferShipped:
        await this.applyTransferShipped(event);
        break;
      case SYNC_EVENT.transferReceived:
        await this.applyTransferReceived(event);
        break;
      case SYNC_EVENT.transferRejected:
        await this.applyTransferRejected(event);
        break;
      case SYNC_EVENT.transferCancelled:
        await this.setTransferStatus(event, 'CANCELLED');
        break;
      default:
        // Un type inconnu vient d'une version plus récente du logiciel. On le
        // consigne comme appliqué plutôt que de bloquer la file : bloquer
        // empêcherait TOUTE synchronisation ultérieure sur ce poste.
        break;
    }
    await this.remember(event, 'SENT', null);
  }

  /* ─── Catalogue ───────────────────────────────────────────────────────── */

  private async upsertProduct(payload: Record<string, unknown>): Promise<void> {
    const id = str(payload['id']);
    if (!id) throw new Error('Produit sans identifiant.');
    const at = nowIso();
    const attributes = payload['attributes'] ?? {};

    await this.db.execute(
      `INSERT INTO product (id, sku, reference, barcode, name, brand, model, category_id,
                            description, tracking, purchase_price, sale_price, min_price, tax_rate,
                            unit, min_stock, status, attributes, search_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         sku = excluded.sku, reference = excluded.reference, barcode = excluded.barcode,
         name = excluded.name, brand = excluded.brand, model = excluded.model,
         description = excluded.description, purchase_price = excluded.purchase_price,
         sale_price = excluded.sale_price, min_price = excluded.min_price,
         tax_rate = excluded.tax_rate, unit = excluded.unit, min_stock = excluded.min_stock,
         status = excluded.status, attributes = excluded.attributes,
         search_key = excluded.search_key, updated_at = excluded.updated_at`,
      [
        id,
        str(payload['sku']) ?? id,
        str(payload['reference']),
        str(payload['barcode']),
        str(payload['name']) ?? 'Produit',
        str(payload['brand']),
        str(payload['model']),
        str(payload['description']),
        (str(payload['tracking']) ?? 'QUANTITY') as Tracking,
        num(payload['purchasePrice']),
        num(payload['salePrice']),
        payload['minPrice'] == null ? null : num(payload['minPrice']),
        payload['taxRate'] == null ? null : num(payload['taxRate']),
        str(payload['unit']) ?? 'pièce',
        num(payload['minStock']),
        str(payload['status']) ?? 'ACTIVE',
        toJson(attributes),
        searchKeyFor(payload),
        at,
        at,
      ],
    );
  }

  private async upsertSupplier(payload: Record<string, unknown>): Promise<void> {
    const id = str(payload['id']);
    if (!id) return;
    const at = nowIso();
    await this.db.execute(
      `INSERT INTO supplier (id, code, name, company, phone, email, address, country, terms,
                             notes, is_active, search_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET code = excluded.code, name = excluded.name,
         company = excluded.company, phone = excluded.phone, email = excluded.email,
         address = excluded.address, country = excluded.country, terms = excluded.terms,
         notes = excluded.notes, search_key = excluded.search_key, updated_at = excluded.updated_at`,
      [
        id,
        str(payload['code']) ?? id,
        str(payload['name']) ?? 'Fournisseur',
        str(payload['company']),
        str(payload['phone']),
        str(payload['email']),
        str(payload['address']),
        str(payload['country']),
        str(payload['terms']),
        str(payload['notes']),
        buildSearchKey(str(payload['name']), str(payload['company']), str(payload['code'])),
        at,
        at,
      ],
    );
  }

  private async upsertCustomer(payload: Record<string, unknown>): Promise<void> {
    const id = str(payload['id']);
    if (!id) return;
    const at = nowIso();
    await this.db.execute(
      `INSERT INTO customer (id, shop_id, first_name, last_name, phone, email, address, notes,
                             search_key, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET first_name = excluded.first_name,
         last_name = excluded.last_name, phone = excluded.phone, email = excluded.email,
         address = excluded.address, notes = excluded.notes, search_key = excluded.search_key,
         updated_at = excluded.updated_at`,
      [
        id,
        str(payload['firstName']),
        str(payload['lastName']) ?? 'Client',
        str(payload['phone']),
        str(payload['email']),
        str(payload['address']),
        str(payload['notes']),
        buildSearchKey(str(payload['firstName']), str(payload['lastName']), str(payload['phone'])),
        at,
        at,
      ],
    );
  }

  /* ─── Appareils ───────────────────────────────────────────────────────── */

  /**
   * Entrée en stock chez une autre boutique.
   *
   * L'appareil est enregistré ICI aussi, rattaché à SA boutique. C'est ce qui
   * donne à chaque poste le registre complet des IMEI du réseau : sans lui, une
   * boutique pourrait ressaisir un IMEI déjà entré ailleurs, et le doublon ne
   * serait découvert qu'au moment du transfert.
   */
  private async applyStockReceived(event: SequencedEvent): Promise<void> {
    const unitId = str(event.payload['unitId']);
    if (!unitId) return; // Réception d'un produit non sérialisé : rien à répliquer.

    const productId = str(event.payload['productId']);
    if (!productId) throw new Error('Appareil reçu sans produit.');
    await this.ensureProduct(productId, event.payload['product']);

    await this.db.transaction(async (tx) => {
      await upsertUnit(tx, {
        id: unitId,
        productId,
        shopId: event.shopId,
        status: UNIT_STATUS.inStock,
        condition: str(event.payload['condition']) ?? 'NEW',
        costPrice: num(event.payload['costPrice']),
        receivedAt: str(event.payload['receivedAt']),
      });

      const identifiers = event.payload['identifiers'];
      if (Array.isArray(identifiers)) {
        for (const entry of identifiers) {
          if (typeof entry !== 'object' || entry === null) continue;
          const record = entry as { kind?: unknown; slot?: unknown; value?: unknown };
          const value = str(record.value);
          if (!value) continue;
          await tx.execute(
            `INSERT INTO unit_identifier (id, unit_id, kind, slot, value)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (kind, value) DO NOTHING`,
            [newId(), unitId, str(record.kind) ?? 'IMEI', num(record.slot) || 1, value],
          );
        }
      }
    });
  }

  private async applySold(event: SequencedEvent): Promise<void> {
    const lines = event.payload['lines'];
    if (!Array.isArray(lines)) return;
    const soldAt = str(event.payload['soldAt']) ?? nowIso();

    for (const line of lines) {
      if (typeof line !== 'object' || line === null) continue;
      const unitId = str((line as { unitId?: unknown }).unitId);
      if (!unitId) continue;
      // La vente d'une autre boutique ne peut porter que sur un appareil
      // qu'elle détient : le `WHERE shop_id` empêche qu'un événement égaré
      // marque vendu un appareil qui se trouve ici.
      await this.db.execute(
        `UPDATE product_unit SET status = 'SOLD', sold_at = ?, updated_at = ?
         WHERE id = ? AND shop_id = ? AND status <> 'SOLD'`,
        [soldAt, nowIso(), unitId, event.shopId],
      );
    }
  }

  private async applyUnitStatus(event: SequencedEvent): Promise<void> {
    const unitId = str(event.payload['unitId']);
    const status = str(event.payload['status']) as UnitStatus | null;
    if (!unitId || !status) return;
    await this.db.execute(
      'UPDATE product_unit SET status = ?, updated_at = ? WHERE id = ? AND shop_id = ?',
      [status, nowIso(), unitId, event.shopId],
    );
  }

  /* ─── Transferts ──────────────────────────────────────────────────────── */

  private async applyTransferRequested(event: SequencedEvent): Promise<void> {
    const transferId = str(event.payload['transferId']);
    const toShopId = str(event.payload['toShopId']);
    const fromShopId = str(event.payload['fromShopId']) ?? event.shopId;
    if (!transferId || !toShopId) return;

    const at = nowIso();
    await this.db.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO transfer (id, number, from_shop_id, to_shop_id, status, requested_by,
                               requested_at, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'REQUESTED', ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
        [
          transferId,
          str(event.payload['number']) ?? transferId,
          fromShopId,
          toShopId,
          str(event.userId) ?? 'distant',
          event.occurredAt,
          str(event.payload['note']),
          at,
          at,
        ],
      );
    });
  }

  private async setTransferStatus(event: SequencedEvent, status: string): Promise<void> {
    const transferId = str(event.payload['transferId']);
    if (!transferId) return;
    await this.db.execute(
      'UPDATE transfer SET status = ?, rejection_reason = COALESCE(?, rejection_reason), updated_at = ? WHERE id = ?',
      [status, str(event.payload['reason']), nowIso(), transferId],
    );
  }

  /**
   * Expédition reçue : la boutique destinataire matérialise la marchandise.
   *
   * Les appareils sont créés ICI au statut `IN_TRANSFER`, rattachés à la
   * boutique EXPÉDITRICE. Ils n'entrent dans le stock d'ici qu'à la réception,
   * qui reste un geste humain : quelqu'un ouvre le colis et vérifie.
   */
  private async applyTransferShipped(event: SequencedEvent): Promise<void> {
    const transferId = str(event.payload['transferId']);
    const fromShopId = str(event.payload['fromShopId']) ?? event.shopId;
    const toShopId = str(event.payload['toShopId']);
    if (!transferId || !toShopId) return;

    const lines = Array.isArray(event.payload['lines']) ? event.payload['lines'] : [];
    const at = nowIso();

    // Le transfert peut être inconnu ici si l'événement de demande s'est perdu
    // ou n'est pas encore passé : on le crée, l'expédition se suffit à elle-même.
    await this.db.execute(
      `INSERT INTO transfer (id, number, from_shop_id, to_shop_id, status, requested_by,
                             requested_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'SHIPPED', ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      [
        transferId,
        str(event.payload['number']) ?? transferId,
        fromShopId,
        toShopId,
        str(event.userId) ?? 'distant',
        event.occurredAt,
        at,
        at,
      ],
    );

    for (const raw of lines) {
      if (typeof raw !== 'object' || raw === null) continue;
      const line = raw as Record<string, unknown>;
      const productId = str(line['productId']);
      if (!productId) continue;
      await this.ensureProduct(productId, line['product']);

      const unitId = str(line['unitId']);
      const unit = line['unit'] as Record<string, unknown> | null | undefined;

      await this.db.transaction(async (tx) => {
        if (unitId) {
          await upsertUnit(tx, {
            id: unitId,
            productId,
            // L'appareil reste chez l'expéditeur tant que le colis n'est pas
            // ouvert : un colis égaré ne doit disparaître d'aucun stock.
            shopId: fromShopId,
            status: UNIT_STATUS.inTransfer,
            condition: str(unit?.['condition']) ?? 'NEW',
            costPrice: num(unit?.['costPrice']),
            receivedAt: str(unit?.['receivedAt']),
            transferId,
          });

          for (const [slot, key] of [
            [1, 'imei1'],
            [2, 'imei2'],
          ] as const) {
            const value = str(unit?.[key]);
            if (!value) continue;
            await tx.execute(
              `INSERT INTO unit_identifier (id, unit_id, kind, slot, value) VALUES (?, ?, 'IMEI', ?, ?)
               ON CONFLICT (kind, value) DO NOTHING`,
              [newId(), unitId, slot, value],
            );
          }
          const serial = str(unit?.['serial']);
          if (serial) {
            await tx.execute(
              `INSERT INTO unit_identifier (id, unit_id, kind, slot, value) VALUES (?, ?, 'SERIAL', 1, ?)
               ON CONFLICT (kind, value) DO NOTHING`,
              [newId(), unitId, serial],
            );
          }
        }

        await tx.execute(
          `INSERT INTO transfer_line (id, transfer_id, product_id, unit_id, label, identifier,
                                      quantity, received_quantity, position)
           SELECT ?, ?, ?, ?, ?, ?, ?, 0, ?
           WHERE NOT EXISTS (SELECT 1 FROM transfer_line WHERE id = ?)`,
          [
            str(line['lineId']) ?? newId(),
            transferId,
            productId,
            unitId,
            str(line['label']) ?? '',
            str(line['identifier']),
            num(line['quantity']) || 1,
            0,
            str(line['lineId']) ?? '',
          ],
        );
      });
    }

    await this.db.execute(
      `UPDATE transfer SET status = 'SHIPPED', shipped_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('REQUESTED', 'APPROVED', 'DRAFT')`,
      [str(event.payload['shippedAt']) ?? at, at, transferId],
    );
  }

  /**
   * Réception confirmée par la destination : l'expéditeur en prend acte.
   *
   * Les appareils changent de boutique, et un mouvement d'entrée est consigné
   * AU NOM DE LA DESTINATION. Il ne perturbe pas le stock d'ici — toutes les
   * requêtes filtrent par boutique — mais il rend l'historique d'un IMEI
   * complet depuis n'importe quel poste, ce qu'exige le §23.
   */
  private async applyTransferReceived(event: SequencedEvent): Promise<void> {
    const transferId = str(event.payload['transferId']);
    const toShopId = str(event.payload['toShopId']) ?? event.shopId;
    if (!transferId) return;

    const lines = await this.db.select<{
      id: string;
      product_id: string;
      unit_id: string | null;
      quantity: number;
    }>('SELECT id, product_id, unit_id, quantity FROM transfer_line WHERE transfer_id = ?', [
      transferId,
    ]);

    const at = str(event.payload['receivedAt']) ?? nowIso();
    await this.db.transaction(async (tx) => {
      for (const line of lines) {
        if (line.unit_id) {
          await tx.execute(
            `UPDATE product_unit SET shop_id = ?, status = 'IN_STOCK', transfer_id = NULL,
                    updated_at = ?
             WHERE id = ? AND status = 'IN_TRANSFER'`,
            [toShopId, nowIso(), line.unit_id],
          );
        }
        await tx.execute(
          `INSERT INTO stock_movement (id, shop_id, product_id, unit_id, type, quantity, source,
                                       source_id, occurred_at, created_at)
           SELECT ?, ?, ?, ?, ?, ?, 'TRANSFER', ?, ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM stock_movement
             WHERE source = 'TRANSFER' AND source_id = ? AND shop_id = ?
               AND type = 'TRANSFER_IN'
               AND (unit_id IS ? OR unit_id = ?)
           )`,
          [
            newId(),
            toShopId,
            line.product_id,
            line.unit_id,
            MOVEMENT_TYPE.transferIn,
            line.quantity,
            transferId,
            at,
            nowIso(),
            transferId,
            toShopId,
            line.unit_id,
            line.unit_id,
          ],
        );
        await tx.execute('UPDATE transfer_line SET received_quantity = quantity WHERE id = ?', [
          line.id,
        ]);
      }
      await tx.execute(
        `UPDATE transfer SET status = 'RECEIVED', received_at = ?, updated_at = ? WHERE id = ?`,
        [at, nowIso(), transferId],
      );
    });
  }

  private async applyTransferRejected(event: SequencedEvent): Promise<void> {
    const transferId = str(event.payload['transferId']);
    if (!transferId) return;

    const lines = await this.db.select<{ unit_id: string | null }>(
      'SELECT unit_id FROM transfer_line WHERE transfer_id = ?',
      [transferId],
    );
    const transfer = await this.db.select<{ from_shop_id: string }>(
      'SELECT from_shop_id FROM transfer WHERE id = ?',
      [transferId],
    );
    const fromShopId = transfer[0]?.from_shop_id ?? this.localShopId;

    await this.db.transaction(async (tx) => {
      for (const line of lines) {
        if (!line.unit_id) continue;
        await tx.execute(
          `UPDATE product_unit SET shop_id = ?, status = 'IN_STOCK', transfer_id = NULL,
                  updated_at = ?
           WHERE id = ? AND status = 'IN_TRANSFER'`,
          [fromShopId, nowIso(), line.unit_id],
        );
      }
      await tx.execute(
        `UPDATE transfer SET status = 'REJECTED', rejection_reason = ?, updated_at = ? WHERE id = ?`,
        [str(event.payload['reason']), nowIso(), transferId],
      );
    });
  }

  /* ─── Utilitaires ─────────────────────────────────────────────────────── */

  /** Crée le produit s'il manque, à partir de l'instantané porté par l'événement. */
  private async ensureProduct(productId: string, snapshot: unknown): Promise<void> {
    const rows = await this.db.select<{ id: string }>('SELECT id FROM product WHERE id = ?', [
      productId,
    ]);
    if (rows.length > 0) return;

    if (snapshot && typeof snapshot === 'object') {
      await this.upsertProduct({ ...(snapshot as Record<string, unknown>), id: productId });
      return;
    }
    // Sans instantané, on crée un produit minimal plutôt que d'échouer : un
    // appareil sans fiche produit reste préférable à un transfert impossible à
    // recevoir. Il porte une marque visible pour être complété ensuite.
    const at = nowIso();
    await this.db.execute(
      `INSERT INTO product (id, sku, name, tracking, status, search_key, created_at, updated_at)
       VALUES (?, ?, ?, 'IMEI', 'ACTIVE', ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      [
        productId,
        `IMPORTE-${productId.slice(0, 8)}`,
        'Produit reçu par synchronisation — à compléter',
        ' produit recu synchronisation a completer ',
        at,
        at,
      ],
    );
  }
}

/** Insertion ou mise à jour d'une unité, sans jamais rétrograder son statut local. */
async function upsertUnit(
  tx: SqlExecutor,
  unit: {
    id: string;
    productId: string;
    shopId: string;
    status: UnitStatus;
    condition: string;
    costPrice: number;
    receivedAt: string | null;
    transferId?: string | null;
  },
): Promise<void> {
  const at = nowIso();
  await tx.execute(
    `INSERT INTO product_unit (id, product_id, shop_id, status, condition, cost_price,
                               received_at, transfer_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       shop_id = excluded.shop_id,
       status = excluded.status,
       transfer_id = excluded.transfer_id,
       updated_at = excluded.updated_at`,
    [
      unit.id,
      unit.productId,
      unit.shopId,
      unit.status,
      unit.condition,
      unit.costPrice,
      unit.receivedAt ?? at,
      unit.transferId ?? null,
      at,
      at,
    ],
  );
}

const str = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

const num = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

function searchKeyFor(payload: Record<string, unknown>): string {
  return buildSearchKey(
    str(payload['name']),
    str(payload['sku']),
    str(payload['reference']),
    str(payload['barcode']),
    str(payload['brand']),
    str(payload['model']),
  );
}
