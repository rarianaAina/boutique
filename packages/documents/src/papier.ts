import { rgb, type PDFFont, type PDFPage } from 'pdf-lib';

/**
 * Le papier, l'encre et la plume — ce qui ne dépend d'aucun document.
 *
 * La facture n'est pas la seule pièce que ce logiciel imprime : le compte de
 * résultat en est une autre, et il y en aura d'autres. Ce qui leur est commun
 * vit ici — le format, les couleurs, l'écriture d'une ligne de texte, le
 * découpage d'un paragraphe, l'assainissement des caractères. Chaque document
 * garde pour lui ce qui le distingue : ses colonnes, ses blocs, ses règles de
 * pagination.
 */

/** A4 en points typographiques (72 par pouce). */
export const A4 = { largeur: 595.28, hauteur: 841.89 } as const;

/** Ce qui vaut pour toutes les pièces : marges, tailles, interligne. */
export const PAPIER = {
  marge: 42,
  /** Corps du texte courant. */
  taille: 9,
  tailleTitre: 20,
  tailleSousTitre: 11,
  taillePetit: 7.5,
  /** Hauteur d'une ligne de texte courant. */
  interligne: 11.5,
} as const;

export const ENCRE = rgb(0.09, 0.11, 0.15);
export const ENCRE_PALE = rgb(0.42, 0.45, 0.5);
export const TRAIT = rgb(0.8, 0.82, 0.85);
export const FOND_TITRES = rgb(0.95, 0.96, 0.97);
export const ALERTE = rgb(0.7, 0.15, 0.15);

/**
 * Ce que WinAnsi ne sait pas écrire, et ce qu'on met à la place.
 *
 * `formatMoney` sépare les milliers par une ESPACE FINE INSÉCABLE (U+202F),
 * qui ne casse jamais une ligne de ticket. WinAnsi ne la connaît pas, et
 * pdf-lib refuse d'écrire un caractère qu'il ne sait pas encoder : sans cette
 * table, toute facture portant un montant à quatre chiffres échouerait — donc
 * presque toutes.
 */
const REMPLACEMENTS: Record<string, string> = {
  '\u202f': '\u00a0', // espace fine insécable -> espace insécable
  '\u2009': '\u00a0', // espace fine
  '\u2011': '-', // trait d'union insécable
  '\u2212': '-', // signe moins
  '\u02bc': "'", // apostrophe modificative
};

/**
 * Les caractères que WinAnsi place AU-DESSUS de Latin-1.
 *
 * Ils ne se déduisent pas de leur point de code : WinAnsi les range entre 0x80
 * et 0x9F, là où Latin-1 n'a que des caractères de commande. Sans cette liste,
 * un tiret cadratin ou une apostrophe typographique deviendrait un point
 * d'interrogation au milieu d'une désignation.
 */
const SUPPLEMENT_WINANSI =
  '\u20ac\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u017d' +
  '\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u017e\u0178';

/**
 * Rend un texte écrivable par une police standard.
 *
 * Ce qui reste inconnu devient un point d'interrogation plutôt que de faire
 * échouer l'émission : une facture avec un caractère de travers reste une
 * facture, une facture qui ne s'imprime pas bloque une vente.
 */
export function winAnsi(texte: string): string {
  let propre = '';
  for (const lettre of texte) {
    const remplacement = REMPLACEMENTS[lettre];
    if (remplacement !== undefined) {
      propre += remplacement;
      continue;
    }
    const point = lettre.codePointAt(0) ?? 0;
    // Latin-1 et les quelques ajouts de WinAnsi (guillemets, œ, €...) tiennent
    // sous 0x2122 ; au-delà, aucune chance.
    propre += point <= 0xff || SUPPLEMENT_WINANSI.includes(lettre) ? lettre : '?';
  }
  return propre;
}

/**
 * Jour calendaire « aaaa-mm-jj » -> « jj/mm/aaaa », SANS passer par une date.
 *
 * `formaterDate` convertit en heure locale, ce qui est juste pour un instant —
 * une facture émise à 23 h 30 doit porter le jour où le commerçant l'a émise.
 * C'est faux pour une BORNE de période : « 2026-09-30T23:59:59.999Z » lu à
 * Antananarivo, trois heures en avance, devient le 1er octobre, et un compte
 * de résultat de septembre s'annonce « au 01/10 ». Une borne est un jour du
 * calendrier, pas un instant : on la lit telle qu'elle est écrite.
 */
export function formaterJour(jour: string): string {
  const trouve = /^(\d{4})-(\d{2})-(\d{2})/.exec(jour);
  if (!trouve) return '—';
  return `${trouve[3]}/${trouve[2]}/${trouve[1]}`;
}

/** Date ISO -> jj/mm/aaaa, sans dépendre des réglages de la machine. */
export function formaterDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const jour = String(date.getDate()).padStart(2, '0');
  const mois = String(date.getMonth() + 1).padStart(2, '0');
  return `${jour}/${mois}/${date.getFullYear()}`;
}

/** Mesure la largeur d'un texte. Fournie par le rendu. */
export type Mesurer = (texte: string, taille: number, gras?: boolean) => number;

/**
 * Découpe un texte pour qu'il tienne dans une largeur.
 *
 * La coupure se fait aux espaces. Un mot plus long que la colonne — une
 * référence sans espace, cela arrive — est coupé au caractère : mieux vaut une
 * césure disgracieuse qu'un texte qui déborde sur la colonne voisine.
 */
export function couper(
  texte: string,
  largeurMax: number,
  taille: number,
  mesurer: Mesurer,
): string[] {
  const propre = texte.replace(/\s+/g, ' ').trim();
  if (propre === '') return [''];

  const lignes: string[] = [];
  let courante = '';

  const poser = () => {
    if (courante !== '') lignes.push(courante);
    courante = '';
  };

  for (const mot of propre.split(' ')) {
    const essai = courante === '' ? mot : `${courante} ${mot}`;
    if (mesurer(essai, taille) <= largeurMax) {
      courante = essai;
      continue;
    }
    poser();

    if (mesurer(mot, taille) <= largeurMax) {
      courante = mot;
      continue;
    }
    // Mot plus large que la colonne : césure au caractère.
    let morceau = '';
    for (const lettre of mot) {
      if (mesurer(morceau + lettre, taille) > largeurMax && morceau !== '') {
        lignes.push(morceau);
        morceau = lettre;
      } else {
        morceau += lettre;
      }
    }
    courante = morceau;
  }
  poser();
  return lignes.length > 0 ? lignes : [''];
}

export interface Plume {
  page: PDFPage;
  normale: PDFFont;
  grasse: PDFFont;
}

export interface Style {
  taille?: number;
  gras?: boolean;
  couleur?: ReturnType<typeof rgb>;
  /** `x` désigne alors le bord DROIT du texte. */
  droite?: boolean;
}

export function ecrire(plume: Plume, texte: string, x: number, y: number, style: Style = {}): void {
  const taille = style.taille ?? PAPIER.taille;
  const police = style.gras ? plume.grasse : plume.normale;
  const propre = winAnsi(texte);
  const gauche = style.droite ? x - police.widthOfTextAtSize(propre, taille) : x;
  plume.page.drawText(propre, {
    x: gauche,
    y,
    size: taille,
    font: police,
    color: style.couleur ?? ENCRE,
  });
}

export function trait(page: PDFPage, x: number, y: number, largeur: number): void {
  page.drawRectangle({ x, y, width: largeur, height: 0.6, color: TRAIT });
}
