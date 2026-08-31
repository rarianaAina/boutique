import { useState } from 'react';
import { Champ } from '@/components/ui/Champ';
import { ListeFiltre } from '@/components/ui/Tableau';
import { addDays, localDay, periodRange, startOfMonth } from '@boutique/shared';

/**
 * Choix d'une période, raccourcis et dates exactes.
 *
 * POURQUOI LES DEUX. Les raccourcis servent au quotidien — « ce mois-ci »,
 * « 30 derniers jours ». Les dates exactes servent quand on cherche quelque
 * chose de précis : « qu'est-ce qui est arrivé le 12 mars ? ». Un écran qui
 * n'offre que des durées relatives oblige à compter les jours à rebours pour
 * retrouver une livraison, et l'on se trompe.
 *
 * Mutualisé parce que trois écrans en avaient besoin et qu'un seul l'avait :
 * trois implémentations auraient fini par ne pas borner les journées de la
 * même façon, et les mêmes ventes auraient donné deux totaux différents selon
 * l'écran.
 */

export const PERIODES = [
  { valeur: 'jour', libelle: "Aujourd'hui" },
  { valeur: '7', libelle: '7 derniers jours' },
  { valeur: '30', libelle: '30 derniers jours' },
  { valeur: 'mois', libelle: 'Mois en cours' },
  { valeur: '90', libelle: '90 derniers jours' },
  { valeur: 'tout', libelle: 'Depuis le début' },
  { valeur: 'perso', libelle: 'Dates exactes' },
];

export interface Bornes {
  from: string | null;
  to: string | null;
}

export interface EtatPeriode {
  choix: string;
  setChoix: (valeur: string) => void;
  debut: string;
  setDebut: (valeur: string) => void;
  fin: string;
  setFin: (valeur: string) => void;
  bornes: Bornes;
  /** Libellé lisible, pour un en-tête ou un nom de fichier exporté. */
  libelle: string;
}

/**
 * `defaut` accepte n'importe quelle valeur de `PERIODES`.
 *
 * Les bornes sont recalculées à chaque rendu plutôt que mémorisées : à minuit,
 * un écran resté ouvert doit basculer sur le jour suivant sans qu'on le
 * recharge — une caisse ne se ferme pas forcément le soir.
 */
export function usePeriode(defaut = '30'): EtatPeriode {
  const [choix, setChoix] = useState(defaut);
  const [debut, setDebut] = useState(addDays(localDay(), -30));
  const [fin, setFin] = useState(localDay());

  const aujourdhui = localDay();
  const bornes: Bornes =
    choix === 'tout'
      ? { from: null, to: null }
      : choix === 'jour'
        ? periodRange(aujourdhui, aujourdhui)
        : choix === 'mois'
          ? periodRange(startOfMonth(), aujourdhui)
          : choix === 'perso'
            ? periodRange(debut, fin)
            : periodRange(addDays(aujourdhui, -Number(choix)), aujourdhui);

  const libelle =
    choix === 'perso'
      ? `du ${debut} au ${fin}`
      : (PERIODES.find((periode) => periode.valeur === choix)?.libelle.toLowerCase() ?? '');

  return { choix, setChoix, debut, setDebut, fin, setFin, bornes, libelle };
}

/** Les contrôles. À placer dans une `BarreFiltres`. */
export function ChoixPeriode({ etat }: { etat: EtatPeriode }) {
  return (
    <>
      <ListeFiltre valeur={etat.choix} onChanger={etat.setChoix} options={PERIODES} />
      {etat.choix === 'perso' ? (
        <>
          <Champ
            label="Du"
            type="date"
            value={etat.debut}
            onChange={(evenement) => etat.setDebut(evenement.target.value)}
          />
          <Champ
            label="Au"
            type="date"
            value={etat.fin}
            onChange={(evenement) => etat.setFin(evenement.target.value)}
          />
        </>
      ) : null}
    </>
  );
}
