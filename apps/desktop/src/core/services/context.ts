import { PermissionDeniedError, licenceQuota, requirePermission } from '@boutique/shared';
import type { LicenceStatus, Permission, Principal, SessionUser } from '@boutique/shared';
import type { ShopSettings } from '../db/repositories/setting.repository';
import type { SqlExecutor } from '../db/client';

/**
 * Contexte d'exécution d'un service.
 *
 * Il porte les trois choses dont TOUTE opération métier a besoin : par où
 * écrire, qui écrit, et selon quels réglages. Les passer explicitement plutôt
 * que par un état global rend chaque service testable sans lancer
 * l'application, et rend impossible d'oublier de quelle boutique on parle —
 * l'erreur la plus coûteuse dans un logiciel multi-sites.
 */
export interface AppContext {
  db: SqlExecutor;
  /** Utilisateur connecté. Null uniquement pendant l'installation initiale. */
  session: SessionUser | null;
  shopId: string;
  shopCode: string;
  settings: ShopSettings;
  /**
   * Licence du poste, quand elle est connue.
   *
   * Facultative à dessein : l'installation initiale et les épreuves construisent
   * un contexte avant qu'il y ait quoi que ce soit à activer. Absente, les
   * plafonds ne s'appliquent pas — c'est le comportement d'un poste en essai,
   * où tout est ouvert.
   */
  licence?: LicenceStatus | null;
}

export function principalOf(context: AppContext): Principal | null {
  const session = context.session;
  return session
    ? {
        userId: session.id,
        shopId: session.shopId,
        roleCode: session.roleCode,
        permissions: session.permissions,
      }
    : null;
}

/**
 * Vérification de permission côté SERVICE.
 *
 * Masquer un bouton ne protège rien : le cahier des charges exige la
 * vérification aux deux niveaux (§28). C'est ici qu'elle a un effet, l'écran ne
 * faisant qu'éviter de proposer une action vouée à l'échec.
 */
export function assertCan(context: AppContext, permission: Permission): void {
  requirePermission(principalOf(context), permission);
}

export function mayNot(context: AppContext, permission: Permission): PermissionDeniedError | null {
  try {
    assertCan(context, permission);
    return null;
  } catch (cause) {
    return cause instanceof PermissionDeniedError ? cause : null;
  }
}

/** Auteur d'une écriture, tel que l'audit et les mouvements l'enregistrent. */
export function actorOf(context: AppContext): { userId: string | null; userLabel: string | null } {
  return {
    userId: context.session?.id ?? null,
    userLabel: context.session?.fullName ?? null,
  };
}

/**
 * Erreur métier attendue, par opposition à une panne.
 *
 * L'interface l'affiche telle quelle, sans trace technique : « Cet appareil est
 * déjà vendu » est une information, pas un incident à signaler au support.
 */
export class BusinessError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'BusinessError';
  }
}

/**
 * Refus opposé à un plafond de licence atteint.
 *
 * Distinct d'une permission manquante, et le message doit le dire : un droit se
 * règle chez le client, dans « Utilisateurs et rôles » ; un plafond ne se lève
 * qu'en achetant. Les confondre ferait chercher pendant une heure un réglage
 * qui n'existe pas.
 */
export class QuotaError extends BusinessError {
  constructor(message: string) {
    super(message, 'QUOTA');
    this.name = 'QuotaError';
  }
}

/**
 * Vérifie qu'un plafond de la licence n'est pas déjà atteint.
 *
 * `actuel` est le nombre d'éléments DÉJÀ existants : on refuse quand il atteint
 * le plafond, puisque l'appel qui suit en ajouterait un.
 *
 * Sans licence connue — installation initiale, épreuves — rien n'est refusé.
 * Un plafond absent de la charge vaut « un seul » : le silence se lit toujours
 * dans le sens le plus prudent.
 */
export function assertQuota(
  context: AppContext,
  cle: string,
  actuel: number,
  libelle: string,
): void {
  const licence = context.licence;
  if (!licence) return;

  const plafond = licenceQuota(licence, cle, 1);
  if (actuel < plafond) return;
  throw new QuotaError(
    `Votre licence autorise ${plafond} ${libelle}${plafond > 1 ? '' : ''}. ` +
      `Pour en ajouter, il faut étendre la licence de ce poste.`,
  );
}
