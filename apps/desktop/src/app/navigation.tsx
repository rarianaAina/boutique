import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { CleEcran } from './routes';

/**
 * Navigation interne.
 *
 * Pas de routeur à adresses : l'application vit dans une fenêtre, sans barre
 * d'adresse ni bouton « précédent » du navigateur. Un état suffit, et il évite
 * d'embarquer une bibliothèque pour reproduire ce que la fenêtre ne propose
 * même pas.
 *
 * `parametre` porte la cible d'un écran de détail — l'appareil que la recherche
 * globale vient de trouver, la commande que l'on veut réceptionner.
 */
export interface Destination {
  ecran: CleEcran;
  parametre?: string | null;
}

interface ValeurNavigation extends Destination {
  aller: (ecran: CleEcran, parametre?: string | null) => void;
  /** Retour à l'écran précédent, quand il y en a un. */
  revenir: () => void;
  peutRevenir: boolean;
}

const Contexte = createContext<ValeurNavigation | null>(null);

export function FournisseurNavigation({
  depart = 'tableau',
  children,
}: {
  depart?: CleEcran;
  children: ReactNode;
}) {
  const [pile, setPile] = useState<Destination[]>([{ ecran: depart }]);

  const aller = useCallback((ecran: CleEcran, parametre?: string | null) => {
    setPile((precedent) => {
      const courant = precedent.at(-1);
      if (courant?.ecran === ecran && courant.parametre === (parametre ?? undefined)) {
        return precedent;
      }
      // La pile est bornée : une session de huit heures ne doit pas accumuler
      // des milliers d'entrées dont personne ne se servira.
      const suite = [...precedent, { ecran, parametre: parametre ?? undefined }];
      return suite.length > 40 ? suite.slice(-40) : suite;
    });
  }, []);

  const revenir = useCallback(() => {
    setPile((precedent) => (precedent.length > 1 ? precedent.slice(0, -1) : precedent));
  }, []);

  const courant = pile.at(-1) ?? { ecran: depart };

  const valeur = useMemo<ValeurNavigation>(
    () => ({
      ecran: courant.ecran,
      parametre: courant.parametre ?? null,
      aller,
      revenir,
      peutRevenir: pile.length > 1,
    }),
    [courant.ecran, courant.parametre, aller, revenir, pile.length],
  );

  return <Contexte.Provider value={valeur}>{children}</Contexte.Provider>;
}

export function useNavigation(): ValeurNavigation {
  const valeur = useContext(Contexte);
  if (!valeur) throw new Error('useNavigation hors de son fournisseur');
  return valeur;
}
