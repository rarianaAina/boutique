import { formatAmount, type CurrencyFormat, type Money } from '@boutique/shared';

/**
 * Le montant en toutes lettres.
 *
 * « Arrêtée la présente facture à la somme de… » n'est pas une coquetterie :
 * c'est la mention qui rend un chiffre difficile à retoucher après coup, et
 * une facture francophone sans elle passe pour incomplète. Elle est exigée par
 * l'usage comptable, et parfois réclamée par le client lui-même.
 *
 * L'orthographe française des nombres a trois pièges, tous traités ici :
 *
 *   — `et` devant un et onze : vingt et un, soixante et onze — mais PAS après
 *     quatre-vingt : quatre-vingt-un, quatre-vingt-onze ;
 *   — soixante-dix et quatre-vingt-dix se comptent par vingtaines ;
 *   — `cent` et `vingt` prennent un s quand ils sont multipliés ET terminent
 *     le nombre, ou précèdent un NOM — million, milliard. Devant `mille`, qui
 *     est un adjectif invariable, ils ne le prennent pas : deux cent mille,
 *     mais deux cents millions.
 */

const UNITES = [
  'zéro',
  'un',
  'deux',
  'trois',
  'quatre',
  'cinq',
  'six',
  'sept',
  'huit',
  'neuf',
  'dix',
  'onze',
  'douze',
  'treize',
  'quatorze',
  'quinze',
  'seize',
  'dix-sept',
  'dix-huit',
  'dix-neuf',
];

const DIZAINES = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante'];

/**
 * De 0 à 99.
 *
 * `pluriel` autorise le s de « quatre-vingts » : il ne se met que si rien ne
 * suit dans le nombre, ou si ce qui suit est un nom.
 */
function moinsDeCent(nombre: number, pluriel: boolean): string {
  if (nombre < 20) return UNITES[nombre] as string;

  if (nombre < 70) {
    const dizaine = Math.floor(nombre / 10);
    const unite = nombre % 10;
    if (unite === 0) return DIZAINES[dizaine] as string;
    if (unite === 1) return `${DIZAINES[dizaine]} et un`;
    return `${DIZAINES[dizaine]}-${UNITES[unite]}`;
  }

  if (nombre < 80) {
    const reste = nombre - 60;
    if (reste === 11) return 'soixante et onze';
    return `soixante-${UNITES[reste]}`;
  }

  const reste = nombre - 80;
  if (reste === 0) return pluriel ? 'quatre-vingts' : 'quatre-vingt';
  return `quatre-vingt-${UNITES[reste]}`;
}

/** De 0 à 999. */
function moinsDeMille(nombre: number, pluriel: boolean): string {
  if (nombre < 100) return moinsDeCent(nombre, pluriel);

  const centaines = Math.floor(nombre / 100);
  const reste = nombre % 100;
  const tete = centaines === 1 ? 'cent' : `${UNITES[centaines]} cent`;

  if (reste === 0) return centaines > 1 && pluriel ? `${tete}s` : tete;
  return `${tete} ${moinsDeCent(reste, pluriel)}`;
}

/** Groupes de trois chiffres, du plus fort au plus faible. */
const ECHELLES = [
  { valeur: 1_000_000_000, singulier: 'milliard', pluriel: 'milliards', nom: true },
  { valeur: 1_000_000, singulier: 'million', pluriel: 'millions', nom: true },
  { valeur: 1_000, singulier: 'mille', pluriel: 'mille', nom: false },
];

/** Un entier positif en toutes lettres. */
export function nombreEnLettres(nombre: number): string {
  if (!Number.isFinite(nombre)) throw new Error('Nombre non fini.');
  const entier = Math.abs(Math.trunc(nombre));
  if (entier === 0) return 'zéro';

  const morceaux: string[] = [];
  let reste = entier;

  for (const echelle of ECHELLES) {
    const combien = Math.floor(reste / echelle.valeur);
    reste %= echelle.valeur;
    if (combien === 0) continue;

    // `mille` est un adjectif : il interdit le s de cent et de vingt qui le
    // précèdent. `million` et `milliard` sont des noms : ils l'autorisent.
    const tete = combien === 1 && !echelle.nom ? '' : `${moinsDeMille(combien, echelle.nom)} `;
    morceaux.push(`${tete}${combien > 1 ? echelle.pluriel : echelle.singulier}`);
  }

  if (reste > 0) morceaux.push(moinsDeMille(reste, true));
  const texte = morceaux.join(' ');
  return nombre < 0 ? `moins ${texte}` : texte;
}

export interface NomDevise {
  unite: string;
  unitePluriel: string;
  sousUnite?: string;
  sousUnitePluriel?: string;
}

/**
 * Nom des devises en toutes lettres.
 *
 * `ariary` est INVARIABLE — c'est un mot malgache, il ne prend pas de s en
 * français. L'écrire « ariarys » sur une facture se remarque.
 */
export const NOMS_DEVISES: Record<string, NomDevise> = {
  MGA: { unite: 'ariary', unitePluriel: 'ariary' },
  EUR: {
    unite: 'euro',
    unitePluriel: 'euros',
    sousUnite: 'centime',
    sousUnitePluriel: 'centimes',
  },
  USD: { unite: 'dollar', unitePluriel: 'dollars', sousUnite: 'cent', sousUnitePluriel: 'cents' },
};

/**
 * Un montant en toutes lettres, devise comprise.
 *
 * Une devise inconnue est nommée par son code plutôt que devinée : « douze
 * mille XOF » se comprend, « douze mille xofs » ferait douter du reste de la
 * facture.
 */
export function montantEnLettres(montant: Money, devise: CurrencyFormat): string {
  const nom = NOMS_DEVISES[devise.code] ?? {
    unite: devise.code,
    unitePluriel: devise.code,
  };

  const negatif = montant < 0;
  const absolu = Math.abs(montant);
  const facteur = 10 ** devise.decimals;
  const entier = Math.floor(absolu / facteur);
  const centimes = absolu % facteur;

  const parties = [`${nombreEnLettres(entier)} ${entier > 1 ? nom.unitePluriel : nom.unite}`];
  if (centimes > 0 && nom.sousUnite) {
    parties.push(
      `${nombreEnLettres(centimes)} ${centimes > 1 ? nom.sousUnitePluriel : nom.sousUnite}`,
    );
  } else if (centimes > 0) {
    // Devise à décimales dont on ignore le nom de la sous-unité : on donne le
    // reste en chiffres plutôt que d'inventer un mot.
    parties.push(`${formatAmount(centimes, { ...devise, decimals: 0 })} centièmes`);
  }

  const texte = parties.join(' et ');
  return negatif ? `moins ${texte}` : texte;
}
