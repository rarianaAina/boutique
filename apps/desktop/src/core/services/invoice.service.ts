import { INVOICE_STATUS, PERMISSIONS, nowIso } from '@boutique/shared';
import type { Invoice, InvoiceStatus, Money } from '@boutique/shared';
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
}
