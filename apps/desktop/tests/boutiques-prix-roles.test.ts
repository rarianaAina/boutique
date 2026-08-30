import { beforeEach, describe, expect, it } from 'vitest';
import {
  ALL_PAGE_PERMISSIONS,
  PAGE_GROUPS,
  PAGE_LABELS,
  PAGE_PERMISSIONS,
  PERMISSIONS,
  PermissionDeniedError,
  derivePagesFromActions,
  isPagePermission,
} from '@boutique/shared';
import { ShopService } from '@/core/services/shop.service';
import { ProductService } from '@/core/services/catalog.service';
import { PurchaseService } from '@/core/services/purchase.service';
import { PriceHistoryRepository } from '@/core/db/repositories/price-history.repository';
import { PurchaseRepository } from '@/core/db/repositories/purchase.repository';
import { SupplierRepository } from '@/core/db/repositories/supplier.repository';
import { RoleRepository } from '@/core/db/repositories/role.repository';
import { ShopRepository } from '@/core/db/repositories/shop.repository';
import { runStartupMaintenance } from '@/core/db/startup';
import { TOUS_LES_ECRANS } from '@/app/routes';
import { contextFor } from './helpers/context';
import { imeiSeries, seedFixture, type Fixture } from './helpers/fixtures';
import type { AppContext } from '@/core/services/context';

/** Gestion des boutiques, historique des prix et accès par page. */

describe('gestion des boutiques', () => {
  let fixture: Fixture;
  let context: AppContext;

  beforeEach(async () => {
    fixture = await seedFixture();
    context = await contextFor(fixture.db, fixture.adminId);
  });

  it('crée une boutique disponible comme destination de transfert', async () => {
    const service = new ShopService(context);
    const id = await service.create({ code: 'sud', name: 'Boutique Sud', phone: '0341112233' });

    const boutique = await new ShopRepository(fixture.db).byId(id);
    expect(boutique?.code).toBe('SUD');
    // Jamais locale à la création : ce serait changer l'identité du poste.
    expect(boutique?.isLocal).toBe(false);
    expect(boutique?.status).toBe('ACTIVE');
  });

  it('refuse un code déjà pris, en nommant la boutique qui le détient', async () => {
    await expect(
      new ShopService(context).create({ code: 'CENT', name: 'Doublon' }),
    ).rejects.toThrow(/Boutique Centre/);
  });

  it('refuse un code hors format : il entre dans les numéros de documents', async () => {
    await expect(
      new ShopService(context).create({ code: 'un code trop long', name: 'X' }),
    ).rejects.toThrow(/2 à 8/);
  });

  it('résume ce que chaque boutique détient', async () => {
    const resume = await new ShopService(context).list();
    const centre = resume.find((boutique) => boutique.id === fixture.shopA);
    expect(centre?.users).toBe(2);
    expect(centre?.isLocal).toBe(true);
  });

  it('refuse de fermer une boutique qui a des comptes actifs', async () => {
    await expect(new ShopService(context).close(fixture.shopA)).rejects.toThrow(/ce poste/i);

    const service = new ShopService(context);
    const id = await service.create({ code: 'SUD', name: 'Sud' });
    // Sans compte ni transfert, la fermeture passe.
    await service.close(id);
    expect((await new ShopRepository(fixture.db).byId(id))?.status).toBe('CLOSED');
  });

  it('refuse de changer la boutique du poste quand des ventes existent', async () => {
    const service = new ShopService(context);
    await fixture.db.execute(
      `INSERT INTO sale (id, shop_id, number, status, user_id, sold_at, total, paid,
                         created_at, updated_at)
       VALUES ('v1', ?, 'T-1', 'COMPLETED', ?, ?, 0, 0, ?, ?)`,
      [fixture.shopA, fixture.adminId, '2026-01-01', '2026-01-01', '2026-01-01'],
    );
    await expect(service.setLocal(fixture.shopB)).rejects.toThrow(/déjà enregistré des ventes/);
  });

  it('désigne une autre boutique sur une base sans vente', async () => {
    await new ShopService(context).setLocal(fixture.shopB);
    const locale = await new ShopRepository(fixture.db).local();
    expect(locale?.id).toBe(fixture.shopB);
  });

  it('refuse la gestion des boutiques sans la permission', async () => {
    const gerant = await contextFor(fixture.db, fixture.adminId, {
      permissions: [PERMISSIONS.settingsManage],
    });
    await expect(new ShopService(gerant).list()).rejects.toThrow(PermissionDeniedError);
  });
});

describe('historique des prix', () => {
  let fixture: Fixture;
  let context: AppContext;

  beforeEach(async () => {
    fixture = await seedFixture();
    context = await contextFor(fixture.db, fixture.adminId);
  });

  it('consigne un point de départ à la création du produit', async () => {
    const id = await new ProductService(context).create({
      name: 'Chargeur 20 W',
      tracking: 'QUANTITY',
      purchasePrice: 18_000,
      salePrice: 45_000,
    });

    const points = await new PriceHistoryRepository(fixture.db).forProduct(id);
    const natures = points.map((point) => point.kind).sort();
    expect(natures).toEqual(['PURCHASE', 'SALE']);
    expect(points.every((point) => point.oldValue === null)).toBe(true);
  });

  it("suit l'évolution d'un prix de vente", async () => {
    const service = new ProductService(context);
    const base = {
      name: 'Chargeur',
      tracking: 'QUANTITY' as const,
      purchasePrice: 18_000,
      salePrice: 45_000,
    };
    const id = await service.create(base);
    await service.update(id, { ...base, salePrice: 49_000 });
    await service.update(id, { ...base, salePrice: 52_000 });

    const ventes = await new PriceHistoryRepository(fixture.db).forProduct(id, 'SALE');
    expect(ventes.map((point) => point.newValue)).toEqual([52_000, 49_000, 45_000]);
    expect(ventes[0]?.oldValue).toBe(49_000);
  });

  it("n'écrit rien quand le prix ne change pas", async () => {
    const service = new ProductService(context);
    const base = {
      name: 'Chargeur',
      tracking: 'QUANTITY' as const,
      purchasePrice: 18_000,
      salePrice: 45_000,
    };
    const id = await service.create(base);
    await service.update(id, { ...base, name: 'Chargeur rapide' });

    const points = await new PriceHistoryRepository(fixture.db).forProduct(id);
    expect(points).toHaveLength(2); // les deux points de création, rien de plus
  });

  it('consigne le coût RÉELLEMENT payé à la réception, frais compris', async () => {
    const supplierId = await new SupplierRepository(fixture.db).create({
      code: 'SHZ',
      name: 'Shenzhen Trading',
    });
    const achats = new PurchaseService(context);
    const purchaseId = await achats.create({
      supplierId,
      lines: [{ productId: fixture.phone, label: 'iPhone', quantity: 2, unitPrice: 2_400_000 }],
    });
    await achats.addLandedCost(purchaseId, { kind: 'CUSTOMS', amount: 120_000 });
    await achats.markOrdered(purchaseId);

    const lignes = await new PurchaseRepository(fixture.db).lines(purchaseId);
    await achats.receive(purchaseId, [
      {
        purchaseLineId: lignes[0]!.id,
        quantity: 2,
        units: imeiSeries(2).map((valeur) => ({ imei1: valeur })),
      },
    ]);

    const constates = await new PriceHistoryRepository(fixture.db).forProduct(
      fixture.phone,
      'OBSERVED_PURCHASE',
    );
    expect(constates).toHaveLength(1);
    // (2 × 2 400 000 + 120 000) / 2 = 2 460 000
    expect(constates[0]?.newValue).toBe(2_460_000);
    expect(constates[0]?.supplierId).toBe(supplierId);
    expect(constates[0]?.note).toMatch(/[Ff]rais logistiques/);
  });

  it("signale l'écart entre le prix catalogue et le coût réel", async () => {
    const supplierId = await new SupplierRepository(fixture.db).create({
      code: 'DXB',
      name: 'Dubai Wholesale',
    });
    const achats = new PurchaseService(context);
    // Le catalogue dit 2 400 000, le fournisseur facture 2 700 000.
    const purchaseId = await achats.create({
      supplierId,
      lines: [{ productId: fixture.phone, label: 'iPhone', quantity: 1, unitPrice: 2_700_000 }],
    });
    await achats.markOrdered(purchaseId);
    const lignes = await new PurchaseRepository(fixture.db).lines(purchaseId);
    await achats.receive(purchaseId, [
      { purchaseLineId: lignes[0]!.id, quantity: 1, units: [{ imei1: imeiSeries(1)[0] }] },
    ]);

    const ecarts = await new PriceHistoryRepository(fixture.db).divergences(5);
    const cible = ecarts.find((ligne) => ligne.productId === fixture.phone);
    expect(cible?.cataloguePrice).toBe(2_400_000);
    expect(cible?.observedPrice).toBe(2_700_000);
    expect(cible?.variationPercent).toBe(12.5);
    expect(cible?.supplierName).toBe('Dubai Wholesale');
  });

  it('donne le dernier coût constaté par fournisseur', async () => {
    const suppliers = new SupplierRepository(fixture.db);
    const a = await suppliers.create({ code: 'A', name: 'Fournisseur A' });
    const b = await suppliers.create({ code: 'B', name: 'Fournisseur B' });
    const historique = new PriceHistoryRepository(fixture.db);

    await historique.record({
      productId: fixture.phone,
      kind: 'OBSERVED_PURCHASE',
      newValue: 2_300_000,
      source: 'PURCHASE',
      supplierId: a,
      at: '2026-01-10T10:00:00.000Z',
    });
    await historique.record({
      productId: fixture.phone,
      kind: 'OBSERVED_PURCHASE',
      newValue: 2_500_000,
      source: 'PURCHASE',
      supplierId: a,
      at: '2026-03-10T10:00:00.000Z',
    });
    await historique.record({
      productId: fixture.phone,
      kind: 'OBSERVED_PURCHASE',
      newValue: 2_450_000,
      source: 'PURCHASE',
      supplierId: b,
      at: '2026-02-10T10:00:00.000Z',
    });

    const derniers = await historique.lastObservedBySupplier(fixture.phone);
    const parFournisseur = new Map(derniers.map((ligne) => [ligne.supplierName, ligne.value]));
    expect(parFournisseur.get('Fournisseur A')).toBe(2_500_000);
    expect(parFournisseur.get('Fournisseur B')).toBe(2_450_000);
  });
});

describe('accès par page', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it('chaque écran du menu déclare sa permission de page', () => {
    for (const ecran of TOUS_LES_ECRANS) {
      expect(isPagePermission(ecran.permission), ecran.cle).toBe(true);
    }
  });

  it('toute permission de page correspond à un écran', () => {
    const declarees = new Set(TOUS_LES_ECRANS.map((ecran) => ecran.permission));
    for (const page of ALL_PAGE_PERMISSIONS) {
      expect(declarees.has(page), page).toBe(true);
    }
  });

  it("un rôle peut ouvrir une page sans avoir le droit d'y agir", async () => {
    const roles = new RoleRepository(fixture.db);
    const comptable = await roles.byCode('ACCOUNTANT');
    expect(comptable?.permissions).toContain(PAGE_PERMISSIONS.achats);
    expect(comptable?.permissions).not.toContain(PERMISSIONS.purchaseReceive);
  });

  it('rattrape les rôles créés avant les permissions de page', async () => {
    const roles = new RoleRepository(fixture.db);
    const vendeur = await roles.byCode('SELLER');
    // On simule une base antérieure : plus aucune permission de page.
    await roles.update(vendeur!.id, {
      permissions: vendeur!.permissions.filter((permission) => !isPagePermission(permission)),
    });

    const rapport = await runStartupMaintenance(fixture.db);
    expect(rapport.rolesUpgraded).toBeGreaterThan(0);

    const apres = await roles.byCode('SELLER');
    // Les pages sont DÉDUITES des droits d'action conservés.
    expect(apres?.permissions).toContain(PAGE_PERMISSIONS.caisse);
    expect(apres?.permissions).toContain(PAGE_PERMISSIONS.tableau);
    // Et rien n'est accordé au-delà de ce qu'il pouvait déjà faire.
    expect(apres?.permissions).not.toContain(PAGE_PERMISSIONS.utilisateurs);
  });

  it('ne rattrape pas deux fois', async () => {
    await runStartupMaintenance(fixture.db);
    const second = await runStartupMaintenance(fixture.db);
    expect(second.rolesUpgraded).toBe(0);
  });

  it('déduit les pages des seules actions accordées', () => {
    const pages = derivePagesFromActions([PERMISSIONS.saleCreate, PERMISSIONS.customerView]);
    expect(pages).toContain(PAGE_PERMISSIONS.caisse);
    expect(pages).toContain(PAGE_PERMISSIONS.clients);
    expect(pages).not.toContain(PAGE_PERMISSIONS.parametres);
    // Le tableau de bord est toujours ouvert : sans lui, la session s'ouvrirait
    // sur un écran vide.
    expect(pages).toContain(PAGE_PERMISSIONS.tableau);
  });
});

/**
 * Découvrabilité de la gestion des accès.
 *
 * Une fonctionnalité qu'on ne trouve pas n'existe pas. Ces vérifications
 * portent sur ce qui la rend atteignable, pas sur son fonctionnement.
 */
describe('accès à la gestion des rôles', () => {
  it('le menu annonce les rôles, pas seulement les utilisateurs', () => {
    const entree = TOUS_LES_ECRANS.find((ecran) => ecran.cle === 'utilisateurs');
    expect(entree?.titre).toMatch(/rôles/i);
  });

  it('chaque page du logiciel est réglable, sans exception', () => {
    // Si un écran existait sans page correspondante, son accès serait
    // impossible à régler — et il resterait ouvert à tous, en silence.
    const reglables = new Set(PAGE_GROUPS.flatMap((groupe) => groupe.pages));
    for (const ecran of TOUS_LES_ECRANS) {
      expect(reglables.has(ecran.permission), ecran.cle).toBe(true);
    }
  });

  it('chaque page réglable porte un libellé lisible', () => {
    for (const page of ALL_PAGE_PERMISSIONS) {
      expect(PAGE_LABELS[page], page).toBeTruthy();
      // Pas de code technique dans une case à cocher que lit un gérant.
      expect(PAGE_LABELS[page].startsWith('page.'), page).toBe(false);
    }
  });
});
