import { normalizeText } from './text';

/**
 * Références produit.
 *
 * LA RÉFÉRENCE EST FACULTATIVE. Dans les fichiers réels d'une boutique, près
 * d'une ligne sur deux n'en porte pas : le gérant reconnaît ses articles à leur
 * désignation, à leur marque et à leur capacité, pas à un code qu'il n'a jamais
 * eu besoin d'inventer. Exiger une référence obligerait à en saisir des
 * centaines avant de pouvoir travailler.
 *
 * La base, elle, a besoin d'une clé stable et unique. Quand la référence
 * manque, on la DÉRIVE du contenu — jamais on ne refuse le produit.
 */

/**
 * Clé de regroupement des déclinaisons d'un même modèle.
 *
 * « iPhone 17 Pro Max » rouge 256 Go et « iPhone 17 Pro Max » noir 128 Go sont
 * deux produits — deux prix, deux stocks — mais UN SEUL modèle aux yeux du
 * vendeur. Cette clé les réunit.
 *
 * Elle ignore volontairement la couleur et la capacité : ce sont les axes de
 * variation, les inclure ferait autant de groupes que de variantes. Et elle
 * passe par la même normalisation que les clés de recherche, si bien que
 * « Iphone 12 Pro Max » et « iPhone 12 Pro Max  » tombent dans le même groupe.
 */
export function variantGroupKey(parts: {
  brand?: string | null;
  model?: string | null;
  name: string;
}): string {
  const modele = parts.model?.trim() || parts.name;
  return (
    normalizeText([parts.brand, modele].filter(Boolean).join(' ')) || normalizeText(parts.name)
  );
}

/** Libellé lisible d'une variante : « Rouge · 256 Go ». */
export function variantLabel(color?: string | null, capacity?: string | null): string {
  return [capacity?.trim(), color?.trim()].filter(Boolean).join(' · ');
}

/** Préfixe des références dérivées : il les rend reconnaissables d'un coup d'œil. */
export const DERIVED_SKU_PREFIX = 'AUTO-';

/**
 * Référence dérivée du modèle.
 *
 * DÉTERMINISTE : deux lignes décrivant le même modèle produisent la même
 * référence, si bien qu'un fichier listant trois exemplaires d'un
 * « iPhone 12 Pro Max 512 Silver » crée un seul produit — et non trois doublons
 * que quelqu'un devra fusionner à la main.
 *
 * Le préfixe la signale comme calculée : un gérant qui la voit sait qu'elle
 * n'est pas la référence de son fournisseur, et peut la remplacer.
 */
export function derivedSku(parts: (string | null | undefined)[]): string {
  const base = normalizeText(parts.filter(Boolean).join(' '))
    .split(' ')
    .filter(Boolean)
    .join('-')
    .toUpperCase();
  return `${DERIVED_SKU_PREFIX}${base.slice(0, 48) || 'SANS-NOM'}`;
}

export function isDerivedSku(sku: string): boolean {
  return sku.startsWith(DERIVED_SKU_PREFIX);
}

/**
 * Première référence libre à partir d'une base.
 *
 * Deux produits RÉELLEMENT différents peuvent partager une désignation — deux
 * housses « Samsung » sans autre précision, par exemple. Plutôt que de refuser
 * la création, on suffixe. Le gérant verra `AUTO-SAMSUNG-2` et saura qu'il a
 * deux fiches à distinguer.
 *
 * `existe` est fourni par l'appelant : le dépôt en base pour une création
 * manuelle, un ensemble en mémoire pour un import.
 */
export async function nextFreeSku(
  base: string,
  existe: (candidat: string) => Promise<boolean>,
  maxTentatives = 50,
): Promise<string> {
  if (!(await existe(base))) return base;
  for (let suffixe = 2; suffixe <= maxTentatives; suffixe += 1) {
    const candidat = `${base}-${suffixe}`;
    if (!(await existe(candidat))) return candidat;
  }
  // Au-delà, on cesse de deviner : c'est le signe d'un problème que l'utilisateur
  // doit voir, pas d'un cas à contourner en silence.
  throw new Error(
    `Impossible de dériver une référence libre à partir de « ${base} » : renseignez-la à la main.`,
  );
}
