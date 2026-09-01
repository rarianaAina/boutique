import { DEFAULT_CURRENCY } from '@boutique/shared';
import { describe, expect, it } from 'vitest';
import {
  A4,
  MISE_EN_PAGE,
  colonnes,
  couper,
  disposer,
  hauteurs,
  type Mesurer,
} from '../src/mise-en-page.js';
import type { DocumentFacture, LigneFacture } from '../src/modele.js';

/**
 * Une règle simple à la place des vraies métriques de police : les épreuves
 * n'ont pas à dépendre de la largeur exacte d'un « g » en Helvetica, elles ont
 * à vérifier que la pagination tient ses promesses quelle que soit la mesure.
 */
const mesurer: Mesurer = (texte, taille) => texte.length * taille * 0.5;

function article(rang: number, designation = `Article ${rang}`): LigneFacture {
  return { designation, quantite: 1, prixUnitaire: 10_000, total: 10_000 };
}

function facture(lignes: LigneFacture[], extra: Partial<DocumentFacture> = {}): DocumentFacture {
  const total = lignes.reduce((somme, ligne) => somme + ligne.total, 0);
  return {
    emetteur: { nom: 'MOBI STOCK', adresse: 'Antananarivo', nif: '1234', stat: '5678' },
    mentions: [],
    destinataire: { nom: 'Client', adresse: 'Toamasina' },
    numero: 'FA-2026-0001',
    emiseLe: '2026-09-01T08:00:00.000Z',
    statut: 'EMISE',
    lignes,
    sousTotal: total,
    remise: 0,
    taxe: 0,
    total,
    regle: 0,
    reglements: [],
    devise: DEFAULT_CURRENCY,
    piedDePage: '',
    ...extra,
  };
}

/** Hauteur réellement occupée par une page, en points. */
function occupation(doc: DocumentFacture, page: ReturnType<typeof disposer>[number]): number {
  const blocs = hauteurs(doc, mesurer);
  return (
    (page.premiere ? blocs.enTetePremiere : blocs.enTeteSuite) +
    MISE_EN_PAGE.hauteurEnTeteTableau +
    page.rangees.reduce((somme, rangee) => somme + rangee.hauteur, 0) +
    (page.derniere ? blocs.pied : 0) +
    blocs.numerotation
  );
}

describe('découpe du texte', () => {
  it('coupe aux espaces', () => {
    // 60 points, soit treize caractères à cette taille : « un deux trois »
    // passe tout juste, « quatre » va à la ligne.
    expect(couper('un deux trois quatre', 60, 9, mesurer)).toEqual(['un deux trois', 'quatre']);
  });

  it('coupe au caractère un mot plus large que la colonne', () => {
    // Une référence sans espace, cela existe : mieux vaut une césure
    // disgracieuse qu'un texte qui déborde sur la colonne voisine.
    const morceaux = couper('AAAAAAAAAAAAAAAAAAAA', 20, 9, mesurer);
    expect(morceaux.length).toBeGreaterThan(1);
    expect(morceaux.join('')).toBe('AAAAAAAAAAAAAAAAAAAA');
  });

  it('rend toujours au moins une ligne', () => {
    expect(couper('', 100, 9, mesurer)).toEqual(['']);
    expect(couper('   ', 100, 9, mesurer)).toEqual(['']);
  });
});

describe('colonnes', () => {
  it('n’affiche l’identifiant que si un article en porte un', () => {
    const sans = colonnes(facture([article(1)]));
    expect(sans.map((col) => col.cle)).not.toContain('identifiant');

    const avec = colonnes(facture([{ ...article(1), identifiant: '350000000000001' }]));
    expect(avec.map((col) => col.cle)).toContain('identifiant');
  });

  it('n’affiche la remise que si un article en porte une', () => {
    expect(colonnes(facture([article(1)])).map((col) => col.cle)).not.toContain('remise');
    expect(colonnes(facture([{ ...article(1), remise: 500 }])).map((col) => col.cle)).toContain(
      'remise',
    );
  });

  it('occupe exactement la largeur utile', () => {
    for (const doc of [
      facture([article(1)]),
      facture([{ ...article(1), identifiant: 'X', remise: 1 }]),
    ]) {
      const somme = colonnes(doc).reduce((total, col) => total + col.largeur, 0);
      expect(somme).toBeCloseTo(A4.largeur - 2 * MISE_EN_PAGE.marge, 6);
    }
  });
});

describe('pagination', () => {
  it('tient sur une page quand le commerce est petit', () => {
    const pages = disposer(facture([article(1), article(2), article(3)]), mesurer);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.premiere).toBe(true);
    expect(pages[0]?.derniere).toBe(true);
  });

  it('n’oublie ni ne répète aucun article, quel qu’en soit le nombre', () => {
    for (const combien of [1, 12, 40, 80, 250]) {
      const lignes = Array.from({ length: combien }, (_, rang) => article(rang + 1));
      const pages = disposer(facture(lignes), mesurer);
      const vues = pages.flatMap((page) => page.rangees.map((rangee) => rangee.ligne.designation));
      expect(vues).toEqual(lignes.map((ligne) => ligne.designation));
    }
  });

  it('ne fait jamais déborder une page', () => {
    for (const combien of [1, 12, 40, 80, 250]) {
      const doc = facture(Array.from({ length: combien }, (_, rang) => article(rang + 1)));
      for (const page of disposer(doc, mesurer)) {
        expect(occupation(doc, page)).toBeLessThanOrEqual(A4.hauteur - 2 * MISE_EN_PAGE.marge);
      }
    }
  });

  it('ne laisse pas les totaux seuls quand un article peut les accompagner', () => {
    // On cherche le nombre d'articles qui remplit la première page à ras : le
    // repli doit alors emmener le dernier article avec les totaux.
    let trouve = false;
    for (let combien = 2; combien < 60; combien += 1) {
      const doc = facture(Array.from({ length: combien }, (_, rang) => article(rang + 1)));
      const pages = disposer(doc, mesurer);
      if (pages.length !== 2) continue;
      trouve = true;
      expect(pages[1]?.rangees.length).toBeGreaterThan(0);
    }
    expect(trouve).toBe(true);
  });

  it('tronque une désignation démesurée plutôt que de bloquer la pagination', () => {
    const enorme = 'Coque renforcée '.repeat(60);
    const pages = disposer(facture([{ ...article(1), designation: enorme }]), mesurer);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.rangees[0]?.designation.length).toBe(MISE_EN_PAGE.lignesDesignation);
  });

  it('sait produire une facture sans aucun article', () => {
    const pages = disposer(facture([]), mesurer);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.rangees).toEqual([]);
    expect(pages[0]?.derniere).toBe(true);
  });
});

describe('hauteurs', () => {
  it('grandit avec les mentions de l’émetteur', () => {
    const nu = hauteurs(facture([article(1)], { mentions: [] }), mesurer);
    const garni = hauteurs(
      facture([article(1)], {
        mentions: [
          { libelle: 'RCS', valeur: 'Antananarivo 2019 B 00123' },
          { libelle: 'Banque', valeur: 'BNI 000 1234 5678' },
        ],
      }),
      mesurer,
    );
    expect(garni.enTetePremiere).toBeGreaterThan(nu.enTetePremiere);
  });

  it('grandit avec le nombre de règlements', () => {
    const nu = hauteurs(facture([article(1)]), mesurer);
    const garni = hauteurs(
      facture([article(1)], {
        reglements: [
          { le: '2026-09-01T08:00:00.000Z', moyen: 'Espèces', montant: 5_000 },
          { le: '2026-09-02T08:00:00.000Z', moyen: 'Mvola', montant: 5_000 },
        ],
      }),
      mesurer,
    );
    expect(garni.pied).toBeGreaterThan(nu.pied);
  });
});

describe('désignation tronquée', () => {
  it('le signale par des points de suspension', () => {
    const enorme = 'Coque renforcée antichoc '.repeat(40);
    const pages = disposer(facture([{ ...article(1), designation: enorme }]), mesurer);
    const lignes = pages[0]?.rangees[0]?.designation ?? [];
    expect(lignes).toHaveLength(MISE_EN_PAGE.lignesDesignation);
    expect(lignes[lignes.length - 1]).toMatch(/…$/);
  });

  it('ne signale rien quand tout tient', () => {
    const pages = disposer(facture([article(1)]), mesurer);
    expect(pages[0]?.rangees[0]?.designation.join('')).not.toMatch(/…/);
  });
});
