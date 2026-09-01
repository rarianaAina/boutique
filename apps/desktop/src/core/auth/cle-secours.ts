/**
 * Clé de secours de l'administrateur.
 *
 * LE PROBLÈME QU'ELLE RÈGLE. Un administrateur peut réinitialiser le mot de
 * passe de n'importe qui. Mais le DERNIER administrateur qui oublie le sien
 * n'a plus personne pour le débloquer, et ses données vivent dans une base
 * locale qu'aucun serveur ne connaît. Sans cette clé, le commerce est enfermé
 * dehors, définitivement.
 *
 * POURQUOI CETTE FORME. Elle est remise UNE FOIS, à l'installation, et n'existe
 * ensuite nulle part dans le logiciel : seule son empreinte est conservée,
 * hachée comme un mot de passe. Cela ferme les deux autres chemins qu'on aurait
 * pu prendre — un fichier déposé sur le poste, qui aurait donné le compte
 * administrateur à quiconque a accès au PC de la boutique ; et un code émis par
 * l'éditeur, qui aurait supposé qu'on puisse le joindre un samedi.
 *
 * Le prix est assumé : perdue, elle ne se retrouve pas. C'est pourquoi
 * l'installation oblige à confirmer qu'on l'a notée, et qu'on peut en produire
 * une nouvelle depuis les paramètres.
 */

/**
 * Alphabet sans caractères confondables.
 *
 * Ni I ni 1, ni O ni 0, ni 8 ni B : cette clé se recopie à la main, souvent
 * depuis un carnet, parfois des mois plus tard. Une lettre lue de travers
 * transformerait un dépannage de deux minutes en perte de données.
 */
const ALPHABET = 'ACDEFGHJKLMNPQRSTUVWXYZ2345679';

/** Nombre de signes. 25 signes sur 30 symboles ≈ 122 bits : hors de portée. */
const LONGUEUR = 25;

/** Groupes de cinq, séparés par des tirets : c'est ce qui se dicte sans erreur. */
export function formaterCleSecours(brute: string): string {
  return (brute.match(/.{1,5}/g) ?? []).join('-');
}

/**
 * Ramène une saisie à sa forme canonique.
 *
 * On accepte les minuscules, les espaces et les tirets placés n'importe où :
 * la personne qui saisit cette clé vient de perdre l'accès à son logiciel, ce
 * n'est pas le moment de lui reprocher une majuscule.
 */
export function normaliserCleSecours(saisie: string): string {
  return saisie.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Tire une clé neuve. Le hasard vient de WebCrypto, jamais de `Math.random`. */
export function genererCleSecours(): string {
  const octets = crypto.getRandomValues(new Uint8Array(LONGUEUR));
  let brute = '';
  for (const octet of octets) {
    // Le modulo introduit un biais négligeable ici — 256 n'est pas un multiple
    // de 30 — mais il reste sans conséquence sur 122 bits d'entropie.
    brute += ALPHABET[octet % ALPHABET.length];
  }
  return formaterCleSecours(brute);
}

/** Une saisie a-t-elle la forme d'une clé de secours ? */
export function cleSecoursPlausible(saisie: string): boolean {
  const propre = normaliserCleSecours(saisie);
  return propre.length === LONGUEUR && [...propre].every((signe) => ALPHABET.includes(signe));
}
