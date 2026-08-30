import { useCallback, useEffect, useRef, useState } from 'react';
import { formatMoney, type Money } from '@boutique/shared';
import { useSession } from './session';

/**
 * Chargement de données asynchrones.
 *
 * Trois choses que tout écran doit gérer et qu'on ne réécrit pas à chaque fois :
 * l'état d'attente, l'erreur, et l'ANNULATION quand l'écran disparaît avant la
 * fin de la requête. Sans ce dernier point, quitter un écran pendant un
 * chargement provoque une mise à jour d'un composant démonté — et, plus
 * insidieux, l'écrasement d'un résultat récent par un résultat périmé.
 */
export interface EtatChargement<T> {
  donnees: T | null;
  chargement: boolean;
  erreur: string | null;
  recharger: () => void;
}

export function useChargement<T>(
  charger: () => Promise<T>,
  dependances: readonly unknown[],
): EtatChargement<T> {
  const [donnees, setDonnees] = useState<T | null>(null);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  // Chaque appel porte un jeton : seule la réponse du dernier appel est retenue.
  const jeton = useRef(0);

  useEffect(() => {
    const courant = ++jeton.current;
    setChargement(true);
    setErreur(null);

    charger()
      .then((resultat) => {
        if (jeton.current !== courant) return;
        setDonnees(resultat);
        setChargement(false);
      })
      .catch((cause: unknown) => {
        if (jeton.current !== courant) return;
        setErreur(cause instanceof Error ? cause.message : String(cause));
        setChargement(false);
      });

    return () => {
      // Invalide la requête en vol : sa réponse sera ignorée.
      if (jeton.current === courant) jeton.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependances, version]);

  const recharger = useCallback(() => setVersion((precedent) => precedent + 1), []);
  return { donnees, chargement, erreur, recharger };
}

/**
 * Valeur retardée, pour les champs de recherche.
 *
 * Une requête par frappe rendrait la saisie saccadée dès quelques milliers de
 * produits ; un délai trop long donnerait l'impression que le champ ne répond
 * pas. 200 ms est le compromis retenu dans tout le logiciel.
 */
export function useDifferee<T>(valeur: T, delai = 200): T {
  const [differee, setDifferee] = useState(valeur);
  useEffect(() => {
    const minuteur = setTimeout(() => setDifferee(valeur), delai);
    return () => clearTimeout(minuteur);
  }, [valeur, delai]);
  return differee;
}

/** Mise en forme des montants dans la devise configurée. */
export function useMonnaie() {
  const { settings } = useSession();
  return useCallback(
    (valeur: Money) => formatMoney(valeur, settings.currency),
    [settings.currency],
  );
}

/** Date lisible : « 09/03/2026 » ou « 09/03/2026 14:32 ». */
export function formaterDate(valeur: string | null | undefined, avecHeure = false): string {
  if (!valeur) return '—';
  const date = new Date(valeur);
  if (Number.isNaN(date.getTime())) return '—';
  const jour = date.toLocaleDateString('fr-FR');
  return avecHeure
    ? `${jour} ${date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`
    : jour;
}

/** Message d'erreur lisible à partir d'une exception quelconque. */
export function messageDe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
