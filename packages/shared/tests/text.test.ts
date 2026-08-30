import { describe, expect, it } from 'vitest';
import { buildSearchKey, escapeLike, normalizeText, searchTerms, truncate } from '../src';

describe('recherche', () => {
  it('ignore accents, casse et ponctuation', () => {
    expect(normalizeText('Écouteurs Bluetooth (JBL)')).toBe('ecouteurs bluetooth jbl');
  });

  it('construit une clé dédoublonnée et bornée par des espaces', () => {
    const key = buildSearchKey('iPhone 15', 'Apple', 'IPH15-128', null, 'iPhone');
    expect(key.startsWith(' ')).toBe(true);
    expect(key.endsWith(' ')).toBe(true);
    expect(key.split(' ').filter(Boolean)).toEqual(['iphone', '15', 'apple', 'iph15', '128']);
  });

  it('découpe une saisie en termes', () => {
    expect(searchTerms('  iphone   PRO ')).toEqual(['iphone', 'pro']);
  });

  it('échappe les jokers SQL', () => {
    expect(escapeLike('100%_coton')).toBe('100\\%\\_coton');
  });

  it('tronque avec une ellipse', () => {
    expect(truncate('abcdefgh', 5)).toBe('abcd…');
    expect(truncate('abc', 5)).toBe('abc');
  });
});
