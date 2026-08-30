import type { ReactNode } from 'react';
import { Icone, type NomIcone } from './Icone';

/**
 * Ossature d'un écran : en-tête, actions, contenu.
 *
 * Toutes les pages passent par ici. C'est ce qui garantit qu'un titre est
 * toujours au même endroit, à la même taille, avec les actions au même coin —
 * un logiciel où chaque écran est composé à sa façon oblige à chercher le
 * bouton à chaque page.
 */
export function EnTetePage({
  titre,
  sousTitre,
  actions,
}: {
  titre: string;
  sousTitre?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="truncate text-encre-900">{titre}</h1>
        {sousTitre ? <div className="mt-0.5 text-xs text-encre-500">{sousTitre}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Carte({
  titre,
  actions,
  children,
  className = '',
  compact,
}: {
  titre?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <section className={`carte flex min-h-0 flex-col ${className}`}>
      {titre ? (
        <header className="flex items-center justify-between gap-3 border-b border-encre-200 px-4 py-2.5">
          <h2 className="truncate text-encre-800">{titre}</h2>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={compact ? 'min-h-0 flex-1' : 'min-h-0 flex-1 p-4'}>{children}</div>
    </section>
  );
}

/**
 * États vides, de chargement et d'erreur.
 *
 * Ils sont traités comme des écrans à part entière (§24) : un tableau vide sans
 * explication laisse croire à une panne, et une erreur affichée en petit dans
 * un coin ne sera jamais lue.
 */
export function Vide({
  icone = 'info',
  titre,
  detail,
  action,
}: {
  icone?: NomIcone;
  titre: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div className="rounded-full bg-encre-100 p-3 text-encre-400">
        <Icone nom={icone} taille={22} />
      </div>
      <p className="font-medium text-encre-700">{titre}</p>
      {detail ? <p className="max-w-md text-xs text-encre-500">{detail}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function Chargement({ libelle = 'Chargement…' }: { libelle?: string }) {
  return (
    <div className="flex items-center justify-center gap-2.5 px-6 py-12 text-sm text-encre-500">
      <span
        className="h-4 w-4 animate-spin rounded-full border-2 border-encre-300 border-t-marque-600"
        aria-hidden="true"
      />
      {libelle}
    </div>
  );
}

export function Erreur({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-md border border-danger-200 bg-danger-50 px-3.5 py-3 text-sm text-danger-900"
    >
      <span className="mt-0.5 shrink-0 text-danger-600">
        <Icone nom="alerte" taille={18} />
      </span>
      <div className="min-w-0 flex-1">{message}</div>
      {action}
    </div>
  );
}

export function Information({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-marque-200 bg-marque-50 px-3.5 py-3 text-sm text-marque-900">
      <span className="mt-0.5 shrink-0 text-marque-600">
        <Icone nom="info" taille={18} />
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * Bandeau de consultation seule.
 *
 * Depuis que l'ACCÈS à une page et le DROIT D'Y AGIR sont deux réglages
 * distincts, un rôle peut légitimement ouvrir un écran sans pouvoir en modifier
 * le contenu. L'écran doit alors le DIRE, et retirer les boutons : laisser un
 * « Enregistrer » qui échouera est pire que de ne rien proposer — l'utilisateur
 * saisit, valide, et découvre le refus après coup.
 */
export function LectureSeule({ quoi }: { quoi: string }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-encre-200 bg-encre-50 px-3.5 py-2.5 text-sm text-encre-700">
      <span className="mt-0.5 shrink-0 text-encre-400">
        <Icone nom="info" taille={16} />
      </span>
      <span>
        Consultation seule : votre rôle ne permet pas de {quoi}. Un administrateur peut le régler
        dans « Utilisateurs et rôles ».
      </span>
    </div>
  );
}

export function Avertissement({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-alerte-200 bg-alerte-50 px-3.5 py-3 text-sm text-alerte-900">
      <span className="mt-0.5 shrink-0 text-alerte-600">
        <Icone nom="alerte" taille={18} />
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Chiffre du tableau de bord : une valeur, son libellé, une variation. */
export function CarteChiffre({
  libelle,
  valeur,
  detail,
  icone,
  ton = 'neutre',
}: {
  libelle: string;
  valeur: ReactNode;
  detail?: ReactNode;
  icone?: NomIcone;
  ton?: 'neutre' | 'succes' | 'attente' | 'danger';
}) {
  const tons = {
    neutre: 'text-encre-900',
    succes: 'text-succes-700',
    attente: 'text-alerte-700',
    danger: 'text-danger-700',
  } as const;
  return (
    <div className="carte px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-encre-500">{libelle}</p>
        {icone ? (
          <span className="text-encre-300">
            <Icone nom={icone} taille={16} />
          </span>
        ) : null}
      </div>
      <p className={`mt-1 text-xl font-semibold ${tons[ton]}`} data-nombre>
        {valeur}
      </p>
      {detail ? <p className="mt-0.5 text-xs text-encre-500">{detail}</p> : null}
    </div>
  );
}
