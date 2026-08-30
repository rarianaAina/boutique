import { buildSearchKey, searchTerms } from '@boutique/shared';
import type { ProductWithStock } from '@/core/db/repositories/product.repository';
import { devinerFamille } from '@/core/import/familles';

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
  /**
   * L'attribut porte PLUSIEURS valeurs, séparées par des virgules.
   *
   * C'est le cas de la compatibilité : un même verre trempé s'adapte à
   * plusieurs téléphones, et doit apparaître sous chacun d'eux.
   */
  multiple?: boolean;
}

/**
 * Tous les critères connus, dans leur ordre par défaut.
 *
 * Cet ordre ne convient pas à toutes les familles — un smartphone se choisit
 * par marque, un cache-écran par type — d'où `axesPour`, qui le réordonne selon
 * le rayon ouvert.
 */
export const AXES: Axe[] = [
  { cle: 'type', label: 'Type' },
  { cle: 'marque', label: 'Marque', depuisColonne: 'brand' },
  { cle: 'compatibilite', label: 'Compatible avec', multiple: true },
  { cle: 'puissance', label: 'Puissance' },
  { cle: 'avec_boitier', label: 'Avec boîtier' },
  { cle: 'avec_cable', label: 'Avec câble' },
  { cle: 'capacite', label: 'Mémoire', depuisColonne: 'capacity' },
  { cle: 'couleur', label: 'Couleur', depuisColonne: 'color' },
];

const AXE_PAR_CLE = new Map(AXES.map((axe) => [axe.cle, axe]));

/**
 * Ordre des critères pour un rayon donné.
 *
 * Chaque famille se choisit dans un ordre qui lui est propre : un smartphone
 * par marque d'abord, un cache-écran par type d'abord. La famille déclare le
 * sien ; les critères qu'elle ne cite pas restent disponibles à la suite,
 * dans l'ordre par défaut, plutôt que d'être perdus.
 */
export function axesPour(categorie: string | null | undefined): Axe[] {
  const ordonnes = axesDeclares(categorie);
  return [...ordonnes, ...AXES.filter((axe) => !ordonnes.includes(axe))];
}

/**
 * Critères que la famille revendique explicitement.
 *
 * Ils sont TOUJOURS présentés, même quand tous les articles partagent la même
 * valeur : le chemin d'un rayon est une habitude de comptoir, et il vaut mieux
 * un écran d'une seule tuile qu'un parcours qui change de forme selon le stock
 * du jour. Les autres critères, eux, ne s'affichent que s'ils séparent
 * vraiment.
 */
export function axesDeclares(categorie: string | null | undefined): Axe[] {
  return (devinerFamille(categorie ?? '')?.axes ?? [])
    .map((cle) => AXE_PAR_CLE.get(cle))
    .filter((axe): axe is Axe => axe !== undefined);
}

/**
 * Valeur sentinelle des articles qui ne portent pas le critère.
 *
 * L'espace de tête la rend impossible à confondre avec une vraie valeur : les
 * valeurs importées sont toutes détourées.
 */
export const SANS_VALEUR = ' sans';

/** Valeurs qu'un article porte pour un critère — plusieurs si l'axe le permet. */
export function valeursDuProduit(produit: ProductWithStock, axe: Axe): string[] {
  if (axe.depuisColonne) {
    const colonne = produit[axe.depuisColonne];
    if (colonne?.trim()) return [colonne.trim()];
  }
  const brut = produit.attributes[axe.cle]?.trim();
  if (!brut) return [SANS_VALEUR];
  if (!axe.multiple) return [brut];
  const parts = brut
    .split(',')
    .map((valeur) => valeur.trim())
    .filter((valeur) => valeur !== '');
  return parts.length > 0 ? parts : [SANS_VALEUR];
}

/** Vrai si l'article répond au choix fait sur ce critère. */
export function correspond(produit: ProductWithStock, axe: Axe, valeur: string): boolean {
  return valeursDuProduit(produit, axe).includes(valeur);
}

/**
 * Premier critère qui sépare réellement le lot.
 *
 * « Réellement » est le mot important : un axe dont tous les articles portent
 * la même valeur n'ajouterait qu'un écran à traverser, avec une seule tuile à
 * cliquer. On passe au suivant. Et un lot d'un seul article ne se découpe
 * plus : on le montre.
 */
export function axeSeparant(
  produits: ProductWithStock[],
  utilises: string[],
  axes: Axe[] = AXES,
  imposes: Axe[] = [],
): Axe | null {
  // Un article unique se montre, jamais ne se découpe : même le chemin
  // revendiqué par le rayon n'a plus rien à trancher.
  if (produits.length < 2) return null;
  for (const axe of axes) {
    if (utilises.includes(axe.cle)) continue;
    if (imposes.includes(axe)) return axe;
    const valeurs = new Set(produits.flatMap((produit) => valeursDuProduit(produit, axe)));
    if (valeurs.size > 1) return axe;
  }
  return null;
}

/**
 * Filtre un lot sur une saisie libre.
 *
 * La recherche du comptoir porte sur le CHEMIN OUVERT : une fois dans les
 * cache-écrans, taper « hydrogel » ne doit pas ramener des housses. Elle
 * reprend la normalisation du reste de l'application — sans accent, mot à mot,
 * et tous les mots doivent être présents.
 */
export function chercher(produits: ProductWithStock[], saisie: string): ProductWithStock[] {
  const termes = searchTerms(saisie);
  if (termes.length === 0) return produits;
  return produits.filter((produit) => {
    const cle = buildSearchKey(
      produit.name,
      produit.sku,
      produit.brand,
      produit.model,
      produit.barcode,
      produit.color,
      produit.capacity,
      ...Object.values(produit.attributes),
    );
    return termes.every((terme) => cle.includes(terme));
  });
}

export function valeursDe(produits: ProductWithStock[], axe: Axe): string[] {
  const valeurs = [...new Set(produits.flatMap((produit) => valeursDuProduit(produit, axe)))];
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
    lot = lot.filter((produit) => correspond(produit, etape.axe, etape.valeur));
  }
  return lot;
}
