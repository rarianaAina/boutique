import initSqlJs, { type Database } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import init from '../../src-tauri/migrations/0001_init.sql?raw';
import variantes from '../../src-tauri/migrations/0002_variantes.sql?raw';
import prix from '../../src-tauri/migrations/0003_historique_prix.sql?raw';
import poste from '../../src-tauri/migrations/0004_reglages_poste.sql?raw';
import fiscal from '../../src-tauri/migrations/0005_identifiants_fiscaux.sql?raw';
import charges from '../../src-tauri/migrations/0006_charges.sql?raw';
import type { SqlExecutor } from '@/core/db/client';

/**
 * SQLite dans le navigateur, pour REGARDER l'application.
 *
 * POURQUOI CELA EXISTE. L'interface n'a pas d'épreuves — quatre cent
 * cinquante-sept portent sur les services et les dépôts, aucune sur ce que
 * l'écran affiche. Cette séance a montré deux fois de suite ce que cela coûte :
 * des filets de tableau qui barraient le texte d'une facture, et un APK dont
 * j'avais mal deviné le poids. Ce qu'on ne regarde pas, on l'imagine juste.
 *
 * L'application entière tourne donc ici dans un navigateur ordinaire, sur une
 * vraie base SQLite compilée en WebAssembly, avec les MÊMES migrations que le
 * poste de travail. On peut alors la photographier à n'importe quelle largeur
 * d'écran — celle d'un téléphone, en particulier.
 *
 * CE FICHIER NE PART JAMAIS EN PRODUCTION : il n'est atteignable que par
 * `apercu.html`, que le serveur de développement sert et que la compilation
 * ignore — elle ne connaît que `index.html`.
 */

const MIGRATIONS = [init, variantes, prix, poste, fiscal, charges];

/**
 * Reproduit la sémantique de l'exécuteur Tauri, y compris la plus piégeuse :
 * dans une transaction, les écritures sont ACCUMULÉES puis appliquées au
 * commit, tandis que les lectures partent immédiatement. Un aperçu qui
 * n'aurait pas la même sémantique montrerait des écrans que la production ne
 * produit pas.
 */
export class ExecuteurSqlJs implements SqlExecutor {
  constructor(readonly raw: Database) {}

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    this.raw.run(sql, normaliser(params));
  }

  async select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const requete = this.raw.prepare(sql);
    try {
      requete.bind(normaliser(params));
      const lignes: T[] = [];
      while (requete.step()) lignes.push(requete.getAsObject() as T);
      return lignes;
    } finally {
      requete.free();
    }
  }

  async transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const journal = new ExecuteurDiffere(this);
    const resultat = await run(journal);
    journal.appliquer();
    return resultat;
  }
}

class ExecuteurDiffere implements SqlExecutor {
  private readonly instructions: { sql: string; params: unknown[] }[] = [];

  constructor(private readonly interne: ExecuteurSqlJs) {}

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    this.instructions.push({ sql, params });
  }

  select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.interne.select<T>(sql, params);
  }

  async transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return run(this);
  }

  /** Tout ou rien, comme la commande Rust `execute_batch`. */
  appliquer(): void {
    if (this.instructions.length === 0) return;
    const db = this.interne.raw;
    db.run('BEGIN');
    try {
      for (const instruction of this.instructions) {
        db.run(instruction.sql, normaliser(instruction.params));
      }
      db.run('COMMIT');
    } catch (cause) {
      db.run('ROLLBACK');
      throw cause;
    }
  }
}

type Liable = string | number | Uint8Array | null;

function normaliser(params: unknown[]): Liable[] {
  return params.map((param) => {
    if (param === undefined || param === null) return null;
    if (typeof param === 'boolean') return param ? 1 : 0;
    if (typeof param === 'number' || typeof param === 'string') return param;
    if (typeof param === 'bigint') return Number(param);
    if (param instanceof Uint8Array) return param;
    return JSON.stringify(param);
  });
}

/** Base neuve, schéma appliqué. */
export async function baseDApercu(): Promise<ExecuteurSqlJs> {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const db = new SQL.Database();
  db.run('PRAGMA foreign_keys = ON');
  for (const migration of MIGRATIONS) db.run(migration);
  return new ExecuteurSqlJs(db);
}
