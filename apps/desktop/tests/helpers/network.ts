import { newId, nowIso } from '@boutique/shared';
import { SyncStore } from '@boutique/sync-server';
import { RoleRepository } from '@/core/db/repositories/role.repository';
import { UserRepository } from '@/core/db/repositories/user.repository';
import { ShopRepository } from '@/core/db/repositories/shop.repository';
import { createTestDb, type TestExecutor } from './sqlite-executor';
import { ensurePaymentMethods } from './fixtures';
import { contextFor } from './context';
import type { SyncTransport } from '@/core/sync/transport';
import type { AppContext } from '@/core/services/context';
import type {
  ClaimRequest,
  ClaimResponse,
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
} from '@boutique/shared';

/**
 * Réseau de deux boutiques, chacune avec sa PROPRE base.
 *
 * C'est la seule façon de tester honnêtement la synchronisation : un test où
 * les deux boutiques partagent une base vérifierait des règles de permission,
 * pas la circulation des données. Ici, ce qui n'a pas été synchronisé n'existe
 * réellement pas chez le voisin.
 */

/** Identifiants FIXES : les deux bases doivent nommer les boutiques pareil. */
export const SHOP_A = '11111111-1111-4111-8111-111111111111';
export const SHOP_B = '22222222-2222-4222-8222-222222222222';

const FAKE_HASH = 'pbkdf2-sha256$1$c2Vs$ZW1wcmVpbnRl';

export interface ShopNode {
  db: TestExecutor;
  shopId: string;
  userId: string;
  context: AppContext;
  transport: SyncTransport;
  deviceId: string;
}

export interface Network {
  store: SyncStore;
  a: ShopNode;
  b: ShopNode;
  close(): void;
}

/**
 * Transport en mémoire, branché directement sur le serveur.
 *
 * Il court-circuite HTTP mais PAS la logique : idempotence, ordre et arbitrage
 * des identifiants sont ceux du vrai serveur.
 */
class DirectTransport implements SyncTransport {
  constructor(private readonly store: SyncStore) {}

  async push(request: PushRequest): Promise<PushResponse> {
    return this.store.push(request);
  }

  async pull(request: PullRequest): Promise<PullResponse> {
    return this.store.pull(request);
  }

  async claim(request: ClaimRequest): Promise<ClaimResponse> {
    return this.store.claim(request);
  }
}

async function createNode(
  store: SyncStore,
  shopId: string,
  code: string,
  name: string,
  peers: { id: string; code: string; name: string }[],
): Promise<ShopNode> {
  const db = createTestDb();
  const shops = new ShopRepository(db);

  await shops.create({ code, name, isLocal: true }, shopId);
  for (const peer of peers) {
    await shops.create({ code: peer.code, name: peer.name }, peer.id);
  }

  await new RoleRepository(db).ensurePresets();
  const admin = await new RoleRepository(db).byCode('ADMIN');
  if (!admin) throw new Error('rôle administrateur absent');

  const userId = await new UserRepository(db).create(
    {
      shopId,
      fullName: `Responsable ${code}`,
      login: `resp-${code.toLowerCase()}`,
      roleId: admin.id,
    },
    FAKE_HASH,
  );
  await ensurePaymentMethods(db);

  const context = await contextFor(db, userId);
  return { db, shopId, userId, context, transport: new DirectTransport(store), deviceId: newId() };
}

export async function createNetwork(): Promise<Network> {
  const store = new SyncStore(':memory:');
  store.registerShop({ id: SHOP_A, code: 'CENT', name: 'Boutique Centre', token: 'jeton-a' });
  store.registerShop({ id: SHOP_B, code: 'NORD', name: 'Boutique Nord', token: 'jeton-b' });

  const a = await createNode(store, SHOP_A, 'CENT', 'Boutique Centre', [
    { id: SHOP_B, code: 'NORD', name: 'Boutique Nord' },
  ]);
  const b = await createNode(store, SHOP_B, 'NORD', 'Boutique Nord', [
    { id: SHOP_A, code: 'CENT', name: 'Boutique Centre' },
  ]);

  return {
    store,
    a,
    b,
    close() {
      a.db.close();
      b.db.close();
      store.close();
    },
  };
}

export { nowIso };
