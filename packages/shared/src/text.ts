/**
 * Texte et recherche.
 *
 * La recherche du logiciel doit trouver « écouteurs » quand on tape
 * « ecouteur », et « iPhone 15 Pro » quand on tape « iphone pro 15 ». On
 * n'obtient pas cela avec un LIKE sur le libellé : chaque produit porte une
 * CLÉ DE RECHERCHE précalculée, sans accent ni ponctuation, sur laquelle
 * l'index travaille (§31 : les recherches doivent rester rapides à 50 000
 * produits).
 */

/** Minuscule, sans accent, ponctuation réduite à des espaces. */
export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Clé de recherche d'un produit : tous ses champs textuels normalisés, séparés
 * par des espaces, entourés d'espaces pour permettre un « commence par un mot »
 * (`LIKE '% terme%'`) qui reste sélectif.
 */
export function buildSearchKey(...parts: (string | null | undefined)[]): string {
  const words = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    for (const word of normalizeText(part).split(' ')) {
      if (word) words.add(word);
    }
  }
  return ` ${[...words].join(' ')} `;
}

/** Découpe une saisie en termes, pour un ET logique sur la clé de recherche. */
export function searchTerms(query: string): string[] {
  return normalizeText(query).split(' ').filter(Boolean);
}

/** Échappe les jokers d'un LIKE SQLite (l'échappement est déclaré côté SQL). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function titleCase(value: string): string {
  return value.replace(
    /\p{L}+/gu,
    (word) => (word[0] ?? '').toUpperCase() + word.slice(1).toLowerCase(),
  );
}

/** Tronque proprement, pour les libellés de ticket. */
export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}
