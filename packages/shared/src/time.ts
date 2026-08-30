/**
 * Temps.
 *
 * Toutes les dates stockées sont des chaînes ISO 8601 en UTC. Une base locale
 * dont les données voyagent entre deux boutiques (et donc potentiellement deux
 * fuseaux) ne peut pas se permettre des horodatages relatifs au poste qui les a
 * écrits : l'arbitrage de la synchronisation compare des instants, pas des
 * heures murales.
 */

export type IsoDate = string;

export function nowIso(): IsoDate {
  return new Date().toISOString();
}

/** Jour civil local, au format `AAAA-MM-JJ` — pour les regroupements et filtres. */
export function localDay(date: Date | IsoDate = new Date()): string {
  const value = typeof date === 'string' ? new Date(date) : date;
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Bornes UTC d'une journée locale, pour filtrer une colonne stockée en ISO.
 *
 * La borne haute est EXCLUE : comparer avec `< to` évite d'avoir à raisonner
 * sur la dernière milliseconde de la journée.
 */
export function dayRange(day: string): { from: IsoDate; to: IsoDate } {
  const parts = day.split('-').map(Number);
  const year = parts[0] ?? 1970;
  const month = (parts[1] ?? 1) - 1;
  const date = parts[2] ?? 1;
  return {
    from: new Date(year, month, date, 0, 0, 0, 0).toISOString(),
    to: new Date(year, month, date + 1, 0, 0, 0, 0).toISOString(),
  };
}

/** Bornes UTC d'un intervalle de jours locaux, borne haute exclue. */
export function periodRange(fromDay: string, toDay: string): { from: IsoDate; to: IsoDate } {
  return { from: dayRange(fromDay).from, to: dayRange(toDay).to };
}

export function addDays(day: string, days: number): string {
  const parts = day.split('-').map(Number);
  return localDay(new Date(parts[0] ?? 1970, (parts[1] ?? 1) - 1, (parts[2] ?? 1) + days));
}

/** Premier jour du mois d'une date locale. */
export function startOfMonth(day: string = localDay()): string {
  return `${day.slice(0, 7)}-01`;
}
