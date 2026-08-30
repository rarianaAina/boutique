import { ALL_PERMISSIONS } from '@boutique/shared';
import type { Permission } from '@boutique/shared';
import { UserRepository } from '@/core/db/repositories/user.repository';
import { DEFAULT_SETTINGS } from '@/core/db/repositories/setting.repository';
import type { ShopSettings } from '@/core/db/repositories/setting.repository';
import type { AppContext } from '@/core/services/context';
import type { SqlExecutor } from '@/core/db/client';

/**
 * Contexte de service pour les tests.
 *
 * Les permissions peuvent être restreintes explicitement : c'est ainsi que l'on
 * vérifie qu'un service REFUSE une opération, sans avoir à construire un rôle
 * complet dans chaque test.
 */
export async function contextFor(
  db: SqlExecutor,
  userId: string,
  overrides: { permissions?: Permission[]; settings?: Partial<ShopSettings> } = {},
): Promise<AppContext> {
  const session = await new UserRepository(db).sessionFor(userId);
  if (!session) throw new Error(`utilisateur ${userId} introuvable`);
  return {
    db,
    session: {
      ...session,
      permissions: overrides.permissions ?? [...ALL_PERMISSIONS],
    },
    shopId: session.shopId,
    shopCode: session.shopCode,
    settings: { ...DEFAULT_SETTINGS, ...overrides.settings },
  };
}
