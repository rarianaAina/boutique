import { montantEnLettres } from './en-lettres.js';
import type { DocumentFacture, LigneFacture } from './modele.js';

/**
 * Où chaque chose se pose sur la feuille.
 *
 * CE MODULE NE PRODUIT PAS DE PDF, et c'est tout son intérêt. La pagination
 * est la partie qui casse : une facture de trois articles tient sur une page
 * et ne prouve rien ; une facture de quatre-vingts articles révèle les orphelins,
 * les totaux repoussés seuls sur une feuille blanche, les désignations qui
 * débordent dans la colonne voisine. Séparé du rendu, tout cela s'éprouve.
 *
 * La largeur d'un texte dépend de la police : elle est FOURNIE par l'appelant
 * plutôt que devinée. Le rendu passe les mesures réelles de pdf-lib, les
 * épreuves passent une règle simple, et les deux exercent le même code.
 */

/** A4 en points typographiques (72 par pouce). */
export const A4 = { largeur: 595.28, hauteur: 841.89 } as const;

export const MISE_EN_PAGE = {
  marge: 42,
  /** Corps du texte courant. */
  taille: 9,
  tailleTitre: 20,
  tailleSousTitre: 11,
  taillePetit: 7.5,
  /** Hauteur d'une ligne de texte courant. */
  interligne: 11.5,
  /**
   * Du haut d'une rangée à la BASE de sa première ligne de texte.
   *
   * Une lettre s'écrit au-dessus de sa ligne de base : poser le texte trop
   * haut le fait mordre sur la rangée précédente, trop bas le fait barrer par
   * le filet de séparation. Ces deux valeurs ont été réglées en regardant le
   * document produit, pas en le supposant.
   */
  hautDeRangee: 11,
  /** De la base de la dernière ligne au filet, pour laisser passer les jambages. */
  basDeRangee: 6,
  /** Hauteur de la barre d'en-tête du tableau. */
  hauteurEnTeteTableau: 18,
  /**
   * Nombre maximal de lignes d'une désignation.
   *
   * Une désignation démesurée est tronquée plutôt que de faire grandir la
   * rangée sans limite : une seule rangée plus haute qu'une page empêcherait
   * la pagination d'avancer, et le document ne se terminerait jamais.
   */
  lignesDesignation: 3,
} as const;

/** Mesure la largeur d'un texte. Fournie par le rendu. */
export type Mesurer = (texte: string, taille: number, gras?: boolean) => number;

export interface Colonne {
  cle: 'designation' | 'identifiant' | 'quantite' | 'prixUnitaire' | 'remise' | 'total';
  titre: string;
  /** Largeur en points. */
  largeur: number;
  droite: boolean;
}

/**
 * Colonnes du tableau, adaptées au contenu.
 *
 * `Identifiant` ne s'affiche que si au moins un article en porte un : sur une
 * facture d'accessoires, une colonne vide sur toute la hauteur donne
 * l'impression d'un document mal rempli. `Remise` de même.
 */
export function colonnes(doc: DocumentFacture): Colonne[] {
  const utile = A4.largeur - 2 * MISE_EN_PAGE.marge;
  const avecIdentifiant = doc.lignes.some((ligne) => (ligne.identifiant ?? '') !== '');
  const avecRemise = doc.lignes.some((ligne) => (ligne.remise ?? 0) > 0);

  const fixes: Colonne[] = [
    { cle: 'quantite', titre: 'Qté', largeur: 34, droite: true },
    { cle: 'prixUnitaire', titre: 'P.U.', largeur: 78, droite: true },
    ...(avecRemise ? [{ cle: 'remise' as const, titre: 'Remise', largeur: 66, droite: true }] : []),
    { cle: 'total', titre: 'Montant', largeur: 84, droite: true },
  ];
  const identifiant: Colonne[] = avecIdentifiant
    ? [{ cle: 'identifiant', titre: 'Identifiant', largeur: 108, droite: false }]
    : [];

  const reste = utile - [...fixes, ...identifiant].reduce((somme, col) => somme + col.largeur, 0);
  return [
    { cle: 'designation', titre: 'Désignation', largeur: reste, droite: false },
    ...identifiant,
    ...fixes,
  ];
}

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

/** Hauteur d'une rangée portant `lignes` lignes de désignation. */
export function hauteurRangee(lignes: number): number {
  return (
    MISE_EN_PAGE.hautDeRangee +
    Math.max(0, lignes - 1) * MISE_EN_PAGE.interligne +
    MISE_EN_PAGE.basDeRangee
  );
}

export interface RangeeDisposee {
  ligne: LigneFacture;
  /** Désignation déjà découpée, prête à être écrite telle quelle. */
  designation: string[];
  hauteur: number;
}

export interface PageDisposee {
  /** Rang de la page, à partir de 1. */
  numero: number;
  rangees: RangeeDisposee[];
  /** La première porte l'en-tête complet : émetteur, destinataire, mentions. */
  premiere: boolean;
  /** La dernière porte les totaux, le montant en lettres et le pied. */
  derniere: boolean;
}

export interface Hauteurs {
  /** En-tête complet, sur la première page seulement. */
  enTetePremiere: number;
  /** Bandeau de rappel, sur les pages suivantes. */
  enTeteSuite: number;
  /** Totaux, montant en lettres, règlements, pied — sur la dernière page. */
  pied: number;
  /** Numéro de page, présent sur toutes. */
  numerotation: number;
}

/**
 * Hauteur de chaque bloc fixe, en points.
 *
 * Calculée à partir du contenu réel : un émetteur sans NIF prend une ligne de
 * moins, et cette ligne-là décide parfois qu'un article de plus tient sur la
 * première page.
 */
export function hauteurs(doc: DocumentFacture, mesurer: Mesurer): Hauteurs {
  const { interligne, marge } = MISE_EN_PAGE;

  const lignesEmetteur =
    1 + // nom
    [doc.emetteur.adresse, doc.emetteur.telephone, doc.emetteur.courriel].filter(Boolean).length +
    (doc.emetteur.nif || doc.emetteur.stat ? 1 : 0) +
    doc.mentions.length;

  const lignesDestinataire = doc.destinataire
    ? 2 + // « Facturé à » et le nom
      [doc.destinataire.adresse, doc.destinataire.telephone].filter(Boolean).length +
      (doc.destinataire.nif || doc.destinataire.stat ? 1 : 0)
    : 2;

  // Le pavé de droite — titre, numéro, dates — a sa propre hauteur ; l'en-tête
  // prend la plus grande des deux colonnes.
  const lignesPave = 3 + (doc.echeanceLe ? 1 : 0);

  const enTetePremiere =
    MISE_EN_PAGE.tailleTitre +
    8 +
    Math.max(lignesEmetteur, lignesPave) * interligne +
    16 +
    lignesDestinataire * interligne +
    18;

  const largeurLettres = A4.largeur - 2 * marge;
  const lignesEnLettres = couper(
    phraseEnLettres(doc),
    largeurLettres,
    MISE_EN_PAGE.taille,
    mesurer,
  ).length;

  const lignesTotaux =
    2 + // sous-total, total
    (doc.remise > 0 ? 1 : 0) +
    (doc.taxe > 0 ? 1 : 0) +
    (doc.regle > 0 ? 1 : 0) +
    (doc.total - doc.regle > 0 ? 1 : 0);

  const lignesPied =
    (doc.reglements.length > 0 ? doc.reglements.length + 1 : 0) +
    (doc.notes ? couper(doc.notes, largeurLettres, MISE_EN_PAGE.taillePetit, mesurer).length : 0) +
    (doc.piedDePage
      ? couper(doc.piedDePage, largeurLettres, MISE_EN_PAGE.taillePetit, mesurer).length
      : 0);

  return {
    enTetePremiere,
    enTeteSuite: MISE_EN_PAGE.tailleSousTitre + 14,
    pied: 14 + lignesTotaux * interligne + 10 + lignesEnLettres * interligne + 8 + lignesPied * 10,
    numerotation: 16,
  };
}

/**
 * La phrase du montant en toutes lettres, telle qu'elle sera imprimée.
 *
 * Calculée ici plutôt qu'estimée : sur un montant en millions d'ariary elle
 * dépasse la largeur de la page, et une estimation qui se tromperait d'une
 * ligne ferait déborder le pied hors de la feuille.
 */
export function phraseEnLettres(doc: DocumentFacture): string {
  return `Arrêtée la présente facture à la somme de ${montantEnLettres(doc.total, doc.devise)}.`;
}

/**
 * Répartit les articles sur les pages.
 *
 * DEUX GARANTIES, et ce sont elles que les épreuves vérifient : chaque article
 * paraît une fois et une seule, dans l'ordre ; et les totaux ne se retrouvent
 * jamais seuls sur une page — s'ils ne tiennent pas sous le dernier article,
 * c'est le dernier article qui passe à la page suivante avec eux.
 */
export function disposer(doc: DocumentFacture, mesurer: Mesurer): PageDisposee[] {
  const cols = colonnes(doc);
  const colonneDesignation = cols.find((col) => col.cle === 'designation');
  const largeurDesignation = (colonneDesignation?.largeur ?? 200) - 8;
  const blocs = hauteurs(doc, mesurer);

  const rangees: RangeeDisposee[] = doc.lignes.map((ligne) => {
    const entiere = couper(ligne.designation, largeurDesignation, MISE_EN_PAGE.taille, mesurer);
    const decoupee = entiere.slice(0, MISE_EN_PAGE.lignesDesignation);
    // Une désignation coupée doit LE DIRE : sans les points de suspension, la
    // phrase s'arrête net et le lecteur croit lire l'article entier.
    if (entiere.length > decoupee.length) {
      const derniere = decoupee.length - 1;
      decoupee[derniere] = `${decoupee[derniere]}…`;
    }
    return {
      ligne,
      designation: decoupee,
      hauteur: hauteurRangee(decoupee.length),
    };
  });

  const utile = (premiere: boolean) =>
    A4.hauteur -
    2 * MISE_EN_PAGE.marge -
    (premiere ? blocs.enTetePremiere : blocs.enTeteSuite) -
    MISE_EN_PAGE.hauteurEnTeteTableau -
    blocs.numerotation;

  const pages: RangeeDisposee[][] = [];
  let courante: RangeeDisposee[] = [];
  let restant = utile(true);

  for (const rangee of rangees) {
    if (rangee.hauteur > restant && courante.length > 0) {
      pages.push(courante);
      courante = [];
      restant = utile(false);
    }
    courante.push(rangee);
    restant -= rangee.hauteur;
  }
  pages.push(courante);

  // Les totaux tiennent-ils sous le dernier article ?
  //
  // Sinon, on fait passer le dernier article à la page suivante avec eux :
  // une page qui ne porterait que des totaux se lit comme une pièce
  // incomplète. Mais seulement si cela résout quelque chose — quand la
  // dernière page ne porte déjà qu'un seul article, le déplacer reproduirait
  // la même situation, et il faut se résoudre à une page de totaux.
  if (restant < blocs.pied) {
    const derniere = pages[pages.length - 1] as RangeeDisposee[];
    const dernierArticle = derniere[derniere.length - 1];
    const placeSurPageNeuve = utile(false) - (dernierArticle?.hauteur ?? 0);

    if (dernierArticle && derniere.length > 1 && placeSurPageNeuve >= blocs.pied) {
      derniere.pop();
      pages.push([dernierArticle]);
    } else {
      pages.push([]);
    }
  }

  return pages.map((contenu, rang) => ({
    numero: rang + 1,
    rangees: contenu,
    premiere: rang === 0,
    derniere: rang === pages.length - 1,
  }));
}
