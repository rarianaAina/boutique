/**
 * Numérotation des documents.
 *
 * Les numéros de ticket, de facture et de transfert sont attribués LOCALEMENT,
 * sans serveur. Deux boutiques hors ligne peuvent donc atteindre le même
 * compteur : le préfixe porte le code de la boutique, ce qui rend le numéro
 * unique dans tout le réseau sans coordination (`TR-CENT-2026-000123`).
 *
 * Le format est paramétrable (§33) ; ces fonctions n'imposent que la mécanique.
 */

export interface NumberingRule {
  /** Portée : `sale`, `invoice`, `transfer`, `refund`, `purchase`, `exchange`. */
  scope: string;
  /** Motif, avec les jetons {SHOP}, {YEAR}, {MONTH} et {SEQ}. */
  pattern: string;
  /** Largeur du compteur, complété par des zéros. */
  padding: number;
  /** Le compteur repart à 1 au changement d'année. */
  yearlyReset: boolean;
}

export const DEFAULT_NUMBERING: Record<string, NumberingRule> = {
  sale: { scope: 'sale', pattern: 'T-{SHOP}-{YEAR}-{SEQ}', padding: 5, yearlyReset: true },
  invoice: { scope: 'invoice', pattern: 'F-{SHOP}-{YEAR}-{SEQ}', padding: 5, yearlyReset: true },
  refund: { scope: 'refund', pattern: 'R-{SHOP}-{YEAR}-{SEQ}', padding: 4, yearlyReset: true },
  exchange: { scope: 'exchange', pattern: 'E-{SHOP}-{YEAR}-{SEQ}', padding: 4, yearlyReset: true },
  purchase: { scope: 'purchase', pattern: 'A-{SHOP}-{YEAR}-{SEQ}', padding: 4, yearlyReset: true },
  transfer: { scope: 'transfer', pattern: 'TR-{SHOP}-{YEAR}-{SEQ}', padding: 4, yearlyReset: true },
  inventory: {
    scope: 'inventory',
    pattern: 'INV-{SHOP}-{YEAR}-{SEQ}',
    padding: 3,
    yearlyReset: true,
  },
};

export interface NumberContext {
  shopCode: string;
  sequence: number;
  at?: Date;
}

export function formatDocumentNumber(rule: NumberingRule, context: NumberContext): string {
  const at = context.at ?? new Date();
  return rule.pattern
    .replace('{SHOP}', context.shopCode.toUpperCase())
    .replace('{YEAR}', String(at.getFullYear()))
    .replace('{MONTH}', String(at.getMonth() + 1).padStart(2, '0'))
    .replace('{SEQ}', String(context.sequence).padStart(rule.padding, '0'));
}

/** Période du compteur : la clé sur laquelle il se remet à zéro. */
export function counterPeriod(rule: NumberingRule, at: Date = new Date()): string {
  return rule.yearlyReset ? String(at.getFullYear()) : 'ALL';
}
