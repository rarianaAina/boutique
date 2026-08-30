import { PERMISSIONS, nowIso } from '@boutique/shared';
import type { SessionUser, UserStatus } from '@boutique/shared';
import { UserRepository, type UserInput } from '../db/repositories/user.repository';
import { RoleRepository } from '../db/repositories/role.repository';
import { AUDIT_ACTIONS, AuditRepository } from '../db/repositories/audit.repository';
import { checkPasswordStrength, hashPassword, needsRehash, verifyPassword } from '../auth/password';
import { BusinessError, assertCan, type AppContext } from './context';
import type { SqlExecutor } from '../db/client';

/**
 * Authentification locale (§20).
 *
 * Tout se passe hors ligne : aucun appel réseau n'intervient dans une
 * connexion. Une boutique dont la clé 4G est débranchée doit pouvoir ouvrir
 * sa caisse.
 *
 * Le verrouillage temporaire après plusieurs échecs protège d'un essai
 * systématique de codes courts sur un poste laissé sans surveillance. Il est
 * TEMPORAIRE, jamais définitif : un vendeur bloqué en plein service, un samedi,
 * sans administrateur joignable, coûterait plus cher que le risque couvert.
 */

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 5;

export interface LoginResult {
  session: SessionUser;
  /** Vrai si l'empreinte a été recalculée avec le coût courant. */
  rehashed: boolean;
}

export class AuthService {
  constructor(private readonly db: SqlExecutor) {}

  /**
   * Vérifie des identifiants.
   *
   * Le message d'erreur est le MÊME pour un login inconnu et pour un mot de
   * passe faux : distinguer les deux renseignerait sur les comptes existants.
   * Le cas du compte verrouillé, lui, est annoncé — sinon l'utilisateur
   * ressaierait indéfiniment sans comprendre.
   */
  async login(login: string, password: string): Promise<LoginResult> {
    const users = new UserRepository(this.db);
    const credentials = await users.credentialsFor(login);

    if (!credentials) {
      // Le temps de réponse doit rester comparable à celui d'un vrai échec :
      // sans cela, un login inconnu se reconnaîtrait à sa rapidité.
      await verifyPassword(password, 'pbkdf2-sha256$210000$AAAA$AAAA');
      throw new BusinessError('Identifiant ou mot de passe incorrect.', 'BAD_CREDENTIALS');
    }

    if (credentials.lockedUntil && credentials.lockedUntil > nowIso()) {
      const until = new Date(credentials.lockedUntil);
      throw new BusinessError(
        `Compte verrouillé jusqu'à ${until.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}.`,
        'LOCKED',
      );
    }

    if (credentials.status !== 'ACTIVE') {
      throw new BusinessError("Ce compte n'est plus actif.", 'INACTIVE');
    }

    const valid = await verifyPassword(password, credentials.passwordHash);
    if (!valid) {
      const attempts = credentials.failedAttempts + 1;
      const lockedUntil =
        attempts >= MAX_ATTEMPTS
          ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString()
          : null;
      await users.markLoginFailure(credentials.id, lockedUntil);
      await new AuditRepository(this.db).write({
        action: AUDIT_ACTIONS.loginFailed,
        entity: 'app_user',
        entityId: credentials.id,
        after: { tentatives: attempts, verrouille: lockedUntil !== null },
      });
      throw new BusinessError('Identifiant ou mot de passe incorrect.', 'BAD_CREDENTIALS');
    }

    const session = await users.sessionFor(credentials.id);
    if (!session) throw new BusinessError('Compte introuvable.', 'BAD_CREDENTIALS');

    await users.markLoginSuccess(credentials.id);

    // Le coût de dérivation augmente avec les versions : on en profite pour
    // réencoder l'empreinte, une seule fois, quand l'utilisateur vient de
    // fournir son mot de passe en clair.
    let rehashed = false;
    if (needsRehash(credentials.passwordHash)) {
      await users.setPassword(credentials.id, await hashPassword(password));
      rehashed = true;
    }

    await new AuditRepository(this.db).write({
      action: AUDIT_ACTIONS.login,
      entity: 'app_user',
      entityId: session.id,
      userId: session.id,
      userLabel: session.fullName,
      shopId: session.shopId,
    });

    return { session, rehashed };
  }

  async logout(session: SessionUser): Promise<void> {
    await new AuditRepository(this.db).write({
      action: AUDIT_ACTIONS.logout,
      entity: 'app_user',
      entityId: session.id,
      userId: session.id,
      userLabel: session.fullName,
      shopId: session.shopId,
    });
  }

  /** Changement de son propre mot de passe : l'ancien est exigé. */
  async changeOwnPassword(
    session: SessionUser,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const users = new UserRepository(this.db);
    const credentials = await users.credentialsFor(session.login);
    if (!credentials || !(await verifyPassword(currentPassword, credentials.passwordHash))) {
      throw new BusinessError('Mot de passe actuel incorrect.');
    }
    const problem = checkPasswordStrength(newPassword);
    if (problem) throw new BusinessError(problem);

    await users.setPassword(session.id, await hashPassword(newPassword));
    await new AuditRepository(this.db).write({
      action: AUDIT_ACTIONS.update,
      entity: 'app_user',
      entityId: session.id,
      userId: session.id,
      userLabel: session.fullName,
      shopId: session.shopId,
      after: { motDePasse: 'modifié' },
    });
  }
}

/** Gestion des comptes, réservée aux détenteurs de `user.manage`. */
export class UserService {
  constructor(private readonly context: AppContext) {}

  async create(input: UserInput, password: string): Promise<string> {
    assertCan(this.context, PERMISSIONS.userManage);

    const problem = checkPasswordStrength(password);
    if (problem) throw new BusinessError(problem);

    const users = new UserRepository(this.context.db);
    if (await users.byLogin(input.login)) {
      throw new BusinessError(`L'identifiant « ${input.login} » est déjà utilisé.`);
    }
    if (!(await new RoleRepository(this.context.db).byId(input.roleId))) {
      throw new BusinessError('Rôle introuvable.');
    }

    const id = await users.create(input, await hashPassword(password));
    await new AuditRepository(this.context.db).write({
      action: AUDIT_ACTIONS.create,
      entity: 'app_user',
      entityId: id,
      userId: this.context.session?.id ?? null,
      userLabel: this.context.session?.fullName ?? null,
      shopId: this.context.shopId,
      after: { login: input.login, nom: input.fullName, role: input.roleId },
    });
    return id;
  }

  async update(id: string, input: Partial<UserInput>): Promise<void> {
    assertCan(this.context, PERMISSIONS.userManage);
    const users = new UserRepository(this.context.db);
    const before = await users.byId(id);
    if (!before) throw new BusinessError('Utilisateur introuvable.');

    if (input.login && input.login !== before.login) {
      const clash = await users.byLogin(input.login);
      if (clash && clash.id !== id) {
        throw new BusinessError(`L'identifiant « ${input.login} » est déjà utilisé.`);
      }
    }

    await users.update(id, input);
    await new AuditRepository(this.context.db).write({
      action: AUDIT_ACTIONS.update,
      entity: 'app_user',
      entityId: id,
      userId: this.context.session?.id ?? null,
      userLabel: this.context.session?.fullName ?? null,
      shopId: this.context.shopId,
      before: { nom: before.fullName, role: before.roleId, statut: before.status },
      after: input,
    });
  }

  /** Réinitialisation par un administrateur : l'ancien mot de passe n'est pas demandé. */
  async resetPassword(id: string, password: string): Promise<void> {
    assertCan(this.context, PERMISSIONS.userManage);
    const problem = checkPasswordStrength(password);
    if (problem) throw new BusinessError(problem);

    await new UserRepository(this.context.db).setPassword(id, await hashPassword(password));
    await new AuditRepository(this.context.db).write({
      action: AUDIT_ACTIONS.update,
      entity: 'app_user',
      entityId: id,
      userId: this.context.session?.id ?? null,
      userLabel: this.context.session?.fullName ?? null,
      shopId: this.context.shopId,
      after: { motDePasse: 'réinitialisé' },
    });
  }

  async setStatus(id: string, status: UserStatus): Promise<void> {
    assertCan(this.context, PERMISSIONS.userManage);
    if (id === this.context.session?.id && status !== 'ACTIVE') {
      // Se désactiver soi-même verrouillerait l'accès à l'administration si
      // c'est le dernier compte : on refuse plutôt que d'avoir à réparer.
      throw new BusinessError('Vous ne pouvez pas désactiver votre propre compte.');
    }
    await new UserRepository(this.context.db).update(id, { status });
  }
}
