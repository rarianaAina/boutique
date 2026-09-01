import type { CurrencyFormat, Money } from '@boutique/shared';

/**
 * Ce qu'une facture doit porter, indépendamment de son rendu.
 *
 * Ce modèle ne connaît NI la base de données NI l'écran. C'est délibéré : la
 * même facture sera produite par le logiciel installé sur un poste et par
 * l'offre en ligne, et deux générateurs finiraient par produire deux documents
 * différents pour un même commerce. Celui qui appelle traduit ses propres
 * données vers ce modèle, et rien d'autre ne circule.
 */

/** Émetteur ou destinataire. Les mêmes champs des deux côtés. */
export interface Partie {
  nom: string;
  adresse?: string | null;
  telephone?: string | null;
  courriel?: string | null;
  /**
   * NIF et STAT. Sans eux, la comptabilité d'une entreprise cliente refuse la
   * pièce, et l'émetteur est en défaut. Facultatifs parce qu'un particulier
   * n'en a pas.
   */
  nif?: string | null;
  stat?: string | null;
}

/**
 * Mention libre de l'émetteur : registre du commerce, capital, banque, Mvola.
 *
 * Une liste plutôt que des colonnes : ce que chaque société doit ou veut faire
 * figurer varie, et une colonne par mention imposerait une migration à chaque
 * nouveau besoin.
 */
export interface Mention {
  libelle: string;
  valeur: string;
}

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

export interface DocumentFacture {
  emetteur: Partie;
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
  /** Mentions légales de bas de page : régime de TVA, conditions, pénalités. */
  piedDePage: string;
  notes?: string | null;
}
