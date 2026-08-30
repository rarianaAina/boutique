/**
 * IMEI.
 *
 * L'IMEI est l'identifiant critique du logiciel (§7) : c'est lui qui relie un
 * appareil physique à son achat, sa boutique, sa vente et son client. Une
 * saisie fautive ne se rattrape pas — l'appareil part avec un mauvais numéro,
 * et l'historique ment jusqu'à la fin de sa vie.
 *
 * Un IMEI est composé de 14 chiffres significatifs suivis d'une clé de Luhn.
 * Certains appareils affichent 16 chiffres (IMEISV) : les deux derniers sont
 * alors un numéro de version logicielle, PAS une clé de contrôle — on les
 * accepte en tronquant, plutôt que de rejeter une saisie recopiée de l'écran
 * « à propos » du téléphone.
 */

export const IMEI_LENGTH = 15;

export type ImeiProblem = 'EMPTY' | 'NOT_NUMERIC' | 'BAD_LENGTH' | 'BAD_CHECKSUM';

export interface ImeiCheck {
  valid: boolean;
  /** Valeur normalisée (15 chiffres) lorsqu'elle a pu être établie. */
  value: string | null;
  problem: ImeiProblem | null;
  message: string | null;
}

/**
 * Retire tout ce qui n'est pas un chiffre.
 *
 * Les IMEI arrivent d'un scanner, d'un copier-coller ou d'une colonne Excel :
 * espaces, tirets et points sont fréquents, et un IMEI collé depuis Excel peut
 * même arriver en notation scientifique — ce cas est traité par l'importateur,
 * qui lit la valeur brute de la cellule et non son affichage.
 */
export function normalizeImei(input: string): string {
  return input.replace(/\D/g, '');
}

/** Clé de contrôle de Luhn (le 15ᵉ chiffre) pour 14 chiffres significatifs. */
export function imeiCheckDigit(first14: string): number {
  let sum = 0;
  for (let index = 0; index < first14.length; index += 1) {
    const digit = Number(first14[index]);
    // Les positions PAIRES en partant de la gauche (index impair) sont doublées :
    // la clé occupe la 15ᵉ place, l'alternance part donc de la deuxième.
    if (index % 2 === 1) {
      const doubled = digit * 2;
      sum += doubled > 9 ? doubled - 9 : doubled;
    } else {
      sum += digit;
    }
  }
  return (10 - (sum % 10)) % 10;
}

/** Complète 14 chiffres en un IMEI valide. Utile pour les données de démonstration. */
export function completeImei(first14: string): string {
  const base = first14.padStart(14, '0').slice(0, 14);
  return `${base}${imeiCheckDigit(base)}`;
}

export interface ImeiOptions {
  /**
   * Exiger une clé de Luhn correcte.
   *
   * VRAI par défaut, et il faut de bonnes raisons pour le désactiver : la clé
   * est le seul garde-fou contre un chiffre inversé à la saisie, et un IMEI
   * fautif suit l'appareil toute sa vie.
   *
   * Il existe pourtant des cas réels où elle gêne : certains appareils
   * reconditionnés ou de marques secondaires portent un IMEI qui ne la respecte
   * pas, et une boutique doit pouvoir les entrer en stock. Désactivée, la
   * longueur et l'unicité restent contrôlées — ce sont elles qui protègent
   * l'intégrité des données, la clé ne protège que de la faute de frappe.
   */
  requireChecksum?: boolean;
}

export function checkImei(input: string, options: ImeiOptions = {}): ImeiCheck {
  const raw = input.trim();
  if (raw === '') {
    return { valid: false, value: null, problem: 'EMPTY', message: "L'IMEI est obligatoire." };
  }
  if (/[^\d\s\-.]/.test(raw)) {
    return {
      valid: false,
      value: null,
      problem: 'NOT_NUMERIC',
      message: 'Un IMEI ne contient que des chiffres.',
    };
  }

  let digits = normalizeImei(raw);
  // IMEISV : on conserve les 15 premiers chiffres, la version logicielle ne
  // fait pas partie de l'identité de l'appareil.
  if (digits.length === 16) digits = digits.slice(0, 15);

  if (digits.length !== IMEI_LENGTH) {
    return {
      valid: false,
      value: digits,
      problem: 'BAD_LENGTH',
      message: `Un IMEI compte ${IMEI_LENGTH} chiffres (${digits.length} saisis).`,
    };
  }

  const expected = imeiCheckDigit(digits.slice(0, 14));
  if (expected !== Number(digits[14])) {
    const message = `Clé de contrôle incorrecte : ce numéro devrait finir par ${expected}.`;
    if (options.requireChecksum ?? true) {
      return { valid: false, value: digits, problem: 'BAD_CHECKSUM', message };
    }
    // Toléré : le numéro est retenu, mais le doute est signalé à l'appelant.
    return { valid: true, value: digits, problem: 'BAD_CHECKSUM', message };
  }

  return { valid: true, value: digits, problem: null, message: null };
}

export function isValidImei(input: string, options: ImeiOptions = {}): boolean {
  return checkImei(input, options).valid;
}

/**
 * Numéro de série : aucune règle universelle, on se contente d'un garde-fou.
 * Refuser un numéro de série valide chez un fournisseur exotique coûterait plus
 * cher que d'en accepter un mal formé.
 */
export function normalizeSerial(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, '');
}

export function isPlausibleSerial(input: string): boolean {
  const value = normalizeSerial(input);
  return value.length >= 3 && value.length <= 64 && /^[A-Z0-9._/-]+$/.test(value);
}
