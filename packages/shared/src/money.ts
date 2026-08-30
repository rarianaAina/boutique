/**
 * Monnaie.
 *
 * Tous les montants sont stockés et manipulés en ENTIERS, dans la plus petite
 * unité de la devise (centimes pour l'euro, ariary entier pour le MGA). Un
 * flottant ne représente pas 0,1 exactement ; sur une base qui additionne des
 * dizaines de milliers de lignes, l'écart finit par apparaître au bilan.
 *
 * La conversion vers une saisie utilisateur (« 12,50 ») et l'affichage sont les
 * SEULS endroits où l'on quitte l'entier.
 */

export type Money = number;

/**
 * Espaces typographiques, en séquences d'échappement : un caractère invisible
 * recopié dans un fichier source finit toujours par être remplacé par une
 * espace ordinaire au premier reformatage, et le test qui l'attendait casse.
 */
/** Espace insécable, entre le montant et le symbole (usage français). */
const NBSP = '\u00a0';
/** Espace fine insécable, entre les milliers : ne casse jamais une ligne. */
const THIN_NBSP = '\u202f';

export interface CurrencyFormat {
  /** Code ISO, indicatif : la mise en forme est faite ici, pas par Intl. */
  code: string;
  /** Symbole affiché (Ar, €, $...). */
  symbol: string;
  /** Nombre de décimales de la devise. MGA : 0. EUR : 2. */
  decimals: number;
  /** Symbole placé avant le montant ? */
  symbolBefore: boolean;
}

export const DEFAULT_CURRENCY: CurrencyFormat = {
  code: 'MGA',
  symbol: 'Ar',
  decimals: 0,
  symbolBefore: false,
};

/** Arrondi commercial (demi vers le haut) d'un calcul intermédiaire flottant. */
export function roundMoney(value: number): Money {
  return Math.round(value + Number.EPSILON * Math.sign(value || 1));
}

/**
 * Saisie utilisateur -> entier.
 *
 * Accepte la virgule comme séparateur décimal (clavier français), les espaces
 * de milliers et les espaces insécables collés par un copier-coller.
 * Renvoie `null` sur une saisie qui n'est pas un nombre : l'appelant décide
 * quoi en faire, on ne devine jamais 0.
 */
export function parseMoney(input: string, decimals = DEFAULT_CURRENCY.decimals): Money | null {
  const cleaned = input
    .replace(/[\s\u00a0\u202f]/g, '')
    .replace(/,/g, '.')
    .trim();
  if (cleaned === '' || !/^-?\d*\.?\d*$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return roundMoney(value * 10 ** decimals);
}

/** Entier -> chaîne affichable, sans symbole. */
export function formatAmount(value: Money, currency: CurrencyFormat = DEFAULT_CURRENCY): string {
  const negative = value < 0;
  const digits = Math.abs(value)
    .toString()
    .padStart(currency.decimals + 1, '0');
  const whole = currency.decimals === 0 ? digits : digits.slice(0, -currency.decimals);
  const fraction = currency.decimals === 0 ? '' : digits.slice(-currency.decimals);
  // Espace insécable étroit entre les milliers : il ne casse jamais une ligne
  // de ticket, contrairement à l'espace ordinaire.
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, THIN_NBSP);
  const body = fraction ? `${grouped},${fraction}` : grouped;
  return negative ? `-${body}` : body;
}

/** Entier -> chaîne affichable, avec symbole. */
export function formatMoney(value: Money, currency: CurrencyFormat = DEFAULT_CURRENCY): string {
  const amount = formatAmount(value, currency);
  return currency.symbolBefore
    ? `${currency.symbol}${NBSP}${amount}`
    : `${amount}${NBSP}${currency.symbol}`;
}

/** Applique un pourcentage exprimé en centièmes de point (12,5 % -> 1250). */
export function applyRate(base: Money, rateBasisPoints: number): Money {
  return roundMoney((base * rateBasisPoints) / 10_000);
}

/**
 * Répartition d'un montant sur des poids, SANS perte d'un seul centime.
 *
 * Utilisée pour ventiler les frais logistiques d'un achat sur ses lignes (§11
 * du cahier des charges) : la somme des parts renvoyées est exactement égale au
 * montant d'entrée. La méthode du plus fort reste attribue les unités
 * résiduelles aux lignes dont la partie décimale est la plus grande, ce qui est
 * la répartition la plus défendable devant un comptable.
 *
 * Poids tous nuls (ou liste vide) : le montant est réparti à parts égales, à
 * défaut de meilleure information.
 */
export function allocate(total: Money, weights: readonly number[]): Money[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((accumulator, weight) => accumulator + Math.max(0, weight), 0);
  const effective = sum > 0 ? weights.map((weight) => Math.max(0, weight)) : weights.map(() => 1);
  const effectiveSum = sum > 0 ? sum : weights.length;

  const exact = effective.map((weight) => (total * weight) / effectiveSum);
  const floors = exact.map((value) => Math.trunc(value));
  let remainder = total - floors.reduce((accumulator, value) => accumulator + value, 0);

  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.trunc(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  const result = [...floors];
  const step = remainder >= 0 ? 1 : -1;
  let cursor = 0;
  while (remainder !== 0 && order.length > 0) {
    const target = order[cursor % order.length];
    if (target) {
      result[target.index] = (result[target.index] ?? 0) + step;
      remainder -= step;
    }
    cursor += 1;
  }
  return result;
}
