import { invoke } from '@tauri-apps/api/core';
import Database from '@tauri-apps/plugin-sql';

/**
 * Accès à la base locale SQLite.
 *
 * Les migrations ne sont PAS lancées ici : elles sont déclarées côté Rust
 * (`src-tauri/src/lib.rs`) et appliquées par tauri-plugin-sql à l'ouverture de
 * la base, avant que la fenêtre ne soit prête. Le front ne voit donc jamais un
 * schéma incomplet.
 *
 * RÈGLE : aucun composant React n'importe ce module. Tout passe par
 * `core/db/repositories/*`, puis par `core/services/*`. C'est ce qui permettra
 * de basculer une écriture critique vers une commande Rust transactionnelle
 * sans toucher à un seul écran.
 */
export const DB_URL = 'sqlite:boutique.db';

/**
 * Contrat minimal d'exécution SQL.
 *
 * Les dépôts ne dépendent que de cette interface, jamais de Tauri : la même
 * logique métier est donc exécutable dans les tests sur `node:sqlite`, sans
 * lancer l'application ni compiler Rust.
 */
export interface SqlExecutor {
  execute(sql: string, params?: unknown[]): Promise<void>;
  select<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /**
   * Exécute un bloc de manière atomique.
   *
   * Les écritures du bloc sont accumulées puis exécutées par la commande Rust
   * `execute_batch`, dans UNE transaction sqlx sur UNE connexion. C'était
   * nécessaire : le plugin ouvre la base avec `Pool::connect()`, soit dix
   * connexions, si bien qu'un `BEGIN` et un `COMMIT` envoyés séparément
   * peuvent atterrir sur deux connexions différentes.
   *
   * CONSÉQUENCE À CONNAÎTRE : les LECTURES faites dans le bloc sont immédiates,
   * donc elles ne voient pas les écritures en attente. Aucun service ne relit
   * ce qu'il vient d'écrire dans la même transaction ; les invariants qui en
   * dépendraient sont portés par des contraintes de la base (index uniques sur
   * l'IMEI et sur les numéros de documents), pas par une relecture.
   */
  transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

/**
 * Convertit les marqueurs `?` en `$1, $2, …`.
 *
 * Tout le SQL des dépôts est écrit avec `?` — la forme comprise par
 * `node:sqlite`, donc par les tests. tauri-plugin-sql attend la forme numérotée
 * pour SQLite. La conversion est faite ici, à un seul endroit.
 */
export function toNumberedPlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

class TauriExecutor implements SqlExecutor {
  constructor(private readonly db: Database) {}

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    await this.db.execute(toNumberedPlaceholders(sql), params);
  }

  async select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.select<T[]>(toNumberedPlaceholders(sql), params);
  }

  async transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const recorder = new RecordingExecutor(this);
    const result = await run(recorder);
    await recorder.commit();
    return result;
  }
}

/**
 * Accumule les écritures d'un bloc transactionnel, laisse passer les lectures.
 *
 * Une exception levée dans le bloc n'atteint jamais `commit()` : rien n'est
 * envoyé, donc rien n'est écrit. C'est ce qui remplace le ROLLBACK.
 */
class RecordingExecutor implements SqlExecutor {
  private readonly statements: { sql: string; params: unknown[] }[] = [];

  constructor(private readonly inner: TauriExecutor) {}

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    this.statements.push({ sql: toNumberedPlaceholders(sql), params });
  }

  select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.inner.select<T>(sql, params);
  }

  /** Les transactions imbriquées se fondent dans le lot en cours. */
  async transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return run(this);
  }

  async commit(): Promise<void> {
    if (this.statements.length === 0) return;
    await invoke('execute_batch', { db: DB_URL, statements: this.statements });
  }
}

let instance: SqlExecutor | null = null;

export async function getDb(): Promise<SqlExecutor> {
  instance ??= new TauriExecutor(await Database.load(DB_URL));
  return instance;
}

/** Injecte un exécuteur (tests, ou future implémentation en commandes Rust). */
export function setDb(executor: SqlExecutor | null): void {
  instance = executor;
}

/** Vrai lorsque le code tourne dans la WebView Tauri, et non dans un navigateur. */
export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
