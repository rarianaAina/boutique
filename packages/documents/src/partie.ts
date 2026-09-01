/**
 * Qui émet et qui reçoit, quelle que soit la pièce.
 *
 * La facture n'est pas le seul document à porter une identité : le compte de
 * résultat en porte une aussi, et il n'aurait aucune raison de la demander au
 * module des factures.
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
