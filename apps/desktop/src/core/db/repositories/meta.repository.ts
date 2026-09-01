import type { SqlExecutor } from '../client';

/**
 * Clé/valeur d'exploitation : curseur de synchronisation, identifiant du poste,
 * date de la dernière sauvegarde, drapeaux de démarrage.
 *
 * Volontairement séparé de `setting` : ce que l'on trouve ici est de la
 * mécanique interne, jamais quelque chose qu'un utilisateur règle dans un
 * écran. Les mélanger ferait apparaître un « curseur de synchro » dans la page
 * des paramètres commerciaux.
 */
export const META_KEYS = {
  deviceId: 'device.id',
  lastBackupAt: 'backup.last_at',
  lastSyncAt: 'sync.last_at',
  syncCursor: 'sync.cursor',
  syncServerUrl: 'sync.server_url',
  syncToken: 'sync.token',
  /**
   * Session gardée d'un lancement à l'autre.
   *
   * Ici et non dans `setting` : c'est de la mécanique, cela n'a rien à faire
   * dans un écran de réglages, et surtout `app_meta` NE VOYAGE PAS avec
   * l'archive de portabilité. Une session emportée sur une autre machine y
   * ouvrirait une caisse sans mot de passe.
   */
  session: 'session.active',
  seedApplied: 'seed.applied',
  schemaReady: 'schema.ready',
} as const;

export type MetaKey = (typeof META_KEYS)[keyof typeof META_KEYS] | (string & {});

export class MetaRepository {
  constructor(private readonly db: SqlExecutor) {}

  async get(key: MetaKey): Promise<string | null> {
    const rows = await this.db.select<{ value: string | null }>(
      'SELECT value FROM app_meta WHERE key = ?',
      [key],
    );
    return rows[0]?.value ?? null;
  }

  async getNumber(key: MetaKey, fallback = 0): Promise<number> {
    const raw = await this.get(key);
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) ? value : fallback;
  }

  async set(key: MetaKey, value: string | null): Promise<void> {
    await this.db.execute(
      `INSERT INTO app_meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }

  async remove(key: MetaKey): Promise<void> {
    await this.db.execute('DELETE FROM app_meta WHERE key = ?', [key]);
  }
}
