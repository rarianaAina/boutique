/**
 * Découpage des listes de paramètres SQL.
 *
 * SQLite plafonne le nombre de variables d'une requête préparée. Au-delà, la
 * requête ne ralentit pas : elle ÉCHOUE, sur « too many SQL variables ». Toutes
 * les requêtes `WHERE id IN (…)` construites à partir d'une liste dont la taille
 * dépend des données passent donc par des lots.
 *
 * Le plafond récent est de 32 766, mais il n'était que de 999 avant SQLite 3.32
 * et rien n'oblige la bibliothèque embarquée à garder la valeur par défaut. 400
 * reste donc volontairement bas : sur une base locale, un aller-retour de plus
 * ne coûte rien face à une page d'inventaire qui refuserait de s'afficher.
 */
export const SQL_PARAM_CHUNK = 400;

export function chunk<T>(items: readonly T[], size = SQL_PARAM_CHUNK): T[][] {
  if (items.length === 0) return [];
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/** `?, ?, ?` pour une liste de `count` paramètres. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}
