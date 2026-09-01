import type { CurrencyFormat, Money } from '@boutique/shared';
import type { Partie } from '../partie.js';

/**
 * Le compte de résultat, tel qu'il s'imprime.
 *
 * Comme pour la facture, ce modèle ignore la base de données : les mêmes
 * chiffres seront produits par le logiciel installé et par l'offre en ligne, et
 * le document ne doit pas dépendre de celui des deux qui l'appelle.
 */

export interface LigneResultat {
  libelle: string;
  montant: Money;
  /** Précision en petits caractères : nombre de pièces, taux, rappel. */
  detail?: string | null;
}

export interface DocumentResultat {
  emetteur: Partie;

  /**
   * Bornes de la période, en JOURS du calendrier — « 2026-09-01 ».
   *
   * Des jours et non des instants : une borne de fin exprimée en UTC bascule
   * au lendemain une fois lue en heure de Madagascar, et un compte de résultat
   * de septembre s'annoncerait « au 01/10 ».
   */
  du: string;
  au: string;
  /** Date d'établissement du document. */
  etabliLe: string;

  /** Ventes, remises, retours — dans l'ordre où ils se lisent. */
  produits: LigneResultat[];
  chiffreAffairesNet: Money;

  coutMarchandises: Money;
  margeBrute: Money;
  /** En centièmes de point : 6 000 pour 60 %. */
  tauxMarge: number;

  charges: LigneResultat[];
  totalCharges: Money;

  /** Le bénéfice, ou la perte. */
  resultat: Money;

  devise: CurrencyFormat;
  /**
   * Ce que ce document n'est pas.
   *
   * Imprimé sur la pièce elle-même, et non laissé à l'écran : le document
   * circulera sans le logiciel — chez un comptable, à la banque — et celui qui
   * le lira doit savoir qu'il ne porte ni amortissements, ni emprunts, ni
   * capital. Un chiffre présenté sans ses limites finit toujours par être lu
   * comme s'il n'en avait pas.
   */
  avertissement: string;
}
