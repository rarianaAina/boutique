import { describe, expect, it } from 'vitest';
import { derivedSku, isDerivedSku, nextFreeSku } from '../src';

describe('références produit', () => {
  it('dérive une référence lisible du modèle', () => {
    expect(derivedSku(['iPhone 12 Pro Max', 'Apple', '512', 'Silver'])).toBe(
      'AUTO-IPHONE-12-PRO-MAX-APPLE-512-SILVER',
    );
  });

  it('produit la MÊME référence pour le même modèle', () => {
    // C'est ce qui évite trois fiches pour trois lignes du même téléphone.
    const a = derivedSku(['Iphone 12 Pro Max', null, '512', 'Silver ']);
    const b = derivedSku(['iphone 12 pro max', undefined, '512', 'silver']);
    expect(a).toBe(b);
  });

  it('ignore accents et ponctuation', () => {
    expect(derivedSku(['Câble USB-C 1 m'])).toBe('AUTO-CABLE-USB-C-1-M');
  });

  it('borne la longueur pour tenir dans la colonne', () => {
    const longue = derivedSku([`Produit ${'très '.repeat(40)}long`]);
    expect(longue.length).toBeLessThanOrEqual('AUTO-'.length + 48);
  });

  it('reste utilisable sur une désignation vide', () => {
    expect(derivedSku([null, '', undefined])).toBe('AUTO-SANS-NOM');
  });

  it('se reconnaît à son préfixe', () => {
    expect(isDerivedSku(derivedSku(['Housse']))).toBe(true);
    expect(isDerivedSku('HOU-IP17PM-SIL')).toBe(false);
  });

  describe('unicité', () => {
    it('rend la base telle quelle si elle est libre', async () => {
      expect(await nextFreeSku('AUTO-HOUSSE', async () => false)).toBe('AUTO-HOUSSE');
    });

    it("suffixe jusqu'à trouver une référence libre", async () => {
      const prises = new Set(['AUTO-SAMSUNG', 'AUTO-SAMSUNG-2']);
      expect(await nextFreeSku('AUTO-SAMSUNG', async (c) => prises.has(c))).toBe('AUTO-SAMSUNG-3');
    });

    it('renonce plutôt que de boucler indéfiniment', async () => {
      await expect(nextFreeSku('AUTO-X', async () => true, 3)).rejects.toThrow(/à la main/);
    });
  });
});
