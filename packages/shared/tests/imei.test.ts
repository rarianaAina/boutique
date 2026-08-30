import { describe, expect, it } from 'vitest';
import { checkImei, completeImei, imeiCheckDigit, isValidImei, normalizeImei } from '../src';

describe('IMEI', () => {
  it('accepte un IMEI réel', () => {
    // IMEI de test connu, clé de Luhn correcte.
    expect(isValidImei('490154203237518')).toBe(true);
  });

  it('calcule la clé de contrôle', () => {
    expect(imeiCheckDigit('49015420323751')).toBe(8);
    expect(completeImei('49015420323751')).toBe('490154203237518');
  });

  it('nettoie les séparateurs collés par un scanner ou un tableur', () => {
    expect(normalizeImei('49-015420 237.518')).toBe('49015420237518');
    expect(checkImei('490154 20323751 8').valid).toBe(true);
  });

  it('tronque un IMEISV de 16 chiffres', () => {
    const check = checkImei('4901542032375180');
    expect(check.valid).toBe(true);
    expect(check.value).toBe('490154203237518');
  });

  it('rejette une mauvaise clé en indiquant le chiffre attendu', () => {
    const check = checkImei('490154203237511');
    expect(check.valid).toBe(false);
    expect(check.problem).toBe('BAD_CHECKSUM');
    expect(check.message).toContain('8');
  });

  it('rejette une longueur incorrecte', () => {
    expect(checkImei('12345').problem).toBe('BAD_LENGTH');
  });

  it('rejette du texte', () => {
    expect(checkImei('IMEI inconnu').problem).toBe('NOT_NUMERIC');
  });

  it('rejette une saisie vide', () => {
    expect(checkImei('   ').problem).toBe('EMPTY');
  });
});

describe('tolérance de la clé de contrôle', () => {
  // Numéro fabriqué en incrémentant le dernier chiffre : la clé ne suit pas.
  const CLE_FAUSSE = '983748993829401';

  it('refuse par défaut', () => {
    expect(checkImei(CLE_FAUSSE).valid).toBe(false);
  });

  it('accepte quand le contrôle est levé, en conservant le signalement', () => {
    const check = checkImei(CLE_FAUSSE, { requireChecksum: false });
    expect(check.valid).toBe(true);
    expect(check.value).toBe(CLE_FAUSSE);
    // Le doute reste exprimé : accepté n'est pas synonyme de sûr.
    expect(check.problem).toBe('BAD_CHECKSUM');
    expect(check.message).toContain('devrait finir par');
  });

  it('continue de refuser une mauvaise LONGUEUR, même en mode tolérant', () => {
    // La longueur et l'unicité protègent l'intégrité ; la clé ne protège que
    // de la faute de frappe. Lever l'une ne lève pas les autres.
    expect(checkImei('12345', { requireChecksum: false }).valid).toBe(false);
    expect(checkImei('abc', { requireChecksum: false }).problem).toBe('NOT_NUMERIC');
  });
});
