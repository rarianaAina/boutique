import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SqlExecutor } from '@/core/db/client';

/**
 * Exécuteur SQL sur `node:sqlite`, pour les tests.
 *
 * Il rejoue la MÊME sémantique que l'exécuteur Tauri, et notamment la plus
 * piégeuse : dans un bloc `transaction()`, les écritures sont ACCUMULÉES puis
 * appliquées au commit, tandis que les lectures partent immédiatement — elles
 * ne voient donc pas ce que le bloc vient d'écrire.
 *
 * Reproduire ce comportement est le seul moyen d'attraper en test un service
 * qui relirait ce qu'il vient d'écrire : avec une transaction SQLite ordinaire,
 * un tel code passerait ici et échouerait en production.
 */

/**
 * Les migrations sont appliquées DANS L'ORDRE, comme le fait tauri-plugin-sql
 * au démarrage. Les lister à la main plutôt que de balayer le dossier serait
 * la garantie d'en oublier une le jour où on en ajoute.
 */
const MIGRATIONS = ['0001_init.sql', '0002_variantes.sql'].map((nom) =>
  fileURLToPath(new URL(`../../src-tauri/migrations/${nom}`, import.meta.url)),
);

export class TestExecutor implements SqlExecutor {
  constructor(readonly raw: DatabaseSync) {}

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    this.raw.prepare(sql).run(...normalize(params));
  }

  async select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.raw.prepare(sql).all(...normalize(params)) as T[];
  }

  async transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const recorder = new RecordingTestExecutor(this);
    const result = await run(recorder);
    recorder.commit();
    return result;
  }

  close(): void {
    this.raw.close();
  }
}

class RecordingTestExecutor implements SqlExecutor {
  private readonly statements: { sql: string; params: unknown[] }[] = [];

  constructor(private readonly inner: TestExecutor) {}

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    this.statements.push({ sql, params });
  }

  select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.inner.select<T>(sql, params);
  }

  async transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return run(this);
  }

  /** Tout ou rien, comme la commande Rust `execute_batch`. */
  commit(): void {
    if (this.statements.length === 0) return;
    const db = this.inner.raw;
    db.exec('BEGIN');
    try {
      for (const statement of this.statements) {
        db.prepare(statement.sql).run(...normalize(statement.params));
      }
      db.exec('COMMIT');
    } catch (cause) {
      db.exec('ROLLBACK');
      throw cause;
    }
  }
}

/**
 * `node:sqlite` n'accepte ni booléen ni undefined ; le pilote Rust, lui, lie
 * les booléens. On aligne les deux ici pour que le SQL des dépôts reste écrit
 * une seule fois.
 */
function normalize(params: unknown[]): (null | number | bigint | string | Uint8Array)[] {
  return params.map((param) => {
    if (param === undefined || param === null) return null;
    if (typeof param === 'boolean') return param ? 1 : 0;
    if (typeof param === 'number' || typeof param === 'string' || typeof param === 'bigint') {
      return param;
    }
    if (param instanceof Uint8Array) return param;
    return JSON.stringify(param);
  });
}

/** Base en mémoire, schéma appliqué : le point de départ de tous les tests. */
export function createTestDb(): TestExecutor {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const migration of MIGRATIONS) db.exec(readFileSync(migration, 'utf8'));
  return new TestExecutor(db);
}
