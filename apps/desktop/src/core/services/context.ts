import { PermissionDeniedError, requirePermission } from '@boutique/shared';
import type { Permission, Principal, SessionUser } from '@boutique/shared';
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
