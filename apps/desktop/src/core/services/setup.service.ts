import { DEFAULT_PAYMENT_METHODS, newId, nowIso } from '@boutique/shared';
import { RoleRepository } from '../db/repositories/role.repository';
import { ShopRepository } from '../db/repositories/shop.repository';
import { UserRepository } from '../db/repositories/user.repository';
import { META_KEYS, MetaRepository } from '../db/repositories/meta.repository';
import { checkPasswordStrength, hashPassword } from '../auth/password';
import { BusinessError } from './context';
import type { SqlExecutor } from '../db/client';

/**
 * Premier démarrage.
 *
 * Une base neuve n'a ni boutique ni compte : l'application affiche un écran
 * d'installation plutôt qu'un formulaire de connexion impossible à satisfaire.
 * Le compte créé ici est administrateur — c'est le seul moment où un compte est
 * créé sans qu'un utilisateur connecté en ait la permission.
 */

export interface SetupInput {
  shopCode: string;
  shopName: string;
  address?: string | null;
  phone?: string | null;
  adminFullName: string;
  adminLogin: string;
  adminPassword: string;
}

export class SetupService {
  constructor(private readonly db: SqlExecutor) {}

  /** L'application a-t-elle besoin d'être installée ? */
  async needsSetup(): Promise<boolean> {
    const shop = await new ShopRepository(this.db).local();
    if (!shop) return true;
    return new UserRepository(this.db).isEmpty();
  }

  async run(input: SetupInput): Promise<{ shopId: string; userId: string }> {
    if (!(await this.needsSetup())) {
      throw new BusinessError("L'application est déjà installée.");
    }

    const code = input.shopCode.trim().toUpperCase();
    if (!/^[A-Z0-9]{2,8}$/.test(code)) {
      throw new BusinessError(
        'Le code boutique doit compter de 2 à 8 lettres ou chiffres (il apparaît dans les numéros de tickets).',
      );
    }
    if (input.shopName.trim() === '')
      throw new BusinessError('Le nom de la boutique est obligatoire.');
    if (input.adminLogin.trim() === '') throw new BusinessError("L'identifiant est obligatoire.");

    const problem = checkPasswordStrength(input.adminPassword);
    if (problem) throw new BusinessError(problem);

    const shops = new ShopRepository(this.db);
    if (await shops.byCode(code)) throw new BusinessError(`Le code « ${code} » est déjà utilisé.`);

    await new RoleRepository(this.db).ensurePresets();
    const adminRole = await new RoleRepository(this.db).byCode('ADMIN');
    if (!adminRole) throw new Error('rôle administrateur absent après initialisation');

    const shopId = await shops.create({
      code,
      name: input.shopName.trim(),
      address: input.address ?? null,
      phone: input.phone ?? null,
      isLocal: true,
    });

    const userId = await new UserRepository(this.db).create(
      {
        shopId,
        fullName: input.adminFullName.trim(),
        login: input.adminLogin.trim().toLowerCase(),
        roleId: adminRole.id,
      },
      await hashPassword(input.adminPassword),
    );

    await ensurePaymentMethods(this.db);
    await new MetaRepository(this.db).set(META_KEYS.deviceId, newId());

    return { shopId, userId };
  }
}

/**
 * Modes de paiement livrés par défaut.
 *
 * Ils sont insérés une fois, sans écraser ce qu'un gérant aurait modifié : la
 * liste est paramétrable (§12), et une mise à jour du logiciel ne doit pas
 * réactiver un mode que la boutique avait désactivé.
 */
export async function ensurePaymentMethods(db: SqlExecutor): Promise<void> {
  for (const [index, method] of DEFAULT_PAYMENT_METHODS.entries()) {
    await db.execute(
      `INSERT INTO payment_method (code, label, is_active, change_allowed, position)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT (code) DO NOTHING`,
      [method.code, method.label, method.changeAllowed ? 1 : 0, index],
    );
  }
}

/** Modes de paiement actifs, pour l'écran d'encaissement. */
export async function activePaymentMethods(
  db: SqlExecutor,
): Promise<{ code: string; label: string; changeAllowed: boolean }[]> {
  const rows = await db.select<{ code: string; label: string; change_allowed: number }>(
    'SELECT code, label, change_allowed FROM payment_method WHERE is_active = 1 ORDER BY position',
  );
  return rows.map((row) => ({
    code: row.code,
    label: row.label,
    changeAllowed: row.change_allowed === 1,
  }));
}

export { nowIso };
