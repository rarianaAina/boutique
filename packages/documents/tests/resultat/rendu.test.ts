import { DEFAULT_CURRENCY } from '@boutique/shared';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { pdfResultat, type DocumentResultat } from '../../src/index.js';

function compte(extra: Partial<DocumentResultat> = {}): DocumentResultat {
  return {
    emetteur: { nom: 'Boutique Lovelec', nif: '3000123456', stat: '47120 11 2019 0 12345' },
    du: '2026-09-01',
    au: '2026-09-30T23:59:59.999Z',
    etabliLe: '2026-10-01T08:00:00.000Z',
    produits: [
      { libelle: 'Ventes', montant: 12_400_000, detail: '84 ventes' },
      { libelle: 'Remises accordées', montant: 320_000 },
      { libelle: 'Retours', montant: 180_000 },
    ],
    chiffreAffairesNet: 11_900_000,
    coutMarchandises: 8_600_000,
    margeBrute: 3_300_000,
    tauxMarge: 2_773,
    charges: [
      { libelle: 'Loyer et charges locatives', montant: 900_000, detail: '1 pièce' },
      { libelle: 'Salaires et charges sociales', montant: 1_400_000, detail: '3 pièces' },
    ],
    totalCharges: 2_300_000,
    resultat: 1_000_000,
    devise: DEFAULT_CURRENCY,
    avertissement:
      'Ce document donne le résultat de l’exploitation. Il ne porte ni amortissements, ni emprunts, ni capital, et ne remplace pas les comptes annuels.',
    ...extra,
  };
}

describe('compte de résultat imprimé', () => {
  it('tient sur une seule page', async () => {
    const relu = await PDFDocument.load(await pdfResultat(compte()));
    expect(relu.getPageCount()).toBe(1);
    expect(relu.getTitle()).toMatch(/^Compte de résultat /);
  });

  it('tient encore sur une page avec les douze catégories de charges', async () => {
    const charges = Array.from({ length: 12 }, (_, rang) => ({
      libelle: `Catégorie de charge numéro ${rang + 1}`,
      montant: 150_000,
      detail: `${rang + 1} pièces`,
    }));
    const relu = await PDFDocument.load(
      await pdfResultat(compte({ charges, totalCharges: 1_800_000 })),
    );
    expect(relu.getPageCount()).toBe(1);
  });

  it('sait dire une perte', async () => {
    const octets = await pdfResultat(compte({ resultat: -450_000, margeBrute: -450_000 }));
    expect(Buffer.from(octets.slice(0, 5)).toString()).toBe('%PDF-');
  });

  it('accepte une période sans aucune charge', async () => {
    const octets = await pdfResultat(compte({ charges: [], totalCharges: 0, resultat: 3_300_000 }));
    expect(octets.byteLength).toBeGreaterThan(1_000);
  });

  it('n’échoue pas sur une période vide', async () => {
    const octets = await pdfResultat(
      compte({
        produits: [{ libelle: 'Ventes', montant: 0, detail: '0 vente' }],
        chiffreAffairesNet: 0,
        coutMarchandises: 0,
        margeBrute: 0,
        tauxMarge: 0,
        charges: [],
        totalCharges: 0,
        resultat: 0,
      }),
    );
    expect(Buffer.from(octets.slice(0, 5)).toString()).toBe('%PDF-');
  });
});
