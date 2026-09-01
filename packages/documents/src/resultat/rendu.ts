import { formatMoney } from '@boutique/shared';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { montantEnLettres } from '../en-lettres.js';
import {
  A4,
  ALERTE,
  ENCRE,
  ENCRE_PALE,
  FOND_TITRES,
  PAPIER,
  couper,
  ecrire,
  formaterDate,
  formaterJour,
  trait,
  winAnsi,
  type Mesurer,
  type Plume,
} from '../papier.js';
import type { DocumentResultat, LigneResultat } from './modele.js';

/**
 * Le compte de résultat en PDF.
 *
 * UNE SEULE PAGE, et ce n'est pas une limite mais une intention : ce document
 * se lit d'un coup d'œil ou ne se lit pas. Les douze catégories de charges
 * tiennent largement, et si un jour elles ne tenaient plus, c'est le
 * découpage des catégories qu'il faudrait revoir, pas la pagination.
 *
 * LE RÉSULTAT EST ÉCRIT EN TOUTES LETTRES comme sur une facture. C'est la
 * ligne que le commerçant montrera à sa banque ou à son associé, et un chiffre
 * en lettres ne se retouche pas au stylo.
 */

const BLOC = {
  /** Largeur de la colonne des montants, alignés à droite. */
  montants: 120,
  /** Hauteur d'une ligne du corps. */
  ligne: 15,
} as const;

export async function pdfResultat(doc: DocumentResultat): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const normale = await pdf.embedFont(StandardFonts.Helvetica);
  const grasse = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mesurer: Mesurer = (texte, taille, gras) =>
    (gras ? grasse : normale).widthOfTextAtSize(winAnsi(texte), taille);

  pdf.setTitle(`Compte de résultat ${formaterJour(doc.du)} - ${formaterJour(doc.au)}`);
  pdf.setProducer('MOBI STOCK');
  pdf.setCreator('MOBI STOCK');

  const page = pdf.addPage([A4.largeur, A4.hauteur]);
  const plume: Plume = { page, normale, grasse };
  const { marge, interligne, taille, taillePetit } = PAPIER;
  const droite = A4.largeur - marge;

  let y = A4.hauteur - marge - PAPIER.tailleTitre;

  /* ─── En-tête ───────────────────────────────────────────────────────── */

  ecrire(plume, doc.emetteur.nom.toUpperCase(), marge, y, {
    taille: PAPIER.tailleSousTitre + 3,
    gras: true,
  });
  ecrire(plume, 'COMPTE DE RÉSULTAT', droite, y, {
    taille: PAPIER.tailleTitre - 2,
    gras: true,
    droite: true,
  });

  y -= 14;
  const fiscal = [
    doc.emetteur.nif ? `NIF ${doc.emetteur.nif}` : null,
    doc.emetteur.stat ? `STAT ${doc.emetteur.stat}` : null,
  ].filter(Boolean);
  if (fiscal.length > 0) {
    ecrire(plume, fiscal.join('   '), marge, y, { taille: taillePetit, couleur: ENCRE_PALE });
  }
  ecrire(plume, `Du ${formaterJour(doc.du)} au ${formaterJour(doc.au)}`, droite, y, {
    taille,
    gras: true,
    droite: true,
  });

  y -= interligne;
  ecrire(plume, `Établi le ${formaterDate(doc.etabliLe)}`, droite, y, {
    taille: taillePetit,
    couleur: ENCRE_PALE,
    droite: true,
  });

  y -= 22;

  /* ─── Corps ─────────────────────────────────────────────────────────── */

  const titre = (texte: string) => {
    y -= 6;
    plume.page.drawRectangle({
      x: marge,
      y: y - 4,
      width: A4.largeur - 2 * marge,
      height: 16,
      color: FOND_TITRES,
    });
    ecrire(plume, texte, marge + 6, y, { taille: taillePetit, gras: true, couleur: ENCRE_PALE });
    y -= BLOC.ligne + 2;
  };

  const ligne = (element: LigneResultat, style: { gras?: boolean; signe?: '-' } = {}) => {
    ecrire(plume, element.libelle, marge + 6, y, { taille, gras: style.gras });
    if (element.detail) {
      ecrire(
        plume,
        element.detail,
        marge + 6 + mesurer(element.libelle, taille, style.gras) + 8,
        y,
        {
          taille: taillePetit,
          couleur: ENCRE_PALE,
        },
      );
    }
    const montant = formatMoney(element.montant, doc.devise);
    ecrire(plume, style.signe ? `${style.signe} ${montant}` : montant, droite - 6, y, {
      taille,
      gras: style.gras,
      droite: true,
    });
    y -= BLOC.ligne;
  };

  const sousTotal = (libelle: string, montant: number, couleur = ENCRE) => {
    y += 2;
    trait(plume.page, droite - BLOC.montants - 6, y + BLOC.ligne - 4, BLOC.montants + 6);
    ecrire(plume, libelle, marge + 6, y, { taille, gras: true, couleur });
    ecrire(plume, formatMoney(montant, doc.devise), droite - 6, y, {
      taille,
      gras: true,
      couleur,
      droite: true,
    });
    y -= BLOC.ligne + 4;
  };

  titre('PRODUITS');
  doc.produits.forEach((element, rang) => ligne(element, { signe: rang > 0 ? '-' : undefined }));
  sousTotal("CHIFFRE D'AFFAIRES NET", doc.chiffreAffairesNet);

  titre('COÛT DES MARCHANDISES VENDUES');
  ligne(
    {
      libelle: 'Prix de revient des articles sortis',
      montant: doc.coutMarchandises,
      detail: 'frais d’approche compris',
    },
    { signe: '-' },
  );
  sousTotal('MARGE BRUTE', doc.margeBrute, doc.margeBrute < 0 ? ALERTE : ENCRE);
  // Virgule décimale : c'est un document français, et « 27.7 % » se remarque.
  const taux = (doc.tauxMarge / 100).toFixed(1).replace('.', ',');
  ecrire(plume, `Taux de marge : ${taux} %`, marge + 6, y + 6, {
    taille: taillePetit,
    couleur: ENCRE_PALE,
  });
  y -= 8;

  titre("CHARGES D'EXPLOITATION");
  if (doc.charges.length === 0) {
    ecrire(plume, 'Aucune charge saisie sur la période.', marge + 6, y, {
      taille,
      couleur: ENCRE_PALE,
    });
    y -= BLOC.ligne;
  } else {
    for (const charge of doc.charges) ligne(charge, { signe: '-' });
  }
  sousTotal('TOTAL DES CHARGES', doc.totalCharges);

  /* ─── Résultat ──────────────────────────────────────────────────────── */

  const beneficiaire = doc.resultat >= 0;
  y -= 6;
  plume.page.drawRectangle({
    x: marge,
    y: y - 10,
    width: A4.largeur - 2 * marge,
    height: 28,
    color: FOND_TITRES,
  });
  ecrire(plume, beneficiaire ? 'RÉSULTAT — BÉNÉFICE' : 'RÉSULTAT — PERTE', marge + 8, y, {
    taille: PAPIER.tailleSousTitre,
    gras: true,
    couleur: beneficiaire ? ENCRE : ALERTE,
  });
  ecrire(plume, formatMoney(doc.resultat, doc.devise), droite - 8, y, {
    taille: PAPIER.tailleSousTitre,
    gras: true,
    couleur: beneficiaire ? ENCRE : ALERTE,
    droite: true,
  });

  y -= 34;
  for (const morceau of couper(
    `Soit ${montantEnLettres(Math.abs(doc.resultat), doc.devise)}${beneficiaire ? '' : ' de perte'}.`,
    A4.largeur - 2 * marge,
    taille,
    mesurer,
  )) {
    ecrire(plume, morceau, marge, y, { taille, gras: true });
    y -= interligne;
  }

  /* ─── Ce que ce document n'est pas ──────────────────────────────────── */

  y -= 10;
  for (const morceau of couper(doc.avertissement, A4.largeur - 2 * marge, taillePetit, mesurer)) {
    ecrire(plume, morceau, marge, y, { taille: taillePetit, couleur: ENCRE_PALE });
    y -= 10;
  }

  return pdf.save();
}
