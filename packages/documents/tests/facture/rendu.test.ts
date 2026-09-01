import { DEFAULT_CURRENCY, formatMoney } from '@boutique/shared';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { pdfFacture, winAnsi } from '../../src/index.js';
import type { DocumentFacture, LigneFacture } from '../../src/index.js';

function article(rang: number): LigneFacture {
  return {
    designation: `Écran hydrogel — modèle ${rang}`,
    identifiant: `35000000000${String(rang).padStart(4, '0')}`,
    quantite: 2,
    prixUnitaire: 45_000,
    total: 90_000,
  };
}

function facture(lignes: LigneFacture[], extra: Partial<DocumentFacture> = {}): DocumentFacture {
  const total = lignes.reduce((somme, ligne) => somme + ligne.total, 0);
  return {
    emetteur: {
      nom: 'Boutique Lovelec',
      adresse: 'Lot II M 12 Bis, Antananarivo 101',
      telephone: '+261 34 12 345 67',
      courriel: 'contact@lovelec.mg',
      nif: '3000123456',
      stat: '47120 11 2019 0 12345',
    },
    mentions: [{ libelle: 'RCS', valeur: 'Antananarivo 2019 B 00123' }],
    logo: null,
    destinataire: {
      nom: 'Société Rakoto & Fils',
      adresse: 'Ankorondrano, Antananarivo',
      telephone: '+261 32 00 000 00',
      nif: '3000987654',
      stat: '46900 11 2020 0 54321',
    },
    numero: 'FA-ANT-2026-0042',
    emiseLe: '2026-09-01T08:00:00.000Z',
    echeanceLe: '2026-10-01T08:00:00.000Z',
    statut: 'EMISE',
    lignes,
    sousTotal: total,
    remise: 0,
    taxe: 0,
    total,
    regle: 0,
    reglements: [],
    devise: DEFAULT_CURRENCY,
    conditions: '',
    signatures: null,
    piedDePage: 'TVA non applicable. Marchandise garantie six mois pièces et main-d’œuvre.',
    ...extra,
  };
}

describe('assainissement WinAnsi', () => {
  it('remplace l’espace fine insécable des montants', () => {
    // `formatMoney` sépare les milliers par U+202F. Les polices standard d'un
    // PDF ne la connaissent pas : sans remplacement, toute facture à quatre
    // chiffres échouerait — donc presque toutes.
    const montant = formatMoney(1_250_000, DEFAULT_CURRENCY);
    expect(montant).toMatch(/ /);
    expect(winAnsi(montant)).not.toMatch(/ /);
    expect(winAnsi(montant)).toBe('1 250 000 Ar');
  });

  it('garde les accents français et l’euro', () => {
    expect(winAnsi('Écran à 12 €')).toBe('Écran à 12 €');
  });

  it('remplace ce qu’il ne sait pas écrire plutôt que d’échouer', () => {
    expect(winAnsi('prix 100 ₮')).toBe('prix 100 ?');
  });
});

describe('production du PDF', () => {
  it('produit un fichier lisible', async () => {
    const octets = await pdfFacture(facture([article(1), article(2)]));
    expect(octets.byteLength).toBeGreaterThan(1_000);
    // La signature d'un PDF : un lecteur qui ne la trouve pas refuse le
    // fichier avant même de l'ouvrir.
    expect(Buffer.from(octets.slice(0, 5)).toString()).toBe('%PDF-');

    const relu = await PDFDocument.load(octets);
    expect(relu.getPageCount()).toBe(1);
    expect(relu.getTitle()).toBe('Facture FA-ANT-2026-0042');
  });

  it('n’échoue pas sur un montant à sept chiffres', async () => {
    const grosse = facture([
      { designation: 'Lot de téléphones', quantite: 40, prixUnitaire: 350_000, total: 14_000_000 },
    ]);
    await expect(pdfFacture(grosse)).resolves.toBeInstanceOf(Uint8Array);
  });

  it('pagine une facture longue', async () => {
    const lignes = Array.from({ length: 90 }, (_, rang) => article(rang + 1));
    const relu = await PDFDocument.load(await pdfFacture(facture(lignes)));
    expect(relu.getPageCount()).toBeGreaterThan(1);
  });

  it('accepte un client de passage', async () => {
    const octets = await pdfFacture(facture([article(1)], { destinataire: null }));
    expect(octets.byteLength).toBeGreaterThan(1_000);
  });

  it('accepte une facture annulée, remisée et partiellement réglée', async () => {
    const octets = await pdfFacture(
      facture([{ ...article(1), remise: 5_000 }], {
        statut: 'ANNULEE',
        remise: 5_000,
        taxe: 17_000,
        regle: 30_000,
        reglements: [{ le: '2026-09-01T09:00:00.000Z', moyen: 'Mvola', montant: 30_000 }],
        notes: 'Reprise de l’ancien appareil déduite.',
      }),
    );
    expect(octets.byteLength).toBeGreaterThan(1_000);
  });
});

describe('logo', () => {
  const PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it('s’imprime quand la boutique en fournit un', async () => {
    const avec = await pdfFacture(facture([article(1)], { logo: PNG }));
    const sans = await pdfFacture(facture([article(1)]));
    // L'image embarquée alourdit le fichier : c'est la preuve qu'elle y est.
    expect(avec.byteLength).toBeGreaterThan(sans.byteLength);
  });

  it('n’empêche pas la facture quand l’image est illisible', async () => {
    // Un commerçant enverra le fichier qu'il a sous la main. S'il n'est pas
    // lisible, la facture doit sortir sans logo — pas échouer.
    const octets = await pdfFacture(
      facture([article(1)], { logo: 'data:image/png;base64,cecinestpasuneimage' }),
    );
    expect(Buffer.from(octets.slice(0, 5)).toString()).toBe('%PDF-');
  });
});

describe('conditions et signatures', () => {
  it('s’impriment quand elles sont fournies', async () => {
    const nu = await pdfFacture(facture([article(1)]));
    const garni = await pdfFacture(
      facture([article(1)], {
        conditions: 'Marchandise vendue non reprise passé huit jours.',
        signatures: { gauche: 'Le vendeur', droite: 'Le client' },
      }),
    );
    expect(garni.byteLength).toBeGreaterThan(nu.byteLength);
  });
});
