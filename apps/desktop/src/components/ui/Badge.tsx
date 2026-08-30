import type { ReactNode } from 'react';
import { INVOICE_LABELS, PURCHASE_LABELS, SALE_LABELS, TRANSFER_LABELS } from '@boutique/shared';
import type {
  InvoiceStatus,
  PurchaseStatus,
  SaleStatus,
  TransferStatus,
  UnitStatus,
} from '@boutique/shared';

/**
 * Badges de statut.
 *
 * La COULEUR porte le sens, le TEXTE le confirme : jamais l'un sans l'autre.
 * Un badge uniquement coloré est illisible pour une personne daltonienne, et
 * un badge uniquement textuel oblige à lire chaque ligne d'un tableau au lieu
 * de le balayer.
 *
 * Le vocabulaire des couleurs est constant dans tout le logiciel :
 *   vert = abouti · bleu = en cours · ambre = en attente · rouge = interrompu
 *   gris = neutre ou terminé sans effet
 */
export type TonBadge = 'neutre' | 'succes' | 'info' | 'attente' | 'danger';

const TONS: Record<TonBadge, string> = {
  neutre: 'bg-encre-100 text-encre-700 border-encre-200',
  succes: 'bg-succes-50 text-succes-700 border-succes-200',
  info: 'bg-marque-50 text-marque-700 border-marque-200',
  attente: 'bg-alerte-50 text-alerte-700 border-alerte-200',
  danger: 'bg-danger-50 text-danger-700 border-danger-200',
};

export function Badge({ ton = 'neutre', children }: { ton?: TonBadge; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${TONS[ton]}`}
    >
      {children}
    </span>
  );
}

/** Statut d'un appareil : le badge le plus lu du logiciel. */
const UNITE: Record<UnitStatus, { libelle: string; ton: TonBadge }> = {
  IN_STOCK: { libelle: 'En stock', ton: 'succes' },
  RESERVED: { libelle: 'Réservé', ton: 'attente' },
  SOLD: { libelle: 'Vendu', ton: 'neutre' },
  IN_TRANSFER: { libelle: 'En transfert', ton: 'info' },
  TRANSFERRED: { libelle: 'Transféré', ton: 'neutre' },
  RETURNED: { libelle: 'Retourné', ton: 'succes' },
  EXCHANGED: { libelle: 'Échangé', ton: 'neutre' },
  REFUNDED: { libelle: 'Remboursé', ton: 'neutre' },
  DEFECTIVE: { libelle: 'Défectueux', ton: 'danger' },
  LOST: { libelle: 'Perdu', ton: 'danger' },
  BLOCKED: { libelle: 'Bloqué', ton: 'danger' },
};

export function BadgeUnite({ statut }: { statut: UnitStatus }) {
  const info = UNITE[statut] ?? { libelle: statut, ton: 'neutre' as const };
  return <Badge ton={info.ton}>{info.libelle}</Badge>;
}

const VENTE: Record<SaleStatus, TonBadge> = {
  DRAFT: 'neutre',
  COMPLETED: 'succes',
  CANCELLED: 'danger',
  REFUNDED: 'attente',
  PARTIALLY_REFUNDED: 'attente',
};

export function BadgeVente({ statut }: { statut: SaleStatus }) {
  return <Badge ton={VENTE[statut] ?? 'neutre'}>{SALE_LABELS[statut] ?? statut}</Badge>;
}

const ACHAT: Record<PurchaseStatus, TonBadge> = {
  DRAFT: 'neutre',
  ORDERED: 'info',
  PARTIALLY_RECEIVED: 'attente',
  RECEIVED: 'succes',
  CLOSED: 'neutre',
  CANCELLED: 'danger',
};

export function BadgeAchat({ statut }: { statut: PurchaseStatus }) {
  return <Badge ton={ACHAT[statut] ?? 'neutre'}>{PURCHASE_LABELS[statut] ?? statut}</Badge>;
}

const TRANSFERT: Record<TransferStatus, TonBadge> = {
  DRAFT: 'neutre',
  REQUESTED: 'attente',
  APPROVED: 'info',
  SHIPPED: 'info',
  IN_TRANSIT: 'info',
  RECEIVED: 'succes',
  REJECTED: 'danger',
  CANCELLED: 'danger',
};

export function BadgeTransfert({ statut }: { statut: TransferStatus }) {
  return <Badge ton={TRANSFERT[statut] ?? 'neutre'}>{TRANSFER_LABELS[statut] ?? statut}</Badge>;
}

const FACTURE: Record<InvoiceStatus, TonBadge> = {
  DRAFT: 'neutre',
  ISSUED: 'info',
  PAID: 'succes',
  PARTIALLY_PAID: 'attente',
  CANCELLED: 'danger',
  REFUNDED: 'attente',
};

export function BadgeFacture({ statut }: { statut: InvoiceStatus }) {
  return <Badge ton={FACTURE[statut] ?? 'neutre'}>{INVOICE_LABELS[statut] ?? statut}</Badge>;
}
