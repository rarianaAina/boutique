import { formatAmount, formatMoney } from '@boutique/shared';
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import {
  A4,
  MISE_EN_PAGE,
  colonnes,
  couper,
  disposer,
  phraseEnLettres,
  type Colonne,
  type Mesurer,
  type PageDisposee,
} from './mise-en-page.js';
import type { DocumentFacture, Partie } from './modele.js';

/**
 * Le PDF lui-même.
 *
 * Ce module ne décide de RIEN : la mise en page a déjà réparti les articles et
 * mesuré les blocs, il ne fait que poser de l'encre aux endroits calculés.
 * C'est ce qui permet d'éprouver la pagination sans produire un octet de PDF.
 *
 * POURQUOI UN VRAI FICHIER et non l'impression du navigateur. Une facture se
 * garde, se joint à un courriel, s'envoie par WhatsApp, se ressort trois ans
 * plus tard pour une garantie. Une page imprimée dépend du pilote du poste et
 * ne laisse rien derrière elle ; un PDF s'affiche partout de la même façon.
 *
 * POURQUOI LES POLICES STANDARD. Helvetica est présente dans tous les lecteurs
 * de PDF : le fichier ne transporte aucune police, il pèse quelques dizaines
 * de kilo-octets, et s'ouvre sur un téléphone d'entrée de gamme. Le prix à
 * payer est l'encodage WinAnsi, qui ne connaît pas tous les caractères — voir
 * `winAnsi` plus bas.
 */

const ENCRE = rgb(0.09, 0.11, 0.15);
const ENCRE_PALE = rgb(0.42, 0.45, 0.5);
const TRAIT = rgb(0.8, 0.82, 0.85);
const FOND_TITRES = rgb(0.95, 0.96, 0.97);
const ALERTE = rgb(0.7, 0.15, 0.15);

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

/** Date ISO -> jj/mm/aaaa, sans dépendre des réglages de la machine. */
export function formaterDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const jour = String(date.getDate()).padStart(2, '0');
  const mois = String(date.getMonth() + 1).padStart(2, '0');
  return `${jour}/${mois}/${date.getFullYear()}`;
}

const LIBELLES_STATUT: Record<DocumentFacture['statut'], string> = {
  BROUILLON: 'Brouillon',
  EMISE: 'Émise',
  PAYEE: 'Payée',
  PARTIELLEMENT_PAYEE: 'Partiellement payée',
  ANNULEE: 'Annulée',
  REMBOURSEE: 'Remboursée',
};

interface Plume {
  page: PDFPage;
  normale: PDFFont;
  grasse: PDFFont;
}

interface Style {
  taille?: number;
  gras?: boolean;
  couleur?: ReturnType<typeof rgb>;
  /** `x` désigne alors le bord DROIT du texte. */
  droite?: boolean;
}

function ecrire(plume: Plume, texte: string, x: number, y: number, style: Style = {}): void {
  const taille = style.taille ?? MISE_EN_PAGE.taille;
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

function trait(page: PDFPage, x: number, y: number, largeur: number): void {
  page.drawRectangle({ x, y, width: largeur, height: 0.6, color: TRAIT });
}

/** Coordonnées et lignes d'une partie — émetteur ou destinataire. */
function lignesPartie(partie: Partie): string[] {
  const fiscal = [
    partie.nif ? `NIF ${partie.nif}` : null,
    partie.stat ? `STAT ${partie.stat}` : null,
  ].filter(Boolean);
  return [
    partie.adresse ?? null,
    partie.telephone ? `Tél. ${partie.telephone}` : null,
    partie.courriel ?? null,
    fiscal.length > 0 ? fiscal.join('   ') : null,
  ].filter((ligne): ligne is string => ligne !== null);
}

/** Produit le PDF complet de la facture. */
export async function pdfFacture(doc: DocumentFacture): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const normale = await pdf.embedFont(StandardFonts.Helvetica);
  const grasse = await pdf.embedFont(StandardFonts.HelveticaBold);

  const mesurer: Mesurer = (texte, taille, gras) =>
    (gras ? grasse : normale).widthOfTextAtSize(winAnsi(texte), taille);

  const cols = colonnes(doc);
  const pages = disposer(doc, mesurer);

  pdf.setTitle(`Facture ${doc.numero}`);
  pdf.setSubject(`Facture ${doc.numero} — ${doc.emetteur.nom}`);
  pdf.setProducer('MOBI STOCK');
  pdf.setCreator('MOBI STOCK');

  for (const disposee of pages) {
    const page = pdf.addPage([A4.largeur, A4.hauteur]);
    const plume: Plume = { page, normale, grasse };
    let y = A4.hauteur - MISE_EN_PAGE.marge;

    y = disposee.premiere ? enTeteComplet(plume, doc, y) : enTeteSuite(plume, doc, y, disposee);

    y = tableau(plume, doc, cols, disposee, y);

    if (disposee.derniere) piedDeFacture(plume, doc, y, mesurer);
    numeroterPage(plume, disposee, pages.length);
    if (doc.statut === 'ANNULEE') filigraneAnnulee(plume);
  }

  return pdf.save();
}

/** En-tête de la première page : émetteur, pavé du document, destinataire. */
function enTeteComplet(plume: Plume, doc: DocumentFacture, depart: number): number {
  const { marge, interligne, taille, taillePetit } = MISE_EN_PAGE;
  const droite = A4.largeur - marge;
  let y = depart - MISE_EN_PAGE.tailleTitre;

  ecrire(plume, doc.emetteur.nom.toUpperCase(), marge, y, {
    taille: MISE_EN_PAGE.tailleSousTitre + 3,
    gras: true,
  });

  ecrire(plume, 'FACTURE', droite, y, {
    taille: MISE_EN_PAGE.tailleTitre,
    gras: true,
    droite: true,
  });

  let gauche = y - 8;
  for (const ligne of lignesPartie(doc.emetteur)) {
    gauche -= interligne;
    ecrire(plume, ligne, marge, gauche, { taille: taillePetit, couleur: ENCRE_PALE });
  }
  for (const mention of doc.mentions) {
    gauche -= interligne;
    ecrire(plume, `${mention.libelle} : ${mention.valeur}`, marge, gauche, {
      taille: taillePetit,
      couleur: ENCRE_PALE,
    });
  }

  let pave = y - 8;
  const paveLigne = (libelle: string, valeur: string) => {
    pave -= interligne;
    ecrire(plume, libelle, droite - 96, pave, {
      taille: taillePetit,
      couleur: ENCRE_PALE,
      droite: true,
    });
    ecrire(plume, valeur, droite, pave, { taille, gras: true, droite: true });
  };
  paveLigne('Numéro', doc.numero);
  paveLigne('Date', formaterDate(doc.emiseLe));
  if (doc.echeanceLe) paveLigne('Échéance', formaterDate(doc.echeanceLe));
  paveLigne('Statut', LIBELLES_STATUT[doc.statut]);

  y = Math.min(gauche, pave) - 16;

  // Destinataire, encadré : c'est le bloc qu'un comptable cherche en premier.
  const largeurBloc = 250;
  const lignes = doc.destinataire ? lignesPartie(doc.destinataire) : [];
  const hauteurBloc = (2 + lignes.length) * interligne + 10;
  plume.page.drawRectangle({
    x: A4.largeur - marge - largeurBloc,
    y: y - hauteurBloc + interligne,
    width: largeurBloc,
    height: hauteurBloc,
    color: FOND_TITRES,
  });

  const xBloc = A4.largeur - marge - largeurBloc + 10;
  ecrire(plume, 'FACTURÉ À', xBloc, y, { taille: taillePetit, gras: true, couleur: ENCRE_PALE });
  y -= interligne;
  ecrire(plume, doc.destinataire?.nom ?? 'Client de passage', xBloc, y, { taille, gras: true });
  for (const ligne of lignes) {
    y -= interligne;
    ecrire(plume, ligne, xBloc, y, { taille: taillePetit, couleur: ENCRE_PALE });
  }

  return y - 18;
}

/** Bandeau de rappel des pages suivantes : on doit savoir de quoi il s'agit. */
function enTeteSuite(
  plume: Plume,
  doc: DocumentFacture,
  depart: number,
  page: PageDisposee,
): number {
  const { marge, tailleSousTitre, taillePetit } = MISE_EN_PAGE;
  const y = depart - tailleSousTitre;
  ecrire(plume, `${doc.emetteur.nom.toUpperCase()} — Facture ${doc.numero}`, marge, y, {
    taille: tailleSousTitre,
    gras: true,
  });
  ecrire(plume, `suite (page ${page.numero})`, A4.largeur - marge, y, {
    taille: taillePetit,
    couleur: ENCRE_PALE,
    droite: true,
  });
  return y - 14;
}

/** Le tableau des articles. */
function tableau(
  plume: Plume,
  doc: DocumentFacture,
  cols: Colonne[],
  page: PageDisposee,
  depart: number,
): number {
  const { marge, taille, taillePetit, interligne } = MISE_EN_PAGE;
  const largeurUtile = A4.largeur - 2 * marge;

  plume.page.drawRectangle({
    x: marge,
    y: depart - MISE_EN_PAGE.hauteurEnTeteTableau + 4,
    width: largeurUtile,
    height: MISE_EN_PAGE.hauteurEnTeteTableau,
    color: FOND_TITRES,
  });

  let x = marge;
  for (const col of cols) {
    ecrire(plume, col.titre, col.droite ? x + col.largeur - 6 : x + 6, depart - 8, {
      taille: taillePetit,
      gras: true,
      couleur: ENCRE_PALE,
      droite: col.droite,
    });
    x += col.largeur;
  }

  let y = depart - MISE_EN_PAGE.hauteurEnTeteTableau;

  for (const rangee of page.rangees) {
    // Base de la PREMIÈRE ligne de la rangée : toutes les cellules s'alignent
    // dessus, y compris celles d'une seule ligne face à une désignation qui en
    // prend trois.
    const base = y - MISE_EN_PAGE.hautDeRangee;
    x = marge;
    for (const col of cols) {
      const bordX = col.droite ? x + col.largeur - 6 : x + 6;
      if (col.cle === 'designation') {
        rangee.designation.forEach((morceau, rang) => {
          ecrire(plume, morceau, bordX, base - rang * interligne, { taille });
        });
      } else {
        ecrire(plume, celluleTexte(doc, rangee.ligne, col), bordX, base, {
          taille,
          droite: col.droite,
        });
      }
      x += col.largeur;
    }
    y -= rangee.hauteur;
    trait(plume.page, marge, y + 2, largeurUtile);
  }

  return y - 6;
}

function celluleTexte(
  doc: DocumentFacture,
  ligne: PageDisposee['rangees'][number]['ligne'],
  col: Colonne,
): string {
  switch (col.cle) {
    case 'identifiant':
      return ligne.identifiant ?? '—';
    case 'quantite':
      return String(ligne.quantite);
    case 'prixUnitaire':
      return formatAmount(ligne.prixUnitaire, doc.devise);
    case 'remise':
      return (ligne.remise ?? 0) > 0 ? `- ${formatAmount(ligne.remise ?? 0, doc.devise)}` : '';
    default:
      return formatAmount(ligne.total, doc.devise);
  }
}

/** Totaux, montant en lettres, règlements et mentions légales. */
function piedDeFacture(plume: Plume, doc: DocumentFacture, depart: number, mesurer: Mesurer): void {
  const { marge, interligne, taille, taillePetit } = MISE_EN_PAGE;
  const droite = A4.largeur - marge;
  let y = depart - 8;

  const total = (libelle: string, valeur: number, fort = false, couleur = ENCRE) => {
    y -= interligne;
    ecrire(plume, libelle, droite - 110, y, {
      taille,
      gras: fort,
      couleur: fort ? couleur : ENCRE_PALE,
      droite: true,
    });
    ecrire(plume, formatMoney(valeur, doc.devise), droite, y, {
      taille,
      gras: fort,
      couleur,
      droite: true,
    });
  };

  total('Sous-total', doc.sousTotal);
  if (doc.remise > 0) total('Remises', -doc.remise);
  if (doc.taxe > 0) total('TVA', doc.taxe);

  y -= 4;
  trait(plume.page, droite - 190, y, 190);
  total('TOTAL', doc.total, true);

  if (doc.regle > 0) total('Réglé', doc.regle);
  const reste = doc.total - doc.regle;
  if (reste > 0) total('Reste dû', reste, true, ALERTE);

  y -= 10;
  for (const morceau of couper(phraseEnLettres(doc), A4.largeur - 2 * marge, taille, mesurer)) {
    y -= interligne;
    ecrire(plume, morceau, marge, y, { taille, gras: true });
  }

  if (doc.reglements.length > 0) {
    y -= interligne;
    ecrire(plume, 'Règlements', marge, y, { taille: taillePetit, gras: true, couleur: ENCRE_PALE });
    for (const reglement of doc.reglements) {
      y -= 10;
      ecrire(
        plume,
        `${formaterDate(reglement.le)} — ${reglement.moyen} — ${formatMoney(reglement.montant, doc.devise)}`,
        marge,
        y,
        { taille: taillePetit, couleur: ENCRE_PALE },
      );
    }
  }

  for (const texte of [doc.notes, doc.piedDePage]) {
    if (!texte) continue;
    for (const morceau of couper(texte, A4.largeur - 2 * marge, taillePetit, mesurer)) {
      y -= 10;
      ecrire(plume, morceau, marge, y, { taille: taillePetit, couleur: ENCRE_PALE });
    }
  }
}

function numeroterPage(plume: Plume, page: PageDisposee, total: number): void {
  ecrire(
    plume,
    `Page ${page.numero} / ${total}`,
    A4.largeur - MISE_EN_PAGE.marge,
    MISE_EN_PAGE.marge - 14,
    { taille: MISE_EN_PAGE.taillePetit, couleur: ENCRE_PALE, droite: true },
  );
}

/**
 * « ANNULÉE » en travers de la page.
 *
 * Une facture annulée ne se détruit pas — elle garde son numéro dans la
 * série — mais elle ne doit jamais pouvoir être présentée comme valable, y
 * compris après avoir été imprimée puis photographiée.
 */
function filigraneAnnulee(plume: Plume): void {
  plume.page.drawText('ANNULÉE', {
    x: 110,
    y: 330,
    size: 96,
    font: plume.grasse,
    color: ALERTE,
    opacity: 0.14,
    rotate: degrees(28),
  });
}
