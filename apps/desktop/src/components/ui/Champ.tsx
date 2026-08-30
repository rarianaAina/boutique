import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { forwardRef, useId } from 'react';

/**
 * Champs de formulaire.
 *
 * Le message d'erreur est rendu SOUS le champ, en rouge, et l'aide en gris à la
 * même place : l'un remplace l'autre, si bien que la hauteur du formulaire ne
 * bouge pas quand une erreur apparaît. Un formulaire qui saute d'un cran à
 * chaque validation fait perdre le fil et provoque des clics à côté.
 */

interface BaseProps {
  label: string;
  erreur?: string | null;
  aide?: string;
  requis?: boolean;
  className?: string;
}

function Enveloppe({
  label,
  erreur,
  aide,
  requis,
  id,
  className = '',
  children,
}: BaseProps & { id: string; children: ReactNode }) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <label htmlFor={id} className="text-xs font-medium text-encre-700">
        {label}
        {requis ? <span className="ml-0.5 text-danger-600">*</span> : null}
      </label>
      {children}
      <p
        className={`min-h-[1rem] text-xs ${erreur ? 'text-danger-600' : 'text-encre-500'}`}
        role={erreur ? 'alert' : undefined}
      >
        {erreur ?? aide ?? ''}
      </p>
    </div>
  );
}

const CONTROLE =
  'h-9 w-full rounded-md border bg-white px-2.5 text-sm text-encre-900 placeholder:text-encre-400 ' +
  'transition-colors hover:border-encre-400 focus:border-marque-500 disabled:bg-encre-100 disabled:text-encre-500';

export interface ChampProps extends InputHTMLAttributes<HTMLInputElement>, BaseProps {}

/**
 * `forwardRef` est nécessaire ici : l'écran de connexion et la caisse placent
 * le focus sur un champ précis au montage, et un composant sans ref ne le
 * permettrait pas sans requête sur le document.
 */
export const Champ = forwardRef<HTMLInputElement, ChampProps>(function Champ(
  { label, erreur, aide, requis, className, ...rest },
  reference,
) {
  const id = useId();
  return (
    <Enveloppe
      label={label}
      erreur={erreur}
      aide={aide}
      requis={requis}
      id={id}
      className={className}
    >
      <input
        ref={reference}
        id={id}
        className={`${CONTROLE} ${erreur ? 'border-danger-400' : 'border-encre-300'}`}
        aria-invalid={erreur ? true : undefined}
        {...rest}
      />
    </Enveloppe>
  );
});

export interface ListeProps extends SelectHTMLAttributes<HTMLSelectElement>, BaseProps {
  options: { valeur: string; libelle: string }[];
  /** Première option neutre, quand aucune valeur n'est encore choisie. */
  vide?: string;
}

export function Liste({
  label,
  erreur,
  aide,
  requis,
  options,
  vide,
  className,
  ...rest
}: ListeProps) {
  const id = useId();
  return (
    <Enveloppe
      label={label}
      erreur={erreur}
      aide={aide}
      requis={requis}
      id={id}
      className={className}
    >
      <select
        id={id}
        className={`${CONTROLE} ${erreur ? 'border-danger-400' : 'border-encre-300'}`}
        {...rest}
      >
        {vide !== undefined ? <option value="">{vide}</option> : null}
        {options.map((option) => (
          <option key={option.valeur} value={option.valeur}>
            {option.libelle}
          </option>
        ))}
      </select>
    </Enveloppe>
  );
}

export interface ZoneTexteProps extends TextareaHTMLAttributes<HTMLTextAreaElement>, BaseProps {}

export function ZoneTexte({ label, erreur, aide, requis, className, ...rest }: ZoneTexteProps) {
  const id = useId();
  return (
    <Enveloppe
      label={label}
      erreur={erreur}
      aide={aide}
      requis={requis}
      id={id}
      className={className}
    >
      <textarea
        id={id}
        rows={3}
        className={`w-full rounded-md border bg-white px-2.5 py-2 text-sm text-encre-900 placeholder:text-encre-400 focus:border-marque-500 ${
          erreur ? 'border-danger-400' : 'border-encre-300'
        }`}
        {...rest}
      />
    </Enveloppe>
  );
}

/** Case à cocher, alignée sur la ligne de base du libellé. */
export function Case({
  label,
  aide,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; aide?: string }) {
  const id = useId();
  return (
    <div className="flex items-start gap-2.5 py-1">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 h-4 w-4 rounded border-encre-400 text-marque-600 accent-marque-600"
        {...rest}
      />
      <div>
        <label htmlFor={id} className="text-sm text-encre-800">
          {label}
        </label>
        {aide ? <p className="text-xs text-encre-500">{aide}</p> : null}
      </div>
    </div>
  );
}
