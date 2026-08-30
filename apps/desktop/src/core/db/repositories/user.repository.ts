import { newId, nowIso } from '@boutique/shared';
import type { Permission, SessionUser, User, UserStatus } from '@boutique/shared';
import { parseJson } from '../rows';
import type { SqlExecutor } from '../client';

/**
 * Utilisateurs.
 *
 * L'empreinte du mot de passe ne quitte JAMAIS ce dépôt : `User` ne la porte
 * pas, et la seule méthode qui la renvoie s'appelle `credentialsFor`, pour
 * qu'une lecture accidentelle se remarque à la relecture du code.
 */

interface UserRow {
  id: string;
  shop_id: string;
  full_name: string;
  login: string;
  email: string | null;
  role_id: string;
  status: UserStatus;
  last_login_at: string | null;
  failed_attempts: number;
  locked_until: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  shopId: row.shop_id,
  fullName: row.full_name,
  login: row.login,
  email: row.email,
  roleId: row.role_id,
  status: row.status,
  lastLoginAt: row.last_login_at,
  failedAttempts: row.failed_attempts,
  lockedUntil: row.locked_until,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
});

export interface UserInput {
  shopId: string;
  fullName: string;
  login: string;
  email?: string | null;
  roleId: string;
  status?: UserStatus;
}

/** Ce que la vérification du mot de passe a besoin de connaître, et rien de plus. */
export interface Credentials {
  id: string;
  passwordHash: string;
  status: UserStatus;
  failedAttempts: number;
  lockedUntil: string | null;
}

export class UserRepository {
  constructor(private readonly db: SqlExecutor) {}

  async list(shopId?: string): Promise<User[]> {
    const rows = shopId
      ? await this.db.select<UserRow>(
          'SELECT * FROM app_user WHERE deleted_at IS NULL AND shop_id = ? ORDER BY full_name',
          [shopId],
        )
      : await this.db.select<UserRow>(
          'SELECT * FROM app_user WHERE deleted_at IS NULL ORDER BY full_name',
        );
    return rows.map(toUser);
  }

  async byId(id: string): Promise<User | null> {
    const rows = await this.db.select<UserRow>('SELECT * FROM app_user WHERE id = ?', [id]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async byLogin(login: string): Promise<User | null> {
    const rows = await this.db.select<UserRow>(
      'SELECT * FROM app_user WHERE login = ? AND deleted_at IS NULL',
      [login.trim().toLowerCase()],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }

  async credentialsFor(login: string): Promise<Credentials | null> {
    const rows = await this.db.select<{
      id: string;
      password_hash: string;
      status: UserStatus;
      failed_attempts: number;
      locked_until: string | null;
    }>(
      `SELECT id, password_hash, status, failed_attempts, locked_until
       FROM app_user WHERE login = ? AND deleted_at IS NULL`,
      [login.trim().toLowerCase()],
    );
    const row = rows[0];
    return row
      ? {
          id: row.id,
          passwordHash: row.password_hash,
          status: row.status,
          failedAttempts: row.failed_attempts,
          lockedUntil: row.locked_until,
        }
      : null;
  }

  /**
   * Vue complète d'une session : utilisateur, boutique et permissions du rôle,
   * aplaties en une lecture. L'application interroge cette méthode une fois à
   * la connexion ; aucun écran ne va rechercher les permissions ligne à ligne.
   */
  async sessionFor(userId: string): Promise<SessionUser | null> {
    const rows = await this.db.select<{
      id: string;
      shop_id: string;
      full_name: string;
      login: string;
      role_id: string;
      role_code: string;
      role_name: string;
      permissions: string;
      shop_code: string;
      shop_name: string;
    }>(
      `SELECT u.id, u.shop_id, u.full_name, u.login, u.role_id,
              r.code AS role_code, r.name AS role_name, r.permissions,
              s.code AS shop_code, s.name AS shop_name
       FROM app_user u
       JOIN role r ON r.id = u.role_id
       JOIN shop s ON s.id = u.shop_id
       WHERE u.id = ? AND u.deleted_at IS NULL`,
      [userId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      shopId: row.shop_id,
      shopCode: row.shop_code,
      shopName: row.shop_name,
      fullName: row.full_name,
      login: row.login,
      roleId: row.role_id,
      roleCode: row.role_code,
      roleName: row.role_name,
      permissions: parseJson<Permission[]>(row.permissions, []),
    };
  }

  async create(input: UserInput, passwordHash: string, id = newId()): Promise<string> {
    const at = nowIso();
    await this.db.execute(
      `INSERT INTO app_user (id, shop_id, full_name, login, email, password_hash, role_id,
                             status, failed_attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        id,
        input.shopId,
        input.fullName,
        input.login.trim().toLowerCase(),
        input.email ?? null,
        passwordHash,
        input.roleId,
        input.status ?? 'ACTIVE',
        at,
        at,
      ],
    );
    return id;
  }

  async update(id: string, input: Partial<UserInput>): Promise<void> {
    await this.db.execute(
      `UPDATE app_user SET
         shop_id = COALESCE(?, shop_id),
         full_name = COALESCE(?, full_name),
         login = COALESCE(?, login),
         email = COALESCE(?, email),
         role_id = COALESCE(?, role_id),
         status = COALESCE(?, status),
         updated_at = ?
       WHERE id = ?`,
      [
        input.shopId ?? null,
        input.fullName ?? null,
        input.login?.trim().toLowerCase() ?? null,
        input.email ?? null,
        input.roleId ?? null,
        input.status ?? null,
        nowIso(),
        id,
      ],
    );
  }

  async setPassword(id: string, passwordHash: string): Promise<void> {
    // Un changement de mot de passe lève aussi le verrouillage : c'est
    // précisément la façon dont un gérant débloque un vendeur.
    await this.db.execute(
      `UPDATE app_user
       SET password_hash = ?, failed_attempts = 0, locked_until = NULL, updated_at = ?
       WHERE id = ?`,
      [passwordHash, nowIso(), id],
    );
  }

  async markLoginSuccess(id: string): Promise<void> {
    const at = nowIso();
    await this.db.execute(
      `UPDATE app_user
       SET last_login_at = ?, failed_attempts = 0, locked_until = NULL, updated_at = ?
       WHERE id = ?`,
      [at, at, id],
    );
  }

  async markLoginFailure(id: string, lockedUntil: string | null): Promise<void> {
    await this.db.execute(
      `UPDATE app_user
       SET failed_attempts = failed_attempts + 1, locked_until = ?, updated_at = ?
       WHERE id = ?`,
      [lockedUntil, nowIso(), id],
    );
  }

  async softDelete(id: string): Promise<void> {
    const at = nowIso();
    await this.db.execute(
      `UPDATE app_user SET deleted_at = ?, status = 'ARCHIVED', updated_at = ? WHERE id = ?`,
      [at, at, id],
    );
  }

  /** Y a-t-il au moins un compte ? Décide de l'écran de premier démarrage. */
  async isEmpty(): Promise<boolean> {
    const rows = await this.db.select<{ total: number }>(
      'SELECT COUNT(*) AS total FROM app_user WHERE deleted_at IS NULL',
    );
    return (rows[0]?.total ?? 0) === 0;
  }
}
