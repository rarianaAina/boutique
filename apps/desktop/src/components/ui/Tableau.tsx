import type { ReactNode } from 'react';
import { Bouton } from './Bouton';
import { Chargement, Vide } from './Page';
import type { NomIcone } from './Icone';

/**
 * Tableau de données.
 *
 * Générique, mais volontairement pauvre : pas de tri interne, pas de filtrage
 * caché, pas de pagination magique. Le tri et la pagination se font en BASE
 * (§31) — un tableau qui trie ce qu'il a en mémoire ment dès qu'il y a une page
 * suivante, et personne ne s'en aperçoit avant que le stock ait grossi.
 */

export interface Colonne<T> {
  cle: string;
  titre: string;
  /** Aligné à droite : réservé aux nombres. */
  num?: boolean;
  largeur?: string;
  rendu: (ligne: T) => ReactNode;
}

export interface TableauProps<T> {
  colonnes: Colonne<T>[];
  lignes: readonly T[];
  cleDe: (ligne: T) => string;
  chargement?: boolean;
  onLigneCliquee?: (ligne: T) => void;
  /** Ligne mise en évidence (sélection courante). */
  ligneActive?: (ligne: T) => boolean;
  vide?: { titre: string; detail?: string; icone?: NomIcone; action?: ReactNode };
}

export function Tableau<T>({
  colonnes,
  lignes,
  cleDe,
  chargement,
  onLigneCliquee,
  ligneActive,
  vide,
}: TableauProps<T>) {
  if (chargement) return <Chargement />;
  if (lignes.length === 0) {
    return (
      <Vide
        icone={vide?.icone}
        titre={vide?.titre ?? 'Aucun résultat'}
        detail={vide?.detail}
        action={vide?.action}
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="tableau">
        <thead>
          <tr>
            {colonnes.map((colonne) => (
              <th
                key={colonne.cle}
                className={colonne.num ? 'num text-right' : undefined}
                style={colonne.largeur ? { width: colonne.largeur } : undefined}
              >
                {colonne.titre}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lignes.map((ligne) => {
            const actif = ligneActive?.(ligne) ?? false;
            return (
              <tr
                key={cleDe(ligne)}
                data-clickable={onLigneCliquee ? '' : undefined}
                onClick={onLigneCliquee ? () => onLigneCliquee(ligne) : undefined}
                className={actif ? 'bg-marque-50' : undefined}
              >
                {colonnes.map((colonne) => (
                  <td key={colonne.cle} className={colonne.num ? 'num' : undefined}>
                    {colonne.rendu(ligne)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Pagination.
 *
 * Elle affiche l'intervalle ET le total : « 51-100 sur 12 843 » dit à la fois
 * où l'on est et combien il reste, ce qu'un simple numéro de page ne dit pas.
 */
export function Pagination({
  offset,
  limite,
  total,
  onChanger,
}: {
  offset: number;
  limite: number;
  total: number;
  onChanger: (offset: number) => void;
}) {
  if (total <= limite) {
    return (
      <div className="flex items-center justify-end border-t border-encre-200 px-3 py-2 text-xs text-encre-500">
        {total} {total > 1 ? 'lignes' : 'ligne'}
      </div>
    );
  }

  const debut = offset + 1;
  const fin = Math.min(offset + limite, total);

  return (
    <div className="flex items-center justify-between gap-3 border-t border-encre-200 px-3 py-2">
      <span className="text-xs text-encre-500" data-nombre>
        {debut}–{fin} sur {total.toLocaleString('fr-FR')}
      </span>
      <div className="flex items-center gap-1.5">
        <Bouton
          taille="petit"
          disabled={offset === 0}
          onClick={() => onChanger(Math.max(0, offset - limite))}
        >
          Précédent
        </Bouton>
        <Bouton taille="petit" disabled={fin >= total} onClick={() => onChanger(offset + limite)}>
          Suivant
        </Bouton>
      </div>
    </div>
  );
}

/** Barre de filtres au-dessus d'un tableau. */
export function BarreFiltres({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-2.5 border-b border-encre-200 bg-encre-50/60 px-3 py-2.5">
      {children}
    </div>
  );
}

/** Champ de recherche compact, pour les barres de filtres. */
export function ChampRecherche({
  valeur,
  onChanger,
  placeholder = 'Rechercher…',
  autoFocus,
  largeur = 'w-64',
}: {
  valeur: string;
  onChanger: (valeur: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  largeur?: string;
}) {
  return (
    <input
      type="search"
      value={valeur}
      autoFocus={autoFocus}
      onChange={(event) => onChanger(event.target.value)}
      placeholder={placeholder}
      className={`h-8 rounded-md border border-encre-300 bg-white px-2.5 text-sm placeholder:text-encre-400 focus:border-marque-500 ${largeur}`}
    />
  );
}

/** Liste déroulante compacte, pour les barres de filtres. */
export function ListeFiltre({
  valeur,
  onChanger,
  options,
  vide,
}: {
  valeur: string;
  onChanger: (valeur: string) => void;
  options: { valeur: string; libelle: string }[];
  vide?: string;
}) {
  return (
    <select
      value={valeur}
      onChange={(event) => onChanger(event.target.value)}
      className="h-8 rounded-md border border-encre-300 bg-white px-2 text-sm focus:border-marque-500"
    >
      {vide !== undefined ? <option value="">{vide}</option> : null}
      {options.map((option) => (
        <option key={option.valeur} value={option.valeur}>
          {option.libelle}
        </option>
      ))}
    </select>
  );
}
