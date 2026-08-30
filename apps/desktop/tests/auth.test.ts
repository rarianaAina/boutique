import { describe, expect, it } from 'vitest';
import { PERMISSIONS, PermissionDeniedError, ROLE_PRESETS } from '@boutique/shared';
import { AuthService, UserService } from '@/core/services/auth.service';
import { SetupService } from '@/core/services/setup.service';
import { UserRepository } from '@/core/db/repositories/user.repository';
import { RoleRepository } from '@/core/db/repositories/role.repository';
import { AuditRepository } from '@/core/db/repositories/audit.repository';
import { ProductService } from '@/core/services/catalog.service';
import { hashPassword, needsRehash, verifyPassword } from '@/core/auth/password';
import { createTestDb } from './helpers/sqlite-executor';
import { contextFor } from './helpers/context';
import { seedFixture } from './helpers/fixtures';

/**
 * Authentification et permissions — priorité n°9 des tests demandés (§30).
 */
describe('empreintes de mots de passe', () => {
  it('vérifie un mot de passe correct et rejette le reste', async () => {
    const empreinte = await hashPassword('boutique2026');
    expect(await verifyPassword('boutique2026', empreinte)).toBe(true);
    expect(await verifyPassword('boutique2027', empreinte)).toBe(false);
  });

  it('produit une empreinte différente à chaque fois (sel aléatoire)', async () => {
    const [a, b] = await Promise.all([hashPassword('identique'), hashPassword('identique')]);
    expect(a).not.toBe(b);
  });

  it('ne stocke jamais le mot de passe en clair', async () => {
    const empreinte = await hashPassword('motdepassesecret');
    expect(empreinte).not.toContain('motdepassesecret');
    expect(empreinte.startsWith('pbkdf2-sha256$')).toBe(true);
  });

  it('rejette une empreinte mal formée sans lever', async () => {
    expect(await verifyPassword('x', 'nimportequoi')).toBe(false);
    expect(await verifyPassword('x', 'pbkdf2-sha256$0$a$b')).toBe(false);
  });

  it('repère une empreinte au coût dépassé', () => {
    expect(needsRehash('pbkdf2-sha256$1000$sel$empreinte')).toBe(true);
  });
});

describe('installation et connexion', () => {
  it('installe la boutique et ouvre une session', async () => {
    const db = createTestDb();
    const setup = new SetupService(db);
    expect(await setup.needsSetup()).toBe(true);

    await setup.run({
      shopCode: 'cent',
      shopName: 'Boutique Centre',
      adminFullName: 'Hery Rakoto',
      adminLogin: 'hery',
      adminPassword: 'boutique2026',
    });

    expect(await setup.needsSetup()).toBe(false);
    const { session } = await new AuthService(db).login('hery', 'boutique2026');
    expect(session.shopCode).toBe('CENT');
    expect(session.permissions).toHaveLength(
      ROLE_PRESETS.find((role) => role.code === 'ADMIN')?.permissions.length ?? 0,
    );
    db.close();
  });

  it('refuse un code boutique invalide', async () => {
    const db = createTestDb();
    await expect(
      new SetupService(db).run({
        shopCode: 'un code beaucoup trop long',
        shopName: 'X',
        adminFullName: 'X',
        adminLogin: 'x',
        adminPassword: 'boutique2026',
      }),
    ).rejects.toThrow(/code boutique/i);
    db.close();
  });

  it('refuse un mot de passe trop court', async () => {
    const db = createTestDb();
    await expect(
      new SetupService(db).run({
        shopCode: 'CENT',
        shopName: 'X',
        adminFullName: 'X',
        adminLogin: 'x',
        adminPassword: 'court',
      }),
    ).rejects.toThrow(/8 caractères/);
    db.close();
  });

  it("refuse de s'installer deux fois", async () => {
    const db = createTestDb();
    const setup = new SetupService(db);
    const entree = {
      shopCode: 'CENT',
      shopName: 'Centre',
      adminFullName: 'A',
      adminLogin: 'a',
      adminPassword: 'boutique2026',
    };
    await setup.run(entree);
    await expect(setup.run(entree)).rejects.toThrow(/déjà installée/i);
    db.close();
  });
});

describe('verrouillage après échecs', () => {
  it('donne le même message pour un login inconnu et un mot de passe faux', async () => {
    const db = createTestDb();
    await new SetupService(db).run({
      shopCode: 'CENT',
      shopName: 'Centre',
      adminFullName: 'A',
      adminLogin: 'admin',
      adminPassword: 'boutique2026',
    });
    const service = new AuthService(db);

    const inconnu = await service.login('inexistant', 'x').catch((cause: Error) => cause.message);
    const faux = await service.login('admin', 'faux').catch((cause: Error) => cause.message);
    expect(inconnu).toBe(faux);
    db.close();
  });

  it('verrouille temporairement après cinq échecs', async () => {
    const db = createTestDb();
    await new SetupService(db).run({
      shopCode: 'CENT',
      shopName: 'Centre',
      adminFullName: 'A',
      adminLogin: 'admin',
      adminPassword: 'boutique2026',
    });
    const service = new AuthService(db);

    for (let essai = 0; essai < 5; essai += 1) {
      await service.login('admin', 'faux').catch(() => undefined);
    }
    // Même avec le BON mot de passe, le compte est bloqué.
    await expect(service.login('admin', 'boutique2026')).rejects.toThrow(/verrouillé/i);

    // Chaque échec est tracé.
    const journal = await new AuditRepository(db).list({ action: 'LOGIN_FAILED' });
    expect(journal.total).toBe(5);
    db.close();
  });

  it('remet le compteur à zéro après une connexion réussie', async () => {
    const db = createTestDb();
    await new SetupService(db).run({
      shopCode: 'CENT',
      shopName: 'Centre',
      adminFullName: 'A',
      adminLogin: 'admin',
      adminPassword: 'boutique2026',
    });
    const service = new AuthService(db);
    await service.login('admin', 'faux').catch(() => undefined);
    await service.login('admin', 'boutique2026');

    const utilisateur = await new UserRepository(db).byLogin('admin');
    expect(utilisateur?.failedAttempts).toBe(0);
    expect(utilisateur?.lastLoginAt).toBeTruthy();
    db.close();
  });

  it('refuse un compte suspendu', async () => {
    const db = createTestDb();
    await new SetupService(db).run({
      shopCode: 'CENT',
      shopName: 'Centre',
      adminFullName: 'A',
      adminLogin: 'admin',
      adminPassword: 'boutique2026',
    });
    const utilisateurs = new UserRepository(db);
    const compte = await utilisateurs.byLogin('admin');
    await utilisateurs.update(compte!.id, { status: 'SUSPENDED' });

    await expect(new AuthService(db).login('admin', 'boutique2026')).rejects.toThrow(/plus actif/i);
    db.close();
  });
});

describe('permissions', () => {
  it('refuse une opération à un rôle qui ne la porte pas', async () => {
    const fixture = await seedFixture();
    const vendeur = await contextFor(fixture.db, fixture.sellerId, {
      permissions: [PERMISSIONS.saleCreate, PERMISSIONS.productView],
    });

    await expect(
      new ProductService(vendeur).create({
        sku: 'TEST',
        name: 'Test',
        tracking: 'QUANTITY',
        purchasePrice: 1,
        salePrice: 2,
      }),
    ).rejects.toThrow(PermissionDeniedError);
    fixture.db.close();
  });

  it("empêche un gérant de créer un compte sans la permission d'administration", async () => {
    const fixture = await seedFixture();
    const roles = new RoleRepository(fixture.db);
    const gerant = await roles.byCode('MANAGER');
    const context = await contextFor(fixture.db, fixture.adminId, {
      permissions: gerant?.permissions ?? [],
    });

    await expect(
      new UserService(context).create(
        {
          shopId: fixture.shopA,
          fullName: 'Nouveau',
          login: 'nouveau',
          roleId: gerant!.id,
        },
        'boutique2026',
      ),
    ).rejects.toThrow(PermissionDeniedError);
    fixture.db.close();
  });

  it('refuse un identifiant déjà utilisé', async () => {
    const fixture = await seedFixture();
    const context = await contextFor(fixture.db, fixture.adminId);
    const role = await new RoleRepository(fixture.db).byCode('SELLER');

    await expect(
      new UserService(context).create(
        { shopId: fixture.shopA, fullName: 'Doublon', login: 'admin', roleId: role!.id },
        'boutique2026',
      ),
    ).rejects.toThrow(/déjà utilisé/i);
    fixture.db.close();
  });

  it('interdit de désactiver son propre compte', async () => {
    const fixture = await seedFixture();
    const context = await contextFor(fixture.db, fixture.adminId);
    await expect(new UserService(context).setStatus(fixture.adminId, 'SUSPENDED')).rejects.toThrow(
      /votre propre compte/i,
    );
    fixture.db.close();
  });

  it('crée les rôles livrés sans écraser un réglage local', async () => {
    const fixture = await seedFixture();
    const roles = new RoleRepository(fixture.db);
    const vendeur = await roles.byCode('SELLER');
    await roles.update(vendeur!.id, { permissions: [PERMISSIONS.productView] });

    // Un second passage — comme au démarrage suivant — ne doit rien redéfaire.
    await roles.ensurePresets();
    const apres = await roles.byCode('SELLER');
    expect(apres?.permissions).toEqual([PERMISSIONS.productView]);
    fixture.db.close();
  });
});
