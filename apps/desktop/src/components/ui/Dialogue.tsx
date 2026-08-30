import { useEffect, useRef, type ReactNode } from 'react';
import { Bouton } from './Bouton';
import { Icone } from './Icone';

/**
 * Boîte de dialogue.
 *
 * Bâtie sur `<dialog>` natif : la WebView gère alors elle-même le piège au
 * clavier, la touche Échap et l'inertie du fond. Réimplémenter tout cela en
 * JavaScript, c'est se condamner à oublier un cas — et une boîte dont on ne
 * peut pas sortir au clavier bloque un comptoir.
 */
export function Dialogue({
  ouvert,
  titre,
  onFermer,
  children,
  pied,
  largeur = 'md',
}: {
  ouvert: boolean;
  titre: string;
  onFermer: () => void;
  children: ReactNode;
  pied?: ReactNode;
  largeur?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const reference = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialogue = reference.current;
    if (!dialogue) return;
    if (ouvert && !dialogue.open) dialogue.showModal();
    if (!ouvert && dialogue.open) dialogue.close();
  }, [ouvert]);

  const largeurs = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' } as const;

  return (
    <dialog
      ref={reference}
      onCancel={(event) => {
        event.preventDefault();
        onFermer();
      }}
      onClose={onFermer}
      className={`w-[92vw] ${largeurs[largeur]} rounded-lg border border-encre-200 bg-white p-0 shadow-flottant backdrop:bg-encre-950/40`}
    >
      <header className="flex items-center justify-between gap-4 border-b border-encre-200 px-4 py-3">
        <h2 className="text-encre-900">{titre}</h2>
        <button
          type="button"
          onClick={onFermer}
          aria-label="Fermer"
          className="rounded p-1 text-encre-500 hover:bg-encre-100 hover:text-encre-800"
        >
          <Icone nom="croix" taille={16} />
        </button>
      </header>
      <div className="max-h-[70vh] overflow-auto px-4 py-4">{children}</div>
      {pied ? (
        <footer className="flex items-center justify-end gap-2 border-t border-encre-200 bg-encre-50 px-4 py-3">
          {pied}
        </footer>
      ) : null}
    </dialog>
  );
}

/**
 * Confirmation d'une action irréversible.
 *
 * Le bouton de confirmation porte le VERBE de l'action (« Annuler la vente »),
 * jamais un « OK » : c'est ce qui distingue une confirmation lue d'un réflexe.
 */
export function Confirmation({
  ouvert,
  titre,
  message,
  libelleAction,
  danger,
  occupe,
  onConfirmer,
  onFermer,
  children,
}: {
  ouvert: boolean;
  titre: string;
  message: ReactNode;
  libelleAction: string;
  danger?: boolean;
  occupe?: boolean;
  onConfirmer: () => void;
  onFermer: () => void;
  children?: ReactNode;
}) {
  return (
    <Dialogue
      ouvert={ouvert}
      titre={titre}
      onFermer={onFermer}
      largeur="sm"
      pied={
        <>
          <Bouton onClick={onFermer} disabled={occupe}>
            Retour
          </Bouton>
          <Bouton variante={danger ? 'danger' : 'principal'} onClick={onConfirmer} occupe={occupe}>
            {libelleAction}
          </Bouton>
        </>
      }
    >
      <div className="space-y-3 text-sm text-encre-700">
        <div>{message}</div>
        {children}
      </div>
    </Dialogue>
  );
}
