/**
 * Traduction entre les colonnes SQLite et les objets du domaine.
 *
 * SQLite n'a ni booléen ni objet : les premiers arrivent en 0/1, les seconds en
 * texte JSON. Ces conversions sont regroupées ici pour qu'aucun écran ne voie
 * jamais un `is_active: 1`, et pour qu'un JSON corrompu (import fautif, écriture
 * d'une version antérieure) ne fasse pas tomber toute une liste.
 */

export function toBool(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}

export function fromBool(value: boolean): number {
  return value ? 1 : 0;
}

/**
 * Lecture d'une colonne JSON.
 *
 * En cas de contenu illisible, on renvoie la valeur par défaut plutôt que de
 * lever : un attribut produit mal formé ne doit pas empêcher d'afficher la
 * liste des produits — l'incident se voit sur une fiche, pas sur tout l'écran.
 */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Nombre, avec une valeur de repli : une colonne NULL vaut 0, pas NaN. */
export function toNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function toText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
