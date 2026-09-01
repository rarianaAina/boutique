import { INVOICE_STATUS, PERMISSIONS, nowIso } from '@boutique/shared';
import type { Invoice, InvoiceStatus, Money } from '@boutique/shared';
import type { DocumentFacture, StatutFacture } from '@boutique/facture';
import { CustomerRepository, customerName } from '../db/repositories/customer.repository';
import { ShopRepository } from '../db/repositories/shop.repository';
import { InvoiceRepository } from '../db/repositories/invoice.repository';
import { SaleRepository, type SaleDetail } from '../db/repositories/sale.repository';
import { CounterRepository } from '../db/repositories/counter.repository';
import { AUDIT_ACTIONS } from '../db/repositories/audit.repository';
import { AuditService } from './audit.service';
import { BusinessError, assertCan, type AppContext } from './context';

/**
 * Factures (§13).
 *
 * Une facture est un DOCUMENT, pas un doublon de la vente : elle porte son
 * propre numéro, sa propre série et son propre statut de paiement. Une vente
 * comptant produit une facture déjà payée ; une vente à un professionnel peut
 * produire une facture émise et réglée plus tard.
 *
 * Une vente ne peut donner qu'UNE facture — l'index unique sur `sale_id` le
 * garantit : deux factures pour le même encaissement doubleraient le chiffre
 * d'affaires du mois.
 */
export class InvoiceService {
  private readonly invoices: InvoiceRepository;
  private readonly sales: SaleRepository;
  private readonly audit: AuditService;

  constructor(private readonly context: AppContext) {
    this.invoices = new InvoiceRepository(context.db);
    this.sales = new SaleRepository(context.db);
    this.audit = new AuditService(context);
  }

  /** Émet la facture d'une vente, ou renvoie celle qui existe déjà. */
  async issueForSale(saleId: string, dueAt?: string | null): Promise<Invoice> {
    assertCan(this.context, PERMISSIONS.invoiceManage);

    const existing = await this.invoices.bySale(saleId);
    if (existing) return existing;

    const detail = await this.sales.detail(saleId);
    if (!detail) throw new BusinessError('Vente introuvable.');
    if (detail.sale.status === 'CANCELLED') {
      throw new BusinessError('Une vente annulée ne se facture pas.');
    }

    const number = await new CounterRepository(this.context.db).nextNumber(
      'invoice',
      this.context.shopId,
      this.context.shopCode,
      this.context.settings.numbering['invoice'],
    );

    const paid = detail.sale.paid >= detail.sale.total ? detail.sale.total : detail.sale.paid;
    const status: InvoiceStatus =
      paid >= detail.sale.total
        ? INVOICE_STATUS.paid
        : paid > 0
          ? INVOICE_STATUS.partiallyPaid
          : INVOICE_STATUS.issued;

    let invoiceId = '';
    await this.context.db.transaction(async (tx) => {
      invoiceId = await new InvoiceRepository(tx).insert(tx, {
        shopId: this.context.shopId,
        number,
        saleId,
        customerId: detail.sale.customerId,
        status,
        issuedAt: nowIso(),
        dueAt: dueAt ?? null,
        subtotal: detail.sale.subtotal,
        discount: detail.sale.discount,
        tax: detail.sale.tax,
        total: detail.sale.total,
        paid,
      });
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.create,
        entity: 'invoice',
        entityId: invoiceId,
        after: { numero: number, vente: detail.sale.number, total: detail.sale.total },
      });
    });

    const created = await this.invoices.byId(invoiceId);
    if (!created) throw new BusinessError('Facture introuvable après création.');
    return created;
  }

  async registerPayment(invoiceId: string, amount: Money): Promise<void> {
    assertCan(this.context, PERMISSIONS.invoiceManage);
    if (amount <= 0) throw new BusinessError('Le montant doit être positif.');

    const invoice = await this.invoices.byId(invoiceId);
    if (!invoice) throw new BusinessError('Facture introuvable.');
    if (invoice.status === INVOICE_STATUS.cancelled) {
      throw new BusinessError('Cette facture est annulée.');
    }

    const paid = invoice.paid + amount;
    if (paid > invoice.total) {
      throw new BusinessError(
        `Encaissement supérieur au solde : ${invoice.total - invoice.paid} restant dû.`,
      );
    }

    await this.context.db.transaction(async (tx) => {
      await new InvoiceRepository(tx).setStatus(
        tx,
        invoiceId,
        paid >= invoice.total ? INVOICE_STATUS.paid : INVOICE_STATUS.partiallyPaid,
        paid,
      );
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.update,
        entity: 'invoice',
        entityId: invoiceId,
        before: { regle: invoice.paid },
        after: { regle: paid },
      });
    });
  }

  async cancel(invoiceId: string, reason: string): Promise<void> {
    assertCan(this.context, PERMISSIONS.invoiceManage);
    if (reason.trim() === '') throw new BusinessError("Le motif d'annulation est obligatoire.");
    const invoice = await this.invoices.byId(invoiceId);
    if (!invoice) throw new BusinessError('Facture introuvable.');

    await this.context.db.transaction(async (tx) => {
      await new InvoiceRepository(tx).setStatus(tx, invoiceId, INVOICE_STATUS.cancelled);
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.update,
        entity: 'invoice',
        entityId: invoiceId,
        before: { statut: invoice.status },
        after: { statut: INVOICE_STATUS.cancelled, motif: reason },
      });
    });
  }

  /** Document complet, prêt pour l'impression ou l'export PDF. */
  async document(invoiceId: string): Promise<{ invoice: Invoice; sale: SaleDetail | null }> {
    const invoice = await this.invoices.byId(invoiceId);
    if (!invoice) throw new BusinessError('Facture introuvable.');
    const sale = invoice.saleId ? await this.sales.detail(invoice.saleId) : null;
    return { invoice, sale };
  }

  /**
   * La facture telle qu'elle sera imprimée.
   *
   * TOUT EST RECOPIÉ ICI, et ce n'est pas une maladresse : une facture est une
   * pièce, pas une vue. Si elle allait rechercher le NIF de la boutique au
   * moment d'être rouverte, une facture de l'an dernier se réimprimerait avec
   * les coordonnées d'aujourd'hui — et deux exemplaires du même document ne
   * diraient pas la même chose.
   *
   * La recopie reste imparfaite tant que les coordonnées ne sont pas figées
   * dans la ligne de facture ; c'est le prochain pas, et il demande une
   * migration. En attendant, ce point est celui où il faudra intervenir.
   */
  async documentFacture(invoiceId: string): Promise<DocumentFacture> {
    const { invoice, sale } = await this.document(invoiceId);

    const boutique = await new ShopRepository(this.context.db).byId(this.context.shopId);
    const client = invoice.customerId
      ? await new CustomerRepository(this.context.db).byId(invoice.customerId)
      : null;

    const moyens = new Map(
      (
        await this.context.db.select<{ code: string; label: string }>(
          'SELECT code, label FROM payment_method',
        )
      ).map((moyen) => [moyen.code, moyen.label]),
    );

    return {
      emetteur: {
        nom: boutique?.name ?? this.context.shopCode,
        adresse: boutique?.address ?? null,
        telephone: boutique?.phone ?? null,
        courriel: boutique?.email ?? null,
        nif: boutique?.nif ?? null,
        stat: boutique?.stat ?? null,
      },
      mentions: this.context.settings.invoiceMentions,
      destinataire: client
        ? {
            nom: customerName(client),
            adresse: client.address,
            telephone: client.phone,
            courriel: client.email,
            nif: client.nif,
            stat: client.stat,
          }
        : null,

      numero: invoice.number,
      emiseLe: invoice.issuedAt,
      echeanceLe: invoice.dueAt,
      statut: STATUTS[invoice.status],

      lignes: (sale?.lines ?? []).map((ligne) => ({
        designation: ligne.label,
        identifiant: ligne.identifier,
        quantite: ligne.quantity,
        prixUnitaire: ligne.unitPrice,
        remise: ligne.discount,
        total: ligne.lineTotal,
      })),
      sousTotal: invoice.subtotal,
      remise: invoice.discount,
      taxe: invoice.tax,
      total: invoice.total,
      regle: invoice.paid,
      reglements: (sale?.payments ?? []).map((reglement) => ({
        le: reglement.paidAt,
        moyen: moyens.get(reglement.method) ?? reglement.method,
        montant: reglement.amount,
      })),

      devise: this.context.settings.currency,
      piedDePage: this.context.settings.invoiceFooter,
      notes: invoice.notes,
    };
  }

  /**
   * Le PDF de la facture, prêt à être enregistré ou envoyé.
   *
   * La bibliothèque PDF est chargée À LA DEMANDE : elle pèse quatre cents
   * kilo-octets, et l'écran des factures s'ouvre bien plus souvent qu'on n'en
   * enregistre une. Sur les machines d'entrée de gamme auxquelles ce logiciel
   * est destiné, cela se voit.
   */
  async pdf(invoiceId: string): Promise<Uint8Array> {
    const { pdfFacture } = await import('@boutique/facture');
    return pdfFacture(await this.documentFacture(invoiceId));
  }
}

/**
 * Statuts de la base vers statuts du document.
 *
 * Une table explicite plutôt qu'un transtypage : le jour où l'un des deux
 * ensembles change, le compilateur désigne l'endroit à corriger au lieu de
 * laisser passer une facture au statut vide.
 */
const STATUTS: Record<InvoiceStatus, StatutFacture> = {
  [INVOICE_STATUS.draft]: 'BROUILLON',
  [INVOICE_STATUS.issued]: 'EMISE',
  [INVOICE_STATUS.paid]: 'PAYEE',
  [INVOICE_STATUS.partiallyPaid]: 'PARTIELLEMENT_PAYEE',
  [INVOICE_STATUS.cancelled]: 'ANNULEE',
  [INVOICE_STATUS.refunded]: 'REMBOURSEE',
};
