/**
 * Sur quelle sorte d'appareil tourne-t-on ?
 *
 * La question ne se posait pas tant qu'il n'y avait que des postes de travail.
 * Android change deux choses qu'aucune abstraction ne masque : le système de
 * fichiers n'y est pas un arbre de chemins qu'une application parcourt
 * librement, et il n'y a pas de boîte d'impression.
 *
 * On lit l'agent utilisateur plutôt que d'ajouter le greffon `os` : c'est une
 * dépendance de moins pour une question à laquelle la WebView répond déjà, et
 * la réponse ne sert qu'à choisir un chemin de code, jamais à décider d'un
 * droit.
 */
export function estAndroid(): boolean {
  return typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
}

/** Une boîte d'impression existe-t-elle ? Non sur Android. */
export function saitImprimer(): boolean {
  return !estAndroid();
}
