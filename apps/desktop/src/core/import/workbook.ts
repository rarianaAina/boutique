import * as XLSX from 'xlsx';

/**
 * Lecture d'un classeur Excel.
 *
 * UNE PRÉCAUTION EST ESSENTIELLE ICI : les IMEI sont lus sur la valeur BRUTE de
 * la cellule, jamais sur son affichage. Excel affiche volontiers un nombre de
 * quinze chiffres en notation scientifique (3,56920E+14) ; recopier ce qui est
 * à l'écran donnerait un IMEI faux, et l'appareil porterait ce numéro toute sa
 * vie. Un entier de quinze chiffres tient exactement dans un flottant
 * double précision (limite : environ 9 × 10¹⁵), la valeur brute est donc fidèle.
 */

export interface SheetInfo {
  name: string;
  rows: number;
  columns: number;
}

export interface SheetData {
  name: string;
  headers: string[];
  /** Lignes de données, en chaînes déjà normalisées. */
  rows: string[][];
}

export function readWorkbook(data: ArrayBuffer | Uint8Array): XLSX.WorkBook {
  return XLSX.read(data, { type: 'array', cellDates: false, raw: true });
}

export function listSheets(workbook: XLSX.WorkBook): SheetInfo[] {
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const range = sheet?.['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : null;
    return {
      name,
      rows: range ? range.e.r - range.s.r : 0,
      columns: range ? range.e.c - range.s.c + 1 : 0,
    };
  });
}

/**
 * Extrait une feuille : la première ligne non vide sert d'en-tête.
 *
 * Beaucoup de fichiers de boutique commencent par un titre et une ligne vide
 * avant le vrai tableau ; prendre aveuglément la première ligne donnerait des
 * colonnes nommées « Inventaire 2026 » et rien à mapper.
 */
export function readSheet(workbook: XLSX.WorkBook, name: string, maxRows = 50_000): SheetData {
  const sheet = workbook.Sheets[name];
  if (!sheet) throw new Error(`Feuille « ${name} » introuvable.`);

  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  });

  const headerIndex = matrix.findIndex(
    (row) => Array.isArray(row) && row.filter((cell) => cellToText(cell) !== '').length >= 2,
  );
  if (headerIndex < 0) return { name, headers: [], rows: [] };

  const headers = (matrix[headerIndex] ?? []).map((cell) => cellToText(cell));
  const rows = matrix
    .slice(headerIndex + 1, headerIndex + 1 + maxRows)
    .map((row) => headers.map((_, index) => cellToText((row as unknown[])[index])))
    .filter((row) => row.some((cell) => cell !== ''));

  return { name, headers, rows };
}

/**
 * Valeur de cellule -> texte.
 *
 * Les nombres entiers sont rendus SANS notation scientifique ni décimale
 * parasite : c'est ce qui préserve un IMEI, un code-barres ou un numéro de
 * série numérique.
 */
export function cellToText(cell: unknown): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'number') {
    if (Number.isInteger(cell)) return cell.toFixed(0);
    return String(cell);
  }
  if (typeof cell === 'boolean') return cell ? '1' : '0';
  return String(cell).trim();
}
