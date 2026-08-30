import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icone, type NomIcone } from './Icone';

/**
 * Bouton.
 *
 * Quatre variantes seulement, et elles ont un SENS : `principal` pour l'action
 * unique d'un écran, `secondaire` pour ce qui l'accompagne, `discret` pour ce
 * qui ne doit pas attirer l'œil, `danger` pour ce qui détruit ou annule.
 * Multiplier les variantes revient à ne plus rien hiérarchiser.
 */
type Variante = 'principal' | 'secondaire' | 'discret' | 'danger';
type Taille = 'normal' | 'petit' | 'grand';

const VARIANTES: Record<Variante, string> = {
  principal:
    'bg-marque-600 text-white border-marque-600 hover:bg-marque-700 hover:border-marque-700 disabled:bg-marque-300 disabled:border-marque-300',
  secondaire:
    'bg-white text-encre-800 border-encre-300 hover:bg-encre-50 hover:border-encre-400 disabled:text-encre-400',
  discret:
    'bg-transparent text-encre-600 border-transparent hover:bg-encre-200/70 hover:text-encre-900 disabled:text-encre-400',
  danger:
    'bg-white text-danger-700 border-danger-200 hover:bg-danger-50 hover:border-danger-300 disabled:text-danger-300',
};

const TAILLES: Record<Taille, string> = {
  petit: 'h-7 px-2.5 text-xs gap-1.5',
  normal: 'h-9 px-3.5 gap-2',
  grand: 'h-11 px-5 text-base gap-2',
};

export interface BoutonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variante?: Variante;
  taille?: Taille;
  icone?: NomIcone;
  /** Occupe toute la largeur disponible. */
  pleineLargeur?: boolean;
  /** Désactive et affiche un état d'attente. */
  occupe?: boolean;
  children?: ReactNode;
}

export function Bouton({
  variante = 'secondaire',
  taille = 'normal',
  icone,
  pleineLargeur,
  occupe,
  children,
  className = '',
  disabled,
  ...rest
}: BoutonProps) {
  return (
    <button
      type="button"
      disabled={disabled || occupe}
      className={[
        'inline-flex items-center justify-center rounded-md border font-medium',
        'transition-colors disabled:cursor-not-allowed',
        VARIANTES[variante],
        TAILLES[taille],
        pleineLargeur ? 'w-full' : '',
        className,
      ].join(' ')}
      {...rest}
    >
      {occupe ? (
        <span
          className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
          aria-hidden="true"
        />
      ) : icone ? (
        <Icone nom={icone} taille={taille === 'petit' ? 14 : 16} />
      ) : null}
      {children}
    </button>
  );
}
