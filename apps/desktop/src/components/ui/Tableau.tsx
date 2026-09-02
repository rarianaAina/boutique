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
  /**
   * Sélection multiple.
   *
   * Absente, le tableau n'affiche aucune case : une colonne de cases sur un
   * tableau sans action groupée coûte de la place et n'apporte rien.
   */
  selection?: {
    clefs: ReadonlySet<string>;
    onChanger: (clefs: Set<string>) => void;
    /** Lignes non sélectionnables — une vente annulée, par exemple. */
    selectionnable?: (ligne: T) => boolean;
  };
}

export function Tableau<T>({
  colonnes,
  lignes,
  cleDe,
  chargement,
  onLigneCliquee,
  ligneActive,
  vide,
  selection,
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

  const selectionnables = selection
    ? lignes.filter((ligne) => selection.selectionnable?.(ligne) ?? true)
    : [];
  const toutesChoisies =
    selectionnables.length > 0 &&
    selectionnables.every((ligne) => selection?.clefs.has(cleDe(ligne)));

  const basculerTout = () => {
    if (!selection) return;
    const suite = new Set(selection.clefs);
    for (const ligne of selectionnables) {
      const cle = cleDe(ligne);
      if (toutesChoisies) suite.delete(cle);
      else suite.add(cle);
    }
    selection.onChanger(suite);
  };

  const basculer = (cle: string) => {
    if (!selection) return;
    const suite = new Set(selection.clefs);
    if (suite.has(cle)) suite.delete(cle);
    else suite.add(cle);
    selection.onChanger(suite);
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {/*
        LA LARGEUR MINIMALE N'EST PAS DÉCORATIVE. Un tableau occupe toute la
        largeur qu'on lui donne : sur un téléphone, il ne débordait pas, il
        ÉCRASAIT ses colonnes, et les dernières se retrouvaient hors du cadre
        sans le moindre moyen d'y accéder — pas même une barre de défilement,
        puisque rien ne dépassait. En lui imposant une largeur plancher, il
        déborde franchement et le cadre le fait défiler.

        Seulement en dessous de `lg` : sur un poste de travail, la mise en page
        actuelle convient et n'a pas à changer.
      */}
      <table className="tableau max-lg:min-w-[44rem]">
        <thead>
          <tr>
            {selection ? (
              <th style={{ width: '2.5rem' }}>
                <input
                  type="checkbox"
                  aria-label="Tout sélectionner"
                  className="h-4 w-4 rounded border-encre-400 accent-marque-600"
                  checked={toutesChoisies}
                  // L'état INDÉTERMINÉ distingue « rien de choisi » de
                  // « quelques-uns » : sans lui, une case vide laisserait croire
                  // qu'aucune ligne n'est sélectionnée alors que trois le sont.
                  ref={(element) => {
                    if (element) {
                      element.indeterminate = !toutesChoisies && selection.clefs.size > 0;
                    }
                  }}
                  onChange={basculerTout}
                  disabled={selectionnables.length === 0}
                />
              </th>
            ) : null}
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
            const cle = cleDe(ligne);
            const choisie = selection?.clefs.has(cle) ?? false;
            const actif = choisie || (ligneActive?.(ligne) ?? false);
            const peutChoisir = selection?.selectionnable?.(ligne) ?? true;
            return (
              <tr
                key={cle}
                data-clickable={onLigneCliquee ? '' : undefined}
                onClick={onLigneCliquee ? () => onLigneCliquee(ligne) : undefined}
                className={actif ? 'bg-marque-50' : undefined}
              >
                {selection ? (
                  <td
                    // Le clic sur la case ne doit PAS ouvrir la fiche : cocher
                    // trois lignes ne peut pas ouvrir trois boîtes.
                    onClick={(evenement) => evenement.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      aria-label="Sélectionner cette ligne"
                      className="h-4 w-4 rounded border-encre-400 accent-marque-600"
                      checked={choisie}
                      disabled={!peutChoisir}
                      onChange={() => basculer(cle)}
                    />
                  </td>
                ) : null}
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

/**
 * Barre d'actions groupées.
 *
 * Elle n'apparaît QUE lorsqu'au moins une ligne est choisie, et remplace alors
 * la barre de filtres : garder les deux côte à côte encombrerait l'écran au
 * moment précis où l'attention doit se porter sur ce qui a été sélectionné.
 */
export function BarreSelection({
  nombre,
  onEffacer,
  children,
}: {
  nombre: number;
  onEffacer: () => void;
  children: ReactNode;
}) {
  if (nombre === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-marque-200 bg-marque-50 px-3 py-2">
      <span className="text-sm font-medium text-marque-800" data-nombre>
        {nombre} sélectionné{nombre > 1 ? 's' : ''}
      </span>
      <Bouton taille="petit" variante="discret" onClick={onEffacer}>
        Tout désélectionner
      </Bouton>
      <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>
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
