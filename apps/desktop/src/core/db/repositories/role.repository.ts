import { ROLE_PRESETS, newId, nowIso } from '@boutique/shared';
import type { Permission, Role } from '@boutique/shared';
import { fromBool, parseJson, toBool, toJson } from '../rows';
import type { SqlExecutor } from '../client';

/**
 * Rôles.
 *
 * Les permissions sont stockées en JSON plutôt qu'en table de liaison : leur
 * liste grandit à chaque version du logiciel, et une table imposerait une
 * migration pour chaque permission ajoutée. La validation est faite avant
 * écriture, côté TypeScript, à partir de `ALL_PERMISSIONS`.
 */

interface RoleRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  permissions: string;
  is_system: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const toRole = (row: RoleRow): Role => ({
  id: row.id,
  code: row.code,
  name: row.name,
  description: row.description,
  permissions: parseJson<Permission[]>(row.permissions, []),
  isSystem: toBool(row.is_system),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
});

export class RoleRepository {
  constructor(private readonly db: SqlExecutor) {}

  async list(): Promise<Role[]> {
    const rows = await this.db.select<RoleRow>(
      'SELECT * FROM role WHERE deleted_at IS NULL ORDER BY name',
    );
    return rows.map(toRole);
  }

  async byId(id: string): Promise<Role | null> {
    const rows = await this.db.select<RoleRow>('SELECT * FROM role WHERE id = ?', [id]);
    return rows[0] ? toRole(rows[0]) : null;
  }

  async byCode(code: string): Promise<Role | null> {
    const rows = await this.db.select<RoleRow>('SELECT * FROM role WHERE code = ?', [code]);
    return rows[0] ? toRole(rows[0]) : null;
  }

  async create(
    input: { code: string; name: string; description?: string | null; permissions: Permission[] },
    isSystem = false,
    id = newId(),
  ): Promise<string> {
    const at = nowIso();
    await this.db.execute(
      `INSERT INTO role (id, code, name, description, permissions, is_system, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.code.toUpperCase(),
        input.name,
        input.description ?? null,
        toJson(input.permissions),
        fromBool(isSystem),
        at,
        at,
      ],
    );
    return id;
  }

  async update(
    id: string,
    input: { name?: string; description?: string | null; permissions?: Permission[] },
  ): Promise<void> {
    await this.db.execute(
      `UPDATE role SET
         name = COALESCE(?, name),
         description = COALESCE(?, description),
         permissions = COALESCE(?, permissions),
         updated_at = ?
       WHERE id = ?`,
      [
        input.name ?? null,
        input.description ?? null,
        input.permissions ? toJson(input.permissions) : null,
        nowIso(),
        id,
      ],
    );
  }

  /**
   * Crée les rôles livrés avec le logiciel, s'ils manquent.
   *
   * Idempotent : appelé à chaque démarrage, il ne recrée pas ce qui existe et
   * ne réécrit PAS les permissions d'un rôle qu'un administrateur a ajusté.
   * Une mise à jour du logiciel ne doit pas défaire un réglage local.
   */
  async ensurePresets(): Promise<number> {
    const existing = new Set((await this.list()).map((role) => role.code));
    const missing = ROLE_PRESETS.filter((preset) => !existing.has(preset.code));
    if (missing.length === 0) return 0;

    await this.db.transaction(async (tx) => {
      const repository = new RoleRepository(tx);
      for (const preset of missing) {
        await repository.create(
          {
            code: preset.code,
            name: preset.name,
            description: preset.description,
            permissions: preset.permissions,
          },
          true,
        );
      }
    });
    return missing.length;
  }

  /** Un rôle système ne se supprime pas : il porte l'accès de comptes existants. */
  async softDelete(id: string): Promise<void> {
    const at = nowIso();
    await this.db.execute(
      'UPDATE role SET deleted_at = ?, updated_at = ? WHERE id = ? AND is_system = 0',
      [at, at, id],
    );
  }

  async countUsers(roleId: string): Promise<number> {
    const rows = await this.db.select<{ total: number }>(
      'SELECT COUNT(*) AS total FROM app_user WHERE role_id = ? AND deleted_at IS NULL',
      [roleId],
    );
    return rows[0]?.total ?? 0;
  }
}
