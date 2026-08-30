import { describe, expect, it } from 'vitest';
import { DEFAULT_NUMBERING, counterPeriod, formatDocumentNumber } from '../src';

describe('numérotation', () => {
  const at = new Date(2026, 2, 9);

  it('porte le code boutique, ce qui rend le numéro unique dans le réseau', () => {
    const rule = DEFAULT_NUMBERING['transfer'];
    expect(rule).toBeDefined();
    expect(formatDocumentNumber(rule!, { shopCode: 'cent', sequence: 123, at })).toBe(
      'TR-CENT-2026-0123',
    );
  });

  it('complète le compteur à la largeur demandée', () => {
    const rule = DEFAULT_NUMBERING['sale'];
    expect(formatDocumentNumber(rule!, { shopCode: 'A', sequence: 7, at })).toBe('T-A-2026-00007');
  });

  it('remet le compteur à zéro chaque année quand la règle le prévoit', () => {
    expect(counterPeriod({ ...DEFAULT_NUMBERING['sale']!, yearlyReset: true }, at)).toBe('2026');
    expect(counterPeriod({ ...DEFAULT_NUMBERING['sale']!, yearlyReset: false }, at)).toBe('ALL');
  });
});
