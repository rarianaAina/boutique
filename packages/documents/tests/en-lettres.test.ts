import { DEFAULT_CURRENCY } from '@boutique/shared';
import { describe, expect, it } from 'vitest';
import { montantEnLettres, nombreEnLettres } from '../src/en-lettres.js';

describe('nombres en toutes lettres', () => {
  it('compte jusqu’à cent', () => {
    expect(nombreEnLettres(0)).toBe('zéro');
    expect(nombreEnLettres(7)).toBe('sept');
    expect(nombreEnLettres(16)).toBe('seize');
    expect(nombreEnLettres(17)).toBe('dix-sept');
    expect(nombreEnLettres(20)).toBe('vingt');
    expect(nombreEnLettres(21)).toBe('vingt et un');
    expect(nombreEnLettres(22)).toBe('vingt-deux');
    expect(nombreEnLettres(61)).toBe('soixante et un');
    expect(nombreEnLettres(70)).toBe('soixante-dix');
    expect(nombreEnLettres(71)).toBe('soixante et onze');
    expect(nombreEnLettres(79)).toBe('soixante-dix-neuf');
    expect(nombreEnLettres(80)).toBe('quatre-vingts');
    expect(nombreEnLettres(81)).toBe('quatre-vingt-un');
    expect(nombreEnLettres(91)).toBe('quatre-vingt-onze');
    expect(nombreEnLettres(99)).toBe('quatre-vingt-dix-neuf');
  });

  it('accorde cent et vingt selon ce qui suit', () => {
    expect(nombreEnLettres(100)).toBe('cent');
    expect(nombreEnLettres(101)).toBe('cent un');
    expect(nombreEnLettres(200)).toBe('deux cents');
    expect(nombreEnLettres(201)).toBe('deux cent un');
    expect(nombreEnLettres(280)).toBe('deux cent quatre-vingts');

    // `mille` est un adjectif : il empêche le s de cent et de vingt.
    expect(nombreEnLettres(200_000)).toBe('deux cent mille');
    expect(nombreEnLettres(80_000)).toBe('quatre-vingt mille');

    // `million` est un nom : il l'autorise.
    expect(nombreEnLettres(200_000_000)).toBe('deux cents millions');
  });

  it('ne dit jamais « un mille »', () => {
    expect(nombreEnLettres(1_000)).toBe('mille');
    expect(nombreEnLettres(1_100)).toBe('mille cent');
    expect(nombreEnLettres(2_000)).toBe('deux mille');
    expect(nombreEnLettres(1_000_000)).toBe('un million');
    expect(nombreEnLettres(2_000_000)).toBe('deux millions');
  });

  it('assemble les grands nombres', () => {
    expect(nombreEnLettres(1_234_567)).toBe(
      'un million deux cent trente-quatre mille cinq cent soixante-sept',
    );
    expect(nombreEnLettres(3_000_000_000)).toBe('trois milliards');
  });
});

describe('montants en toutes lettres', () => {
  it('laisse ariary invariable', () => {
    // Mot malgache : il ne prend pas de s en français, et l'écrire
    // « ariarys » sur une facture se remarque.
    expect(montantEnLettres(1, DEFAULT_CURRENCY)).toBe('un ariary');
    expect(montantEnLettres(2_500_000, DEFAULT_CURRENCY)).toBe(
      'deux millions cinq cent mille ariary',
    );
  });

  it('sépare les centimes d’une devise qui en a', () => {
    const euro = { code: 'EUR', symbol: '€', decimals: 2, symbolBefore: false };
    expect(montantEnLettres(1_250, euro)).toBe('douze euros et cinquante centimes');
    expect(montantEnLettres(100, euro)).toBe('un euro');
  });

  it('nomme une devise inconnue par son code plutôt que de deviner', () => {
    const franc = { code: 'XOF', symbol: 'F', decimals: 0, symbolBefore: false };
    expect(montantEnLettres(12_000, franc)).toBe('douze mille XOF');
  });
});
