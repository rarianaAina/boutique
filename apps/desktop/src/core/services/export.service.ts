import { formatAmount } from '@boutique/shared';
import type { CurrencyFormat } from '@boutique/shared';

/**
 * Exports.
 *
 * Le format retenu est le CSV séparé par des POINTS-VIRGULES, avec une
 * marque d'ordre d'octets (BOM) en tête. Ce n'est pas un détail : sans BOM,
 * Excel sous Windows lit l'UTF-8 comme du latin-1 et affiche « Écouteurs » en
 * « Ãcouteurs » ; avec une virgule comme séparateur, il met toute la ligne dans
 * une seule colonne sur un poste configuré en français. Un export illisible
 * n'est pas un export.
 */

const BOM = '\ufeff';
const SEPARATOR = ';';

export interface Column<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
}

/** Échappe une cellule : guillemets doublés, champ entouré si nécessaire. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (!/[";\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv<T>(rows: readonly T[], columns: readonly Column<T>[]): string {
  const lines = [columns.map((column) => csvCell(column.header)).join(SEPARATOR)];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(column.value(row))).join(SEPARATOR));
  }
  // Fins de ligne CRLF : c'est ce qu'attendent les tableurs sous Windows.
  return BOM + lines.join('\r\n') + '\r\n';
}

/** Montant destiné à un tableur : virgule décimale, aucun séparateur de milliers. */
export function csvMoney(value: number, currency: CurrencyFormat): string {
  if (currency.decimals === 0) return String(value);
  const text = formatAmount(value, currency);
  return text.replace(/[\s\u00a0\u202f]/g, '');
}

/** Nom de fichier horodaté, sans caractère interdit par les systèmes de fichiers. */
export function exportFileName(prefix: string, extension = 'csv'): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const safe = prefix.replace(/[^a-zA-Z0-9_-]+/g, '-');
  return `${safe}-${stamp}.${extension}`;
}
