import { invoke } from '@tauri-apps/api/core';
import { PERMISSIONS, nowIso } from '@boutique/shared';
import { META_KEYS, MetaRepository } from '../db/repositories/meta.repository';
import { AUDIT_ACTIONS, AuditRepository } from '../db/repositories/audit.repository';
import { DB_URL } from '../db/client';
import { assertCan, type AppContext } from './context';

/**
 * Sauvegardes locales (§32).
 *
 * L'application fonctionne hors ligne : les ventes du jour, les IMEI entrés et
 * les réceptions n'existent NULLE PART ailleurs tant que la synchronisation n'a
 * pas eu lieu. Un disque qui lâche, c'est l'activité perdue.
 *
 * La copie est faite côté Rust par `VACUUM INTO`, seule méthode sûre sur une
 * base en cours d'utilisation. La sauvegarde du jour est déclenchée AU
 * DÉMARRAGE plutôt qu'à la fermeture : un poste de boutique s'éteint rarement
 * proprement — c'est justement le cas qu'on veut couvrir.
 */

export interface BackupInfo {
  path: string;
  bytes: number;
}

export class BackupService {
  private readonly meta: MetaRepository;

  constructor(private readonly context: AppContext) {
    this.meta = new MetaRepository(context.db);
  }

  async run(label?: string): Promise<BackupInfo> {
    assertCan(this.context, PERMISSIONS.backupManage);
    const stamp = label ?? new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const info = await invoke<BackupInfo>('backup_database', {
      db: DB_URL,
      label: stamp,
      keep: this.context.settings.backupKeep,
    });
    await this.meta.set(META_KEYS.lastBackupAt, nowIso());
    await new AuditRepository(this.context.db).write({
      action: AUDIT_ACTIONS.backup,
      entity: 'backup',
      userId: this.context.session?.id ?? null,
      userLabel: this.context.session?.fullName ?? null,
      shopId: this.context.shopId,
      after: { fichier: info.path, octets: info.bytes },
    });
    return info;
  }

  list(): Promise<BackupInfo[]> {
    return invoke<BackupInfo[]>('list_backups');
  }

  lastBackupAt(): Promise<string | null> {
    return this.meta.get(META_KEYS.lastBackupAt);
  }

  /** Contrôle d'intégrité : `ok` si la base est saine. */
  checkIntegrity(): Promise<string> {
    return invoke<string>('check_integrity', { db: DB_URL });
  }

  /**
   * Prépare une restauration.
   *
   * Le fichier n'est PAS substitué immédiatement : la base est ouverte, et
   * l'écraser en cours d'utilisation la corromprait. La copie est déposée à
   * côté, et le remplacement a lieu au prochain démarrage — l'utilisateur est
   * invité à redémarrer.
   */
  async prepareRestore(sourcePath: string): Promise<string> {
    assertCan(this.context, PERMISSIONS.backupManage);
    const staged = await invoke<string>('restore_database', { source: sourcePath });
    await new AuditRepository(this.context.db).write({
      action: AUDIT_ACTIONS.backup,
      entity: 'backup',
      userId: this.context.session?.id ?? null,
      userLabel: this.context.session?.fullName ?? null,
      shopId: this.context.shopId,
      after: { restaurationPreparee: sourcePath },
    });
    return staged;
  }

  /** Sauvegarde au plus une fois par jour, au démarrage. */
  async runIfDue(): Promise<BackupInfo | null> {
    if (!this.context.settings.backupDaily) return null;
    const last = await this.lastBackupAt();
    const today = new Date().toISOString().slice(0, 10);
    if (last && last.slice(0, 10) === today) return null;
    return this.run(today);
  }
}
