import { useState } from 'react';

/**
 * Barres d'une valeur jour par jour.
 *
 * POURQUOI UN GRAPHIQUE ICI, ALORS QUE LE RESTE DU LOGICIEL N'EN A PAS. Le
 * tableau de bord portait la mention « pas de graphique : on veut savoir ce
 * qu'on a vendu, pas contempler une courbe ». C'était juste tant qu'il
 * n'affichait qu'une journée. Sur trente jours, une colonne de trente nombres
 * ne se lit pas : le rythme de la semaine, le jour creux, la pointe du samedi
 * n'apparaissent qu'en forme. Les chiffres exacts restent affichés à côté —
 * la forme s'ajoute à eux, elle ne les remplace pas.
 *
 * UNE SEULE SÉRIE, donc aucune légende : le titre de la carte la nomme. Les
 * valeurs ne sont pas écrites sur chaque barre — trente étiquettes seraient
 * illisibles — mais le survol donne le jour et son montant exact, et le
 * tableau des ventes par jour reste dans les Rapports pour qui veut la liste.
 *
 * Le tracé est du SVG écrit à la main : une bibliothèque de graphiques pèserait
 * plus lourd que tout le reste de l'écran, pour une seule série de barres.
 */

export interface Barre {
  /** Clé et abscisse. Une date AAAA-MM-JJ dans l'usage courant. */
  cle: string;
  valeur: number;
  /** Ce que dit l'infobulle. À défaut, la clé et la valeur brute. */
  infobulle?: string;
}

export function Barres({
  donnees,
  hauteur = 96,
  vide = 'Aucune donnée sur cette période.',
}: {
  donnees: Barre[];
  hauteur?: number;
  vide?: string;
}) {
  const [survolee, setSurvolee] = useState<number | null>(null);

  if (donnees.length === 0) {
    return <p className="py-6 text-center text-sm text-encre-500">{vide}</p>;
  }

  const maximum = Math.max(...donnees.map((barre) => barre.valeur), 1);
  const largeur = 100 / donnees.length;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 100 ${hauteur}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height: hauteur }}
        role="img"
        aria-label="Évolution jour par jour"
      >
        {/* Ligne de base : discrète, elle ancre les barres sans concurrencer
            les données. */}
        <line
          x1="0"
          y1={hauteur - 0.5}
          x2="100"
          y2={hauteur - 0.5}
          className="stroke-encre-200"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
        {donnees.map((barre, index) => {
          // Une hauteur minimale d'un pixel : un jour à zéro doit se distinguer
          // d'un jour absent, et une vente unique ne doit pas disparaître.
          const haut = barre.valeur > 0 ? Math.max(2, (barre.valeur / maximum) * (hauteur - 4)) : 0;
          return (
            <rect
              key={barre.cle}
              // 2px de respiration entre deux barres, pris sur la largeur.
              x={index * largeur + largeur * 0.15}
              y={hauteur - haut}
              width={largeur * 0.7}
              height={haut}
              rx="1"
              className={
                survolee === index ? 'fill-marque-700' : 'fill-marque-500 hover:fill-marque-600'
              }
              onMouseEnter={() => setSurvolee(index)}
              onMouseLeave={() => setSurvolee(null)}
            />
          );
        })}
      </svg>

      {/* L'infobulle est en HTML et non en SVG : le texte y reste net, et il
          porte les couleurs d'encre du reste de l'application. */}
      {survolee !== null && donnees[survolee] ? (
        <div
          className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-encre-300 bg-white px-2 py-1 text-xs text-encre-800 shadow-carte"
          style={{ left: `${(survolee + 0.5) * largeur}%` }}
        >
          {donnees[survolee].infobulle ?? `${donnees[survolee].cle} — ${donnees[survolee].valeur}`}
        </div>
      ) : null}

      <div className="mt-1 flex justify-between text-[10px] text-encre-400">
        <span>{donnees[0]?.cle}</span>
        <span>{donnees.at(-1)?.cle}</span>
      </div>
    </div>
  );
}
