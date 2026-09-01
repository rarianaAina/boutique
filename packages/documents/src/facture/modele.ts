import type { CurrencyFormat, Money } from '@boutique/shared';
import type { Mention, Partie } from '../partie.js';

/**
 * Ce qu'une facture doit porter, indépendamment de son rendu.
 *
 * Ce modèle ne connaît NI la base de données NI l'écran. C'est délibéré : la
 * même facture sera produite par le logiciel installé sur un poste et par
 * l'offre en ligne, et deux générateurs finiraient par produire deux documents
 * différents pour un même commerce. Celui qui appelle traduit ses propres
 * données vers ce modèle, et rien d'autre ne circule.
 */

export interface LigneFacture {
  designation: string;
  /** IMEI ou numéro de série, quand l'article en porte un. */
  identifiant?: string | null;
  quantite: number;
  prixUnitaire: Money;
  remise?: Money;
  total: Money;
}

export interface Reglement {
  /** Date ISO 8601. */
  le: string;
  moyen: string;
  montant: Money;
}

export type StatutFacture =
  'BROUILLON' | 'EMISE' | 'PAYEE' | 'PARTIELLEMENT_PAYEE' | 'ANNULEE' | 'REMBOURSEE';

/**
 * Les deux cases à signer, en bas de la pièce.
 *
 * Sur un marché où beaucoup de ventes se règlent en plusieurs fois et où
 * l'appareil part le jour même, la signature du client au bas de la facture
 * est souvent la seule trace qu'il a reconnu la marchandise et le solde. Les
 * libellés se règlent : « Le vendeur » et « Le client » ne conviennent pas à
 * une livraison en dépôt.
 */
export interface Signatures {
  gauche: string;
  droite: string;
}

export type { Mention, Partie };

export interface DocumentFacture {
  emetteur: Partie;
  /**
   * Logo, en URI de données (`data:image/png;base64,…`).
   *
   * `null` quand la boutique n'en a pas ou ne veut pas l'imprimer : c'est la
   * configuration qui tranche, le document ne porte pas de case à cocher. Un
   * modèle qui saurait qu'une option existe finirait par en connaître dix.
   */
  logo: string | null;
  /** Mentions libres de l'émetteur, imprimées sous ses coordonnées. */
  mentions: Mention[];
  /** `null` pour un client de passage : la facture reste valable. */
  destinataire: Partie | null;

  numero: string;
  /** Date ISO 8601 d'émission. */
  emiseLe: string;
  /** Date ISO 8601 d'échéance, si le règlement est différé. */
  echeanceLe?: string | null;
  statut: StatutFacture;

  lignes: LigneFacture[];
  sousTotal: Money;
  remise: Money;
  taxe: Money;
  total: Money;
  regle: Money;
  reglements: Reglement[];

  devise: CurrencyFormat;
  /**
   * Conditions de vente, imprimées avant les signatures.
   *
   * Distinctes du pied de page : le pied porte les mentions imposées — régime
   * de TVA, pénalités — tandis que les conditions engagent l'acheteur, et
   * c'est pour cela qu'elles se placent au-dessus de l'endroit où il signe.
   */
  conditions: string;
  /** `null` pour une facture qui ne se signe pas. */
  signatures: Signatures | null;
  /** Mentions légales de bas de page : régime de TVA, pénalités. */
  piedDePage: string;
  notes?: string | null;
}
