import { formatAmount, formatMoney } from '@boutique/shared';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import {
  A4,
  ALERTE,
  ENCRE,
  ENCRE_PALE,
  FOND_TITRES,
  TRAIT,
  couper,
  ecrire,
  formaterDate,
  trait,
  winAnsi,
  type Mesurer,
  type Plume,
} from '../papier.js';
import {
  MISE_EN_PAGE,
  colonnes,
  disposer,
  phraseEnLettres,
  type Colonne,
  type PageDisposee,
} from './mise-en-page.js';
import type { DocumentFacture, Partie, Signatures } from './modele.js';

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

const LIBELLES_STATUT: Record<DocumentFacture['statut'], string> = {
  BROUILLON: 'Brouillon',
  EMISE: 'Émise',
  PAYEE: 'Payée',
  PARTIELLEMENT_PAYEE: 'Partiellement payée',
  ANNULEE: 'Annulée',
  REMBOURSEE: 'Remboursée',
};

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

/** Une image prête à être posée, déjà réduite au cadre réservé. */
interface LogoPose {
  image: Awaited<ReturnType<PDFDocument['embedPng']>>;
  largeur: number;
  hauteur: number;
}

/**
 * Charge le logo et le réduit au cadre, en gardant ses proportions.
 *
 * UN LOGO ABSENT VAUT MIEUX QU'UNE FACTURE QUI N'EXISTE PAS : si l'image est
 * d'un format inattendu ou abîmée, on l'ignore et l'on imprime la facture sans
 * elle. Le commerçant remarquera l'absence du logo ; il ne remarquerait pas
 * une vente qu'il n'a pas pu facturer.
 */
async function chargerLogo(pdf: PDFDocument, uri: string | null): Promise<LogoPose | null> {
  if (!uri) return null;
  try {
    const virgule = uri.indexOf(',');
    const brut = virgule >= 0 ? uri.slice(virgule + 1) : uri;
    const octets = Uint8Array.from(atob(brut), (lettre) => lettre.charCodeAt(0));
    const image = /^data:image\/jpe?g/i.test(uri)
      ? await pdf.embedJpg(octets)
      : await pdf.embedPng(octets);

    const cadre = MISE_EN_PAGE.logo;
    const facteur = Math.min(cadre.largeur / image.width, cadre.hauteur / image.height, 1);
    return { image, largeur: image.width * facteur, hauteur: image.height * facteur };
  } catch {
    return null;
  }
}

/** Produit le PDF complet de la facture. */
export async function pdfFacture(doc: DocumentFacture): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const normale = await pdf.embedFont(StandardFonts.Helvetica);
  const grasse = await pdf.embedFont(StandardFonts.HelveticaBold);

  const mesurer: Mesurer = (texte, taille, gras) =>
    (gras ? grasse : normale).widthOfTextAtSize(winAnsi(texte), taille);

  const cols = colonnes(doc);
  // La place du logo est réservée par la mise en page à partir du CADRE, pas
  // de l'image : une image trop haute est réduite, une image illisible laisse
  // le cadre vide. Dans les deux cas la hauteur réservée est la même, et le
  // tableau commence au même endroit.
  const logo = await chargerLogo(pdf, doc.logo);
  const pages = disposer(doc, mesurer);

  pdf.setTitle(`Facture ${doc.numero}`);
  pdf.setSubject(`Facture ${doc.numero} — ${doc.emetteur.nom}`);
  pdf.setProducer('MOBI STOCK');
  pdf.setCreator('MOBI STOCK');

  for (const disposee of pages) {
    const page = pdf.addPage([A4.largeur, A4.hauteur]);
    const plume: Plume = { page, normale, grasse };
    let y = A4.hauteur - MISE_EN_PAGE.marge;

    y = disposee.premiere
      ? enTeteComplet(plume, doc, y, logo)
      : enTeteSuite(plume, doc, y, disposee);

    y = tableau(plume, doc, cols, disposee, y);

    if (disposee.derniere) piedDeFacture(plume, doc, y, mesurer);
    numeroterPage(plume, disposee, pages.length);
    if (doc.statut === 'ANNULEE') filigraneAnnulee(plume);
  }

  return pdf.save();
}

/** En-tête de la première page : émetteur, pavé du document, destinataire. */
function enTeteComplet(
  plume: Plume,
  doc: DocumentFacture,
  depart: number,
  logo: LogoPose | null,
): number {
  const { marge, interligne, taille, taillePetit } = MISE_EN_PAGE;
  const droite = A4.largeur - marge;
  let haut = depart;

  if (doc.logo) {
    if (logo) {
      plume.page.drawImage(logo.image, {
        x: marge,
        y: haut - logo.hauteur,
        width: logo.largeur,
        height: logo.hauteur,
      });
    }
    haut -= MISE_EN_PAGE.logo.hauteur + 8;
  }

  let y = haut - MISE_EN_PAGE.tailleTitre;

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

  if (doc.conditions) {
    y -= 10;
    ecrire(plume, 'CONDITIONS DE VENTE', marge, y, {
      taille: taillePetit,
      gras: true,
      couleur: ENCRE_PALE,
    });
    for (const morceau of couper(doc.conditions, A4.largeur - 2 * marge, taillePetit, mesurer)) {
      y -= 10;
      ecrire(plume, morceau, marge, y, { taille: taillePetit, couleur: ENCRE_PALE });
    }
  }

  if (doc.signatures) casesASigner(plume, doc.signatures, y - 12);
}

/**
 * Les deux cases à signer.
 *
 * UN CADRE et non un simple trait : sur une facture photographiée ou passée au
 * télécopieur, un trait seul se confond avec le reste du document, et l'on
 * discute ensuite de savoir si le client avait signé ou non.
 */
function casesASigner(plume: Plume, signatures: Signatures, depart: number): void {
  const { marge, taillePetit, hauteurSignature } = MISE_EN_PAGE;
  const largeur = (A4.largeur - 2 * marge - 24) / 2;

  [signatures.gauche, signatures.droite].forEach((libelle, rang) => {
    const x = marge + rang * (largeur + 24);
    plume.page.drawRectangle({
      x,
      y: depart - hauteurSignature,
      width: largeur,
      height: hauteurSignature,
      borderColor: TRAIT,
      borderWidth: 0.6,
    });
    ecrire(plume, libelle, x + 8, depart - 13, { taille: taillePetit, gras: true });
    ecrire(plume, 'Date et signature', x + 8, depart - 25, {
      taille: taillePetit,
      couleur: ENCRE_PALE,
    });
  });
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
