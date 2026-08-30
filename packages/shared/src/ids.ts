/**
 * Identifiants.
 *
 * Toutes les entités portent un identifiant TEXTE généré localement, jamais un
 * entier auto-incrémenté. C'est la condition pour qu'une boutique hors ligne
 * puisse créer des données sans risquer de heurter celles d'une autre boutique
 * au moment de la synchronisation : deux boutiques qui créent chacune leur
 * « produit n°42 » ne peuvent pas fusionner.
 */

/** UUID v4, pour les entités dont l'ordre de création n'a pas d'importance. */
export function newId(): string {
  // `crypto` est disponible dans la WebView, dans Node >= 19 et dans les tests.
  return crypto.randomUUID();
}

/**
 * Identifiant trié par date de création (façon ULID : 48 bits de temps, puis
 * de l'aléa). Utilisé pour les événements de synchronisation et le journal
 * d'audit, où l'ordre d'insertion doit se lire directement dans la clé.
 */
export function newSortableId(now: number = Date.now()): string {
  const time = now.toString(16).padStart(12, '0');
  const random = Array.from(crypto.getRandomValues(new Uint8Array(10)))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${time}${random}`;
}

/** Identifiant court, lisible à l'oral (sans I, O, 0, 1 : trop confondus). */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function shortCode(length = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let code = '';
  for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length] ?? 'X';
  return code;
}
