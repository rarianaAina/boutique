import { PERMISSIONS, PermissionDeniedError, completeImei } from '@boutique/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { StockService } from '@/core/services/stock.service';
import { UnitRepository } from '@/core/db/repositories/unit.repository';
import { StockRepository } from '@/core/db/repositories/stock.repository';
import { ProductRepository } from '@/core/db/repositories/product.repository';
import { contextFor } from './helpers/context';
import { imeiSeries, seedFixture, type Fixture } from './helpers/fixtures';

/**
 * Gestion des IMEI et du stock — priorité n°1 des tests demandés (§30).
 *
 * Ces tests s'exécutent sur une VRAIE base SQLite, avec le schéma de production
 * : ils vérifient donc aussi les contraintes d'unicité, qui sont l'essentiel de
 * la protection contre les doublons.
 */
describe('entrée en stock par IMEI', () => {
  let fixture: Fixture;
  let imei: string[];

  beforeEach(async () => {
    fixture = await seedFixture();
    imei = imeiSeries(5);
  });

  it('crée une unité, ses identifiants et son mouvement', async () => {
    const context = await contextFor(fixture.db, fixture.adminId);
    const [unitId] = await new StockService(context).receiveUnits({
      productId: fixture.phone,
      units: [{ imei1: imei[0], imei2: imei[1], costPrice: 2_400_000 }],
    });

    expect(unitId).toBeDefined();
    const unit = await new UnitRepository(fixture.db).byId(unitId!);
    expect(unit?.status).toBe('IN_STOCK');
    expect(unit?.imei1).toBe(imei[0]);
    expect(unit?.imei2).toBe(imei[1]);
    expect(unit?.costPrice).toBe(2_400_000);

    const movements = await new StockRepository(fixture.db).unitHistory(unitId!);
    expect(movements).toHaveLength(1);
    expect(movements[0]?.type).toBe('PURCHASE_RECEIPT');
    expect(movements[0]?.quantity).toBe(1);
  });

  it('dépose un événement de synchronisation dans la même transaction', async () => {
    const context = await contextFor(fixture.db, fixture.adminId);
    await new StockService(context).receiveUnits({
      productId: fixture.phone,
      units: [{ imei1: imei[0] }],
    });

    const events = await fixture.db.select<{ type: string; status: string }>(
      'SELECT type, status FROM sync_outbox',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('STOCK_RECEIVED');
    expect(events[0]?.status).toBe('PENDING');
  });

  it('refuse un IMEI dont la clé de contrôle est fausse', async () => {
    const context = await contextFor(fixture.db, fixture.adminId);
    await expect(
      new StockService(context).receiveUnits({
        productId: fixture.phone,
        units: [{ imei1: '490154203237511' }],
      }),
    ).rejects.toThrow(/clé de contrôle/i);
  });

  it('refuse deux fois le même IMEI, même dans deux lots différents', async () => {
    const context = await contextFor(fixture.db, fixture.adminId);
    const service = new StockService(context);
    await service.receiveUnits({ productId: fixture.phone, units: [{ imei1: imei[0] }] });

    await expect(
      service.receiveUnits({ productId: fixture.phone, units: [{ imei1: imei[0] }] }),
    ).rejects.toThrow(/déjà enregistré/i);
  });

  it("refuse un doublon À L'INTÉRIEUR du même lot", async () => {
    const context = await contextFor(fixture.db, fixture.adminId);
    await expect(
      new StockService(context).receiveUnits({
        productId: fixture.phone,
        units: [{ imei1: imei[0] }, { imei1: imei[1] }, { imei1: imei[0] }],
      }),
    ).rejects.toThrow(/apparaît déjà à la ligne 1/);
  });

  it("interdit qu'un IMEI 1 soit l'IMEI 2 d'un autre appareil", async () => {
    const context = await contextFor(fixture.db, fixture.adminId);
    const service = new StockService(context);
    await service.receiveUnits({
      productId: fixture.phone,
      units: [{ imei1: imei[0], imei2: imei[1] }],
    });

    await expect(
      service.receiveUnits({ productId: fixture.phone, units: [{ imei1: imei[1] }] }),
    ).rejects.toThrow(/déjà enregistré/i);
  });

  it('refuse deux IMEI identiques sur le même appareil bi-SIM', async () => {
    const context = await contextFor(fixture.db, fixture.adminId);
    await expect(
      new StockService(context).receiveUnits({
        productId: fixture.phone,
        units: [{ imei1: imei[0], imei2: imei[0] }],
      }),
    ).rejects.toThrow(/doivent être différents/i);
  });

  it("n'écrit RIEN quand une ligne du lot est fautive", async () => {
    const context = await contextFor(fixture.db, fixture.adminId);
    const service = new StockService(context);
    await service.receiveUnits({ productId: fixture.phone, units: [{ imei1: imei[0] }] });

    await expect(
      service.receiveUnits({
        productId: fixture.phone,
        units: [{ imei1: imei[2] }, { imei1: imei[3] }, { imei1: imei[0] }],
      }),
    ).rejects.toThrow();

    // Les deux IMEI valides du lot refusé ne doivent pas être entrés en stock.
    const units = new UnitRepository(fixture.db);
    expect(await units.byIdentifier(imei[2]!)).toBeNull();
    expect(await units.byIdentifier(imei[3]!)).toBeNull();
  });

  it('retrouve un appareil par un IMEI collé avec des séparateurs', async () => {
    const context = await contextFor(fixture.db, fixture.adminId);
    await new StockService(context).receiveUnits({
      productId: fixture.phone,
      units: [{ imei1: imei[0] }],
    });

    const raw = imei[0]!;
    const spaced = `${raw.slice(0, 2)}-${raw.slice(2, 8)} ${raw.slice(8)}`;
    const found = await new UnitRepository(fixture.db).byIdentifier(spaced);
    expect(found?.imei1).toBe(raw);
  });

  it('refuse un IMEI sur un produit suivi par quantité', async () => {
    const context = await contextFor(fixture.db, fixture.adminId);
    await expect(
      new StockService(context).receiveUnits({
        productId: fixture.cable,
        units: [{ imei1: imei[0] }],
      }),
    ).rejects.toThrow(/suivi par quantité/i);
  });

  it('exige un numéro de série pour un produit sérialisé', async () => {
    const context = await contextFor(fixture.db, fixture.adminId);
    await expect(
      new StockService(context).receiveUnits({ productId: fixture.speaker, units: [{}] }),
    ).rejects.toThrow(/numéro de série est obligatoire/i);
  });

  it('refuse une entrée en stock sans la permission', async () => {
    const context = await contextFor(fixture.db, fixture.sellerId, {
      permissions: [PERMISSIONS.productView],
    });
    await expect(
      new StockService(context).receiveUnits({
        productId: fixture.phone,
        units: [{ imei1: imei[0] }],
      }),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it('accepte un IMEISV de 16 chiffres en le tronquant', async () => {
    const context = await contextFor(fixture.db, fixture.adminId);
    const base = completeImei('35692005100000');
    const [unitId] = await new StockService(context).receiveUnits({
      productId: fixture.phone,
      units: [{ imei1: `${base}7` }],
    });
    const unit = await new UnitRepository(fixture.db).byId(unitId!);
    expect(unit?.imei1).toBe(base);
  });
});

describe('stock par quantité', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it('additionne les réceptions et tient le niveau à jour', async () => {
    const context = await contextFor(fixture.db, fixture.adminId);
    const service = new StockService(context);
    await service.receiveQuantity({ productId: fixture.cable, quantity: 40 });
    await service.receiveQuantity({ productId: fixture.cable, quantity: 10 });

    const level = await new StockRepository(fixture.db).levelOf(fixture.cable, fixture.shopA);
    expect(level.quantity).toBe(50);
  });

  it('refuse une correction qui rendrait le stock négatif', async () => {
    const context = await contextFor(fixture.db, fixture.adminId);
    const service = new StockService(context);
    await service.receiveQuantity({ productId: fixture.cable, quantity: 5 });

    await expect(
      service.adjust({ productId: fixture.cable, quantity: -9, note: 'casse' }),
    ).rejects.toThrow(/stock insuffisant/i);
  });

  it('autorise le stock négatif quand le paramètre le permet', async () => {
    const context = await contextFor(fixture.db, fixture.adminId, {
      settings: { allowNegativeStock: true },
    });
    await new StockService(context).adjust({
      productId: fixture.cable,
      quantity: -3,
      note: 'régularisation fournisseur',
    });
    const level = await new StockRepository(fixture.db).levelOf(fixture.cable, fixture.shopA);
    expect(level.quantity).toBe(-3);
  });

  it('exige un motif pour toute correction', async () => {
    const context = await contextFor(fixture.db, fixture.adminId);
    await expect(
      new StockService(context).adjust({ productId: fixture.cable, quantity: 3, note: '  ' }),
    ).rejects.toThrow(/motif/i);
  });

  it('recalcule les niveaux à partir des mouvements', async () => {
    const context = await contextFor(fixture.db, fixture.adminId);
    await new StockService(context).receiveQuantity({ productId: fixture.cable, quantity: 12 });

    // On simule une divergence : le niveau est faussé, les mouvements font foi.
    await fixture.db.execute('UPDATE stock_level SET quantity = 999 WHERE product_id = ?', [
      fixture.cable,
    ]);
    await new StockRepository(fixture.db).rebuildLevels(fixture.shopA);

    const level = await new StockRepository(fixture.db).levelOf(fixture.cable, fixture.shopA);
    expect(level.quantity).toBe(12);
  });

  it('compte le stock disponible dans la liste des produits', async () => {
    const context = await contextFor(fixture.db, fixture.adminId);
    const service = new StockService(context);
    await service.receiveQuantity({ productId: fixture.cable, quantity: 7 });
    await service.receiveUnits({
      productId: fixture.phone,
      units: imeiSeries(3).map((value) => ({ imei1: value })),
    });

    const page = await new ProductRepository(fixture.db).search({ shopId: fixture.shopA });
    const byId = new Map(page.items.map((item) => [item.id, item]));
    expect(byId.get(fixture.cable)?.available).toBe(7);
    expect(byId.get(fixture.phone)?.available).toBe(3);
    expect(byId.get(fixture.speaker)?.available).toBe(0);
  });
});

describe('sortie hors vente', () => {
  it('sort un appareil perdu du stock disponible sans effacer son histoire', async () => {
    const fixture = await seedFixture();
    const context = await contextFor(fixture.db, fixture.adminId);
    const service = new StockService(context);
    const [unitId] = await service.receiveUnits({
      productId: fixture.phone,
      units: [{ imei1: imeiSeries(1)[0] }],
    });

    await service.writeOffUnit(unitId!, 'LOST', "introuvable à l'inventaire du 12/03");

    const unit = await new UnitRepository(fixture.db).byId(unitId!);
    expect(unit?.status).toBe('LOST');
    const history = await new StockRepository(fixture.db).unitHistory(unitId!);
    expect(history.map((movement) => movement.type)).toEqual(['PURCHASE_RECEIPT', 'LOSS']);
  });
});
