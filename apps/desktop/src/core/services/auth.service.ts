import { PERMISSIONS, nowIso } from '@boutique/shared';
import type { SessionUser, UserStatus } from '@boutique/shared';
import { UserRepository, type UserInput } from '../db/repositories/user.repository';
import { RoleRepository } from '../db/repositories/role.repository';
import { AUDIT_ACTIONS, AuditRepository } from '../db/repositories/audit.repository';
import { checkPasswordStrength, hashPassword, needsRehash, verifyPassword } from '../auth/password';
import { cleSecoursPlausible, genererCleSecours, normaliserCleSecours } from '../auth/cle-secours';
import { POSTE_KEYS, SettingRepository } from '../db/repositories/setting.repository';
import { BusinessError, assertCan, assertQuota, type AppContext } from './context';
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

  /**
   * Déblocage d'un administrateur par la clé de secours.
   *
   * SANS SESSION, ET C'EST TOUT SON OBJET : on l'appelle précisément parce que
   * personne ne peut plus se connecter. Elle vit donc sur `AuthService`, à côté
   * de `login`, et non sur `UserService` où tout exige déjà un droit.
   *
   * TROIS GARDES, chacune pour une raison distincte :
   *
   *   — le compte visé doit être ADMINISTRATEUR. La clé sert à récupérer
   *     l'administration, pas à changer discrètement le mot de passe d'un
   *     caissier — un administrateur sait déjà le faire, et lui laisse une
   *     trace à son nom ;
   *   — le compte doit être ACTIF. Rouvrir un compte désactivé par cette porte
   *     contournerait la décision de celui qui l'a fermé ;
   *   — la clé est REMPLACÉE à chaque usage. Une clé recopiée sur un carnet,
   *     photographiée ou dictée au téléphone ne doit pas rester valable
   *     indéfiniment ; la nouvelle est rendue à l'appelant, qui l'affiche.
   *
   * L'opération est inscrite au journal d'audit sans auteur connu : c'est
   * exactement ce qu'elle est, et le dissimuler serait pire.
   */
  async resetWithRecoveryKey(
    cle: string,
    login: string,
    nouveauMotDePasse: string,
  ): Promise<{ nouvelleCle: string }> {
    const empreinte = await new SettingRepository(this.db).raw(POSTE_KEYS.recoveryHash);
    if (!empreinte) {
      throw new BusinessError(
        'Aucune clé de secours n’a été produite sur ce poste. Il a été installé par une version antérieure du logiciel : demandez à un administrateur encore connecté d’en produire une dans les paramètres.',
      );
    }

    const propre = normaliserCleSecours(cle);
    if (!cleSecoursPlausible(propre) || !(await verifyPassword(propre, empreinte))) {
      // Le même message pour une clé mal formée et pour une clé fausse : dire
      // laquelle des deux renseignerait qui essaie au hasard.
      throw new BusinessError('Clé de secours refusée.');
    }

    const utilisateur = await new UserRepository(this.db).byLogin(login.trim().toLowerCase());
    if (!utilisateur) throw new BusinessError('Aucun compte ne porte cet identifiant.');
    if (utilisateur.status !== 'ACTIVE') {
      throw new BusinessError('Ce compte est désactivé. La clé de secours ne le rouvre pas.');
    }

    const role = await new RoleRepository(this.db).byId(utilisateur.roleId);
    if (!role?.permissions.includes(PERMISSIONS.userManage)) {
      throw new BusinessError(
        'La clé de secours ne débloque qu’un compte administrateur. Pour les autres, un administrateur suffit.',
      );
    }

    const probleme = checkPasswordStrength(nouveauMotDePasse);
    if (probleme) throw new BusinessError(probleme);

    const nouvelleCle = genererCleSecours();
    const users = new UserRepository(this.db);
    await users.setPassword(utilisateur.id, await hashPassword(nouveauMotDePasse));
    await new SettingRepository(this.db).set(
      POSTE_KEYS.recoveryHash,
      await hashPassword(normaliserCleSecours(nouvelleCle)),
      null,
    );
    await new AuditRepository(this.db).write({
      action: AUDIT_ACTIONS.update,
      entity: 'app_user',
      entityId: utilisateur.id,
      userId: null,
      userLabel: 'clé de secours',
      shopId: utilisateur.shopId,
      after: { motDePasse: 'réinitialisé par clé de secours' },
    });

    return { nouvelleCle };
  }

  /**
   * Produit une nouvelle clé de secours, en remplacement de l'ancienne.
   *
   * Réservée à un administrateur connecté : c'est le geste qu'on fait quand la
   * clé a été égarée, ou qu'elle a circulé.
   */
  async renewRecoveryKey(context: AppContext): Promise<string> {
    assertCan(context, PERMISSIONS.userManage);
    const cle = genererCleSecours();
    await new SettingRepository(this.db).set(
      POSTE_KEYS.recoveryHash,
      await hashPassword(normaliserCleSecours(cle)),
      null,
    );
    await new AuditRepository(this.db).write({
      action: AUDIT_ACTIONS.update,
      entity: 'setting',
      entityId: POSTE_KEYS.recoveryHash,
      userId: context.session?.id ?? null,
      userLabel: context.session?.fullName ?? null,
      shopId: context.shopId,
      after: { cleSecours: 'renouvelée' },
    });
    return cle;
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

    // Le plafond porte sur les comptes ACTIFS de tout le poste, toutes
    // boutiques confondues : c'est ce qui a été vendu.
    assertQuota(this.context, 'utilisateurs', (await users.list()).length, 'compte(s)');

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
