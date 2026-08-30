import { describe, expect, it } from 'vitest';
import { allocate, applyRate, formatMoney, parseMoney, type CurrencyFormat } from '../src';

const EURO: CurrencyFormat = { code: 'EUR', symbol: '€', decimals: 2, symbolBefore: false };
const ARIARY: CurrencyFormat = { code: 'MGA', symbol: 'Ar', decimals: 0, symbolBefore: false };

describe('monnaie', () => {
  it('lit une saisie française', () => {
    expect(parseMoney('12,50', 2)).toBe(1250);
    expect(parseMoney('1 250', 0)).toBe(1250);
    expect(parseMoney('', 2)).toBeNull();
    expect(parseMoney('abc', 2)).toBeNull();
  });

  it('met en forme selon la devise', () => {
    expect(formatMoney(1250, EURO)).toBe(`12,50\u00a0€`);
    expect(formatMoney(1250000, ARIARY)).toContain('Ar');
    expect(formatMoney(-500, EURO)).toBe(`-5,00\u00a0€`);
  });

  it('applique un taux en centièmes de point', () => {
    expect(applyRate(10_000, 2000)).toBe(2000);
  });

  describe('répartition des frais logistiques', () => {
    it("n'égare aucune unité monétaire", () => {
      const parts = allocate(100, [1, 1, 1]);
      expect(parts.reduce((total, part) => total + part, 0)).toBe(100);
      expect(parts).toEqual([34, 33, 33]);
    });

    it('respecte les poids', () => {
      expect(allocate(1000, [300, 700])).toEqual([300, 700]);
    });

    it('répartit à parts égales quand tous les poids sont nuls', () => {
      expect(allocate(10, [0, 0, 0, 0])).toEqual([3, 3, 2, 2]);
    });

    it('gère un montant négatif (avoir fournisseur)', () => {
      const parts = allocate(-100, [1, 1, 1]);
      expect(parts.reduce((total, part) => total + part, 0)).toBe(-100);
    });

    it('renvoie une liste vide sans lignes', () => {
      expect(allocate(500, [])).toEqual([]);
    });
  });
});
