import { completeImei, newId, nowIso } from '@boutique/shared';
import type { Tracking } from '@boutique/shared';
import { RoleRepository } from '@/core/db/repositories/role.repository';
import { ShopRepository } from '@/core/db/repositories/shop.repository';
import { UserRepository } from '@/core/db/repositories/user.repository';
import { ProductRepository } from '@/core/db/repositories/product.repository';
import { createTestDb, type TestExecutor } from './sqlite-executor';
import type { SqlExecutor } from '@/core/db/client';

/**
 * Jeu de données minimal partagé par les tests.
 *
 * Volontairement réduit : deux boutiques, quelques rôles, trois produits — un
 * par mode de suivi. Chaque test ajoute ce dont il a besoin, plutôt que de
 * s'appuyer sur un décor commun qui finirait par cacher ce qu'il vérifie.
 */

export interface Fixture {
  db: TestExecutor;
  shopA: string;
  shopB: string;
  adminId: string;
  sellerId: string;
  /** iPhone 15, suivi par IMEI. */
  phone: string;
  /** Enceinte JBL, suivie par numéro de série. */
  speaker: string;
  /** Câble USB-C, suivi par quantité. */
  cable: string;
}

/** Empreinte fictive, au bon format : les tests ne dérivent pas de PBKDF2. */
const FAKE_HASH = 'pbkdf2-sha256$1$c2Vs$ZW1wcmVpbnRl';

export async function seedFixture(): Promise<Fixture> {
  const db = createTestDb();

  const shops = new ShopRepository(db);
  const shopA = await shops.create({ code: 'CENT', name: 'Boutique Centre', isLocal: true });
  const shopB = await shops.create({ code: 'NORD', name: 'Boutique Nord' });

  await new RoleRepository(db).ensurePresets();
  const roles = new RoleRepository(db);
  const admin = await roles.byCode('ADMIN');
  const seller = await roles.byCode('SELLER');
  if (!admin || !seller) throw new Error('rôles de référence absents');

  const users = new UserRepository(db);
  const adminId = await users.create(
    { shopId: shopA, fullName: 'Rakoto Admin', login: 'admin', roleId: admin.id },
    FAKE_HASH,
  );
  const sellerId = await users.create(
    { shopId: shopA, fullName: 'Naina Vendeuse', login: 'naina', roleId: seller.id },
    FAKE_HASH,
  );

  const products = new ProductRepository(db);
  const phone = await products.create({
    sku: 'IPH15-128-NOIR',
    name: 'iPhone 15 128 Go Noir',
    brand: 'Apple',
    model: 'iPhone 15',
    tracking: 'IMEI',
    purchasePrice: 2_400_000,
    salePrice: 2_950_000,
    attributes: { capacite: '128 Go', couleur: 'Noir' },
  });
  const speaker = await products.create({
    sku: 'JBL-BOOMBOX-3',
    name: 'JBL Boombox 3',
    brand: 'JBL',
    tracking: 'SERIAL',
    purchasePrice: 1_100_000,
    salePrice: 1_450_000,
  });
  const cable = await products.create({
    sku: 'CAB-USBC-1M',
    name: 'Câble USB-C 1 m',
    brand: 'Generic',
    tracking: 'QUANTITY',
    purchasePrice: 4_000,
    salePrice: 12_000,
    minStock: 10,
  });

  await ensurePaymentMethods(db);

  return { db, shopA, shopB, adminId, sellerId, phone, speaker, cable };
}

/** Modes de paiement : requis par les clés étrangères de `sale_payment`. */
export async function ensurePaymentMethods(db: SqlExecutor): Promise<void> {
  const methods = [
    ['CASH', 'Espèces', 1, 1],
    ['CARD', 'Carte bancaire', 1, 0],
    ['MOBILE_MONEY', 'Mobile money', 1, 0],
    ['TRANSFER', 'Virement', 1, 0],
    ['OTHER', 'Autre', 1, 0],
  ] as const;
  for (const [index, [code, label, active, change]] of methods.entries()) {
    await db.execute(
      `INSERT INTO payment_method (code, label, is_active, change_allowed, position)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT (code) DO NOTHING`,
      [code, label, active, change, index],
    );
  }
}

/** Suite d'IMEI valides et distincts, pour éviter d'en inventer dans chaque test. */
export function imeiSeries(count: number, prefix = '35692005'): string[] {
  return Array.from({ length: count }, (_, index) =>
    completeImei(`${prefix}${String(index + 100000).padStart(6, '0')}`),
  );
}

/** Crée un produit supplémentaire, quand un test a besoin du sien. */
export async function makeProduct(
  db: SqlExecutor,
  tracking: Tracking,
  overrides: { sku?: string; salePrice?: number; purchasePrice?: number } = {},
): Promise<string> {
  return new ProductRepository(db).create({
    sku: overrides.sku ?? `SKU-${newId().slice(0, 8)}`,
    name: `Produit ${tracking}`,
    tracking,
    purchasePrice: overrides.purchasePrice ?? 1000,
    salePrice: overrides.salePrice ?? 2000,
  });
}

export { nowIso };
