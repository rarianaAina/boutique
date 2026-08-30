import type { ProductWithStock } from '@/core/db/repositories/product.repository';

/**
 * Descente par critères dans le catalogue, pour le comptoir (§7).
 *
 * Un vendeur ne connaît pas la référence d'un cache-écran : on lui demande
 * « un hydrogel pour un S23 ». Il faut donc pouvoir ouvrir un rayon et
 * descendre : le type, puis l'appareil visé, puis la couleur.
 *
 * La logique est ISOLÉE de l'écran pour être vérifiable : c'est elle qui décide
 * combien d'écrans le vendeur traverse avant de voir un article, et une erreur
 * ici se paie en secondes perdues à chaque vente.
 */

export interface Axe {
  cle: string;
  label: string;
  /** Colonne du produit à lire en priorité, avant les caractéristiques libres. */
  depuisColonne?: 'color' | 'capacity' | 'brand';
}

/**
 * Critères de descente, du plus discriminant au plus accessoire.
 *
 * L'ordre EST le parcours : le type d'abord, parce que c'est la première
 * question posée au comptoir (« verre ou hydrogel ? ») ; la marque ensuite,
 * parce que dans les fichiers d'accessoires elle porte l'appareil visé
 * (« Iphone 12 Pro Max ») ; les déclinaisons en dernier.
 */
export const AXES: Axe[] = [
  { cle: 'type', label: 'Type' },
  { cle: 'marque', label: 'Marque', depuisColonne: 'brand' },
  { cle: 'puissance', label: 'Puissance' },
  { cle: 'avec_boitier', label: 'Avec boîtier' },
  { cle: 'avec_cable', label: 'Avec câble' },
  { cle: 'capacite', label: 'Mémoire', depuisColonne: 'capacity' },
  { cle: 'couleur', label: 'Couleur', depuisColonne: 'color' },
];

/**
 * Valeur sentinelle des articles qui ne portent pas le critère.
 *
 * L'espace de tête la rend impossible à confondre avec une vraie valeur : les
 * valeurs importées sont toutes détourées.
 */
export const SANS_VALEUR = ' sans';

export function valeurDe(produit: ProductWithStock, axe: Axe): string {
  if (axe.depuisColonne) {
    const colonne = produit[axe.depuisColonne];
    if (colonne) return colonne.trim();
  }
  return produit.attributes[axe.cle]?.trim() || SANS_VALEUR;
}

/**
 * Premier critère qui sépare réellement le lot.
 *
 * « Réellement » est le mot important : un axe dont tous les articles portent
 * la même valeur n'ajouterait qu'un écran à traverser, avec une seule tuile à
 * cliquer. On passe au suivant.
 */
export function axeSeparant(produits: ProductWithStock[], utilises: string[]): Axe | null {
  for (const axe of AXES) {
    if (utilises.includes(axe.cle)) continue;
    const valeurs = new Set(produits.map((produit) => valeurDe(produit, axe)));
    if (valeurs.size > 1) return axe;
  }
  return null;
}

export function valeursDe(produits: ProductWithStock[], axe: Axe): string[] {
  const valeurs = [...new Set(produits.map((produit) => valeurDe(produit, axe)))];
  // Les articles sans valeur ferment la marche : ce sont les exceptions.
  valeurs.sort((a, b) =>
    a === SANS_VALEUR ? 1 : b === SANS_VALEUR ? -1 : a.localeCompare(b, 'fr'),
  );
  return valeurs;
}

export function libelleValeur(valeur: string, axe: Axe): string {
  return valeur === SANS_VALEUR ? `Sans ${axe.label.toLowerCase()}` : valeur;
}

export interface Etape {
  axe: Axe;
  valeur: string;
}

/** Applique une suite de choix à un lot d'articles. */
export function filtrer(produits: ProductWithStock[], etapes: Etape[]): ProductWithStock[] {
  let lot = produits;
  for (const etape of etapes) {
    lot = lot.filter((produit) => valeurDe(produit, etape.axe) === etape.valeur);
  }
  return lot;
}
