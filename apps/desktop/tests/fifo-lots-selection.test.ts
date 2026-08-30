import { beforeEach, describe, expect, it } from 'vitest';
import { fifoUnitCost, remainingLayers } from '@/core/services/cost.service';
import { StockService } from '@/core/services/stock.service';
import { SaleService } from '@/core/services/sale.service';
import { ProductService } from '@/core/services/catalog.service';
import { PurchaseService } from '@/core/services/purchase.service';
import { SaleRepository } from '@/core/db/repositories/sale.repository';
import { UnitRepository } from '@/core/db/repositories/unit.repository';
import { ProductRepository } from '@/core/db/repositories/product.repository';
import { PriceHistoryRepository } from '@/core/db/repositories/price-history.repository';
import { PurchaseRepository } from '@/core/db/repositories/purchase.repository';
import { SupplierRepository } from '@/core/db/repositories/supplier.repository';
import { contextFor } from './helpers/context';
import { imeiSeries, seedFixture, type Fixture } from './helpers/fixtures';
import type { AppContext } from '@/core/services/context';

/**
 * Valorisation des sorties, lots d'approvisionnement et actions groupées.
 */
describe('valorisation FIFO', () => {
  let fixture: Fixture;
  let context: AppContext;

  /** Trois arrivages du même câble, à trois coûts différents. */
  const troisCouches = async (ctx: AppContext) => {
    const stock = new StockService(ctx);
    await stock.receiveQuantity({
      productId: fixture.cable,
      quantity: 10,
      unitCost: 4_000,
      occurredAt: '2026-01-10T08:00:00.000Z',
    });
    await stock.receiveQuantity({
      productId: fixture.cable,
      quantity: 10,
      unitCost: 5_000,
      occurredAt: '2026-02-10T08:00:00.000Z',
    });
    await stock.receiveQuantity({
      productId: fixture.cable,
      quantity: 10,
      unitCost: 6_000,
      occurredAt: '2026-03-10T08:00:00.000Z',
    });
  };

  beforeEach(async () => {
    fixture = await seedFixture();
    context = await contextFor(fixture.db, fixture.adminId);
  });

  it('consomme la couche la plus ancienne en premier', async () => {
    await troisCouches(context);
    const cout = await fifoUnitCost(fixture.db, fixture.cable, fixture.shopA, 5, 9_999);
    expect(cout).toBe(4_000);
  });

  it('moyenne les couches quand la sortie les enjambe', async () => {
    await troisCouches(context);
    // 10 unités à 4 000 puis 5 à 5 000 → (40 000 + 25 000) / 15 = 4 333,33
    const cout = await fifoUnitCost(fixture.db, fixture.cable, fixture.shopA, 15, 9_999);
    expect(cout).toBe(Math.round((10 * 4_000 + 5 * 5_000) / 15));
  });

  it('saute les couches déjà consommées', async () => {
    await troisCouches(context);
    // On vend 12 : la première couche est épuisée, la deuxième entamée.
    await new SaleService(context).checkout({
      lines: [{ productId: fixture.cable, quantity: 12 }],
      payments: [{ method: 'CASH', amount: 200_000 }],
    });

    const cout = await fifoUnitCost(fixture.db, fixture.cable, fixture.shopA, 3, 9_999);
    expect(cout).toBe(5_000);
  });

  it('retombe sur le prix catalogue quand le stock est épuisé', async () => {
    const cout = await fifoUnitCost(fixture.db, fixture.cable, fixture.shopA, 5, 4_242);
    expect(cout).toBe(4_242);
  });

  it('montre les couches restantes, de la plus ancienne à la plus récente', async () => {
    await troisCouches(context);
    await new SaleService(context).checkout({
      lines: [{ productId: fixture.cable, quantity: 12 }],
      payments: [{ method: 'CASH', amount: 200_000 }],
    });

    const couches = await remainingLayers(fixture.db, fixture.cable, fixture.shopA);
    expect(couches.map((c) => ({ q: c.quantity, cout: c.unitCost }))).toEqual([
      { q: 8, cout: 5_000 },
      { q: 10, cout: 6_000 },
    ]);
  });

  describe('effet sur la marge', () => {
    it('emploie le prix catalogue par défaut', async () => {
      await troisCouches(context);
      const vente = await new SaleService(context).checkout({
        lines: [{ productId: fixture.cable, quantity: 5 }],
        payments: [{ method: 'CASH', amount: 60_000 }],
      });
      const lignes = await new SaleRepository(fixture.db).lines(vente.saleId);
      // Le catalogue dit 4 000 : c'est ce qui est figé.
      expect(lignes[0]?.unitCost).toBe(4_000);
    });

    it('emploie les couches quand le FIFO est choisi', async () => {
      const fifo = await contextFor(fixture.db, fixture.adminId, {
        settings: { costMethod: 'FIFO' },
      });
      await troisCouches(fifo);
      // On épuise la première couche, puis on vend sur la deuxième.
      await new SaleService(fifo).checkout({
        lines: [{ productId: fixture.cable, quantity: 10 }],
        payments: [{ method: 'CASH', amount: 200_000 }],
      });
      const vente = await new SaleService(fifo).checkout({
        lines: [{ productId: fixture.cable, quantity: 5 }],
        payments: [{ method: 'CASH', amount: 60_000 }],
      });

      const lignes = await new SaleRepository(fixture.db).lines(vente.saleId);
      // 5 000, et non 4 000 du catalogue : la première couche est épuisée.
      expect(lignes[0]?.unitCost).toBe(5_000);
    });

    it('ne touche PAS aux appareils identifiés, qui portent leur propre coût', async () => {
      const fifo = await contextFor(fixture.db, fixture.adminId, {
        settings: { costMethod: 'FIFO' },
      });
      const unitIds = await new StockService(fifo).receiveUnits({
        productId: fixture.phone,
        units: [
          { imei1: imeiSeries(2)[0], costPrice: 2_400_000 },
          { imei1: imeiSeries(2)[1], costPrice: 2_700_000 },
        ],
      });

      // On vend le SECOND, le plus cher : son coût propre doit être retenu,
      // pas celui du premier entré.
      const vente = await new SaleService(fifo).checkout({
        lines: [{ productId: fixture.phone, unitId: unitIds[1], quantity: 1 }],
        payments: [{ method: 'CASH', amount: 2_950_000 }],
      });
      const lignes = await new SaleRepository(fixture.db).lines(vente.saleId);
      expect(lignes[0]?.unitCost).toBe(2_700_000);
    });
  });

  it('propose les appareils du plus ancien au plus récent', async () => {
    const stock = new StockService(context);
    const anciens = await stock.receiveUnits({
      productId: fixture.phone,
      units: [{ imei1: imeiSeries(3)[0] }],
      occurredAt: '2026-01-01T08:00:00.000Z',
    });
    const recents = await stock.receiveUnits({
      productId: fixture.phone,
      units: [{ imei1: imeiSeries(3)[1] }],
      occurredAt: '2026-06-01T08:00:00.000Z',
    });

    const disponibles = await new UnitRepository(fixture.db).availableFor(
      fixture.phone,
      fixture.shopA,
    );
    expect(disponibles[0]?.id).toBe(anciens[0]);
    expect(disponibles[1]?.id).toBe(recents[0]);
  });
});

describe("lots d'approvisionnement", () => {
  let fixture: Fixture;
  let context: AppContext;

  beforeEach(async () => {
    fixture = await seedFixture();
    context = await contextFor(fixture.db, fixture.adminId);
  });

  it('relie chaque arrivage à son coût et à sa quantité', async () => {
    const produits = new ProductService(context);
    const base = {
      name: 'iPhone 14 Pro Max',
      brand: 'Apple',
      tracking: 'IMEI' as const,
      purchasePrice: 12_000,
      salePrice: 15_000,
    };
    const productId = await produits.create(base);
    const imei = imeiSeries(4);

    // Premier arrivage : acheté 12 000.
    await new StockService(context).receiveUnits({
      productId,
      units: imei.slice(0, 2).map((valeur) => ({ imei1: valeur, costPrice: 12_000 })),
      occurredAt: '2026-01-10T08:00:00.000Z',
    });

    // Le cours monte : nouveau prix d'achat, nouveau prix de vente.
    await produits.update(productId, { ...base, purchasePrice: 13_000, salePrice: 16_000 });
    await new StockService(context).receiveUnits({
      productId,
      units: imei.slice(2).map((valeur) => ({ imei1: valeur, costPrice: 13_000 })),
      occurredAt: '2026-02-10T08:00:00.000Z',
    });

    const lots = await new PriceHistoryRepository(fixture.db).lotsOf(productId, fixture.shopA);
    expect(lots).toHaveLength(2);

    const recent = lots[0]!;
    expect(recent.at).toBe('2026-02-10');
    expect(recent.unitCost).toBe(13_000);
    expect(recent.received).toBe(2);

    const ancien = lots[1]!;
    expect(ancien.at).toBe('2026-01-10');
    expect(ancien.unitCost).toBe(12_000);
    expect(ancien.received).toBe(2);
  });

  it('retient le prix de vente en vigueur à la date du lot', async () => {
    const productId = await new ProductService(context).create({
      name: 'iPhone 14 Pro Max',
      tracking: 'IMEI',
      purchasePrice: 12_000,
      salePrice: 15_000,
    });
    const historique = new PriceHistoryRepository(fixture.db);

    // Deux décisions de prix, datées.
    await historique.record({
      productId,
      kind: 'SALE',
      newValue: 15_000,
      source: 'MANUAL',
      at: '2026-01-05T08:00:00.000Z',
    });
    await historique.record({
      productId,
      kind: 'SALE',
      oldValue: 15_000,
      newValue: 16_000,
      source: 'MANUAL',
      at: '2026-02-05T08:00:00.000Z',
    });

    const imei = imeiSeries(4);
    await new StockService(context).receiveUnits({
      productId,
      units: imei.slice(0, 2).map((valeur) => ({ imei1: valeur, costPrice: 12_000 })),
      occurredAt: '2026-01-10T08:00:00.000Z',
    });
    await new StockService(context).receiveUnits({
      productId,
      units: imei.slice(2).map((valeur) => ({ imei1: valeur, costPrice: 13_000 })),
      occurredAt: '2026-02-10T08:00:00.000Z',
    });

    const lots = await historique.lotsOf(productId, fixture.shopA);
    const parDate = new Map(lots.map((lot) => [lot.at, lot]));

    // Chaque lot porte le prix pratiqué À SON MOMENT, pas celui d'aujourd'hui.
    expect(parDate.get('2026-01-10')?.salePriceThen).toBe(15_000);
    expect(parDate.get('2026-02-10')?.salePriceThen).toBe(16_000);
    // Et donc sa propre marge : 3 000 pour le premier lot, 3 000 pour le second.
    expect(parDate.get('2026-01-10')!.salePriceThen! - parDate.get('2026-01-10')!.unitCost).toBe(
      3_000,
    );
    expect(parDate.get('2026-02-10')!.salePriceThen! - parDate.get('2026-02-10')!.unitCost).toBe(
      3_000,
    );
  });

  it("retombe sur le premier prix connu pour un lot antérieur à l'historique", async () => {
    // Cas d'un stock déjà en rayon quand le logiciel a été installé.
    const productId = await new ProductService(context).create({
      name: 'Ancien stock',
      tracking: 'IMEI',
      purchasePrice: 10_000,
      salePrice: 14_000,
    });
    await new StockService(context).receiveUnits({
      productId,
      units: [{ imei1: imeiSeries(1)[0], costPrice: 10_000 }],
      occurredAt: '2020-01-01T08:00:00.000Z',
    });

    const lots = await new PriceHistoryRepository(fixture.db).lotsOf(productId, fixture.shopA);
    // Une case vide serait moins utile que la meilleure approximation connue.
    expect(lots[0]?.salePriceThen).toBe(14_000);
  });

  it('suit ce qui reste de chaque lot', async () => {
    const productId = await new ProductService(context).create({
      name: 'iPhone 14 Pro Max',
      tracking: 'IMEI',
      purchasePrice: 12_000,
      salePrice: 15_000,
    });
    const unitIds = await new StockService(context).receiveUnits({
      productId,
      units: imeiSeries(3).map((valeur) => ({ imei1: valeur, costPrice: 12_000 })),
      occurredAt: '2026-01-10T08:00:00.000Z',
    });
    await new SaleService(context).checkout({
      lines: [{ productId, unitId: unitIds[0], quantity: 1 }],
      payments: [{ method: 'CASH', amount: 15_000 }],
    });

    const lots = await new PriceHistoryRepository(fixture.db).lotsOf(productId, fixture.shopA);
    expect(lots[0]?.received).toBe(3);
    expect(lots[0]?.remaining).toBe(2);
  });

  it("rattache le lot à son fournisseur et à son document d'achat", async () => {
    const supplierId = await new SupplierRepository(fixture.db).create({
      code: 'SHZ',
      name: 'Shenzhen Trading',
    });
    const achats = new PurchaseService(context);
    const purchaseId = await achats.create({
      supplierId,
      lines: [{ productId: fixture.phone, label: 'iPhone', quantity: 2, unitPrice: 2_400_000 }],
    });
    await achats.markOrdered(purchaseId);
    const lignes = await new PurchaseRepository(fixture.db).lines(purchaseId);
    await achats.receive(purchaseId, [
      {
        purchaseLineId: lignes[0]!.id,
        quantity: 2,
        units: imeiSeries(2).map((valeur) => ({ imei1: valeur })),
      },
    ]);

    const lots = await new PriceHistoryRepository(fixture.db).lotsOf(fixture.phone, fixture.shopA);
    expect(lots[0]?.supplierName).toBe('Shenzhen Trading');
    expect(lots[0]?.sourceLabel).toMatch(/^A-CENT-/);
  });
});

describe('actions groupées', () => {
  let fixture: Fixture;
  let context: AppContext;

  beforeEach(async () => {
    fixture = await seedFixture();
    context = await contextFor(fixture.db, fixture.adminId);
  });

  it('supprime plusieurs produits, chacun selon son histoire', async () => {
    const service = new ProductService(context);
    const vierge = await service.create({
      name: 'Erreur de saisie',
      tracking: 'QUANTITY',
      purchasePrice: 1,
      salePrice: 2,
    });
    await new StockService(context).receiveQuantity({ productId: fixture.cable, quantity: 5 });

    const rapport = await service.removeMany([vierge, fixture.cable]);
    expect(rapport.deleted).toBe(1); // le vierge, effacé
    expect(rapport.archived).toBe(1); // le câble, archivé car il a du stock
    expect(rapport.failed).toEqual([]);

    const depot = new ProductRepository(fixture.db);
    expect(await depot.byId(vierge)).toBeNull();
    expect((await depot.byId(fixture.cable))?.status).toBe('ARCHIVED');
  });

  it("sort plusieurs appareils du stock d'un coup", async () => {
    const stock = new StockService(context);
    const unitIds = await stock.receiveUnits({
      productId: fixture.phone,
      units: imeiSeries(3).map((valeur) => ({ imei1: valeur })),
    });

    const rapport = await stock.writeOffMany(unitIds, 'LOST', "introuvables à l'inventaire");
    expect(rapport.done).toBe(3);
    expect(rapport.failed).toEqual([]);

    const depot = new UnitRepository(fixture.db);
    for (const id of unitIds) expect((await depot.byId(id))?.status).toBe('LOST');
  });

  it("n'interrompt pas le lot quand un appareil est déjà vendu", async () => {
    const stock = new StockService(context);
    const imei = imeiSeries(3);
    const unitIds = await stock.receiveUnits({
      productId: fixture.phone,
      units: imei.map((valeur) => ({ imei1: valeur })),
    });
    await new SaleService(context).checkout({
      lines: [{ productId: fixture.phone, unitId: unitIds[1], quantity: 1 }],
      payments: [{ method: 'CASH', amount: 2_950_000 }],
    });

    const rapport = await stock.writeOffMany(unitIds, 'LOST', 'perte');
    expect(rapport.done).toBe(2);
    expect(rapport.failed).toHaveLength(1);
    // Le refusé est nommé par son IMEI : sur dix, il faut savoir lequel.
    expect(rapport.failed[0]?.identifier).toBe(imei[1]);
  });

  it('efface les appareils jamais sortis, conserve les autres', async () => {
    const stock = new StockService(context);
    const imei = imeiSeries(3);
    const unitIds = await stock.receiveUnits({
      productId: fixture.phone,
      units: imei.map((valeur) => ({ imei1: valeur })),
    });
    await new SaleService(context).checkout({
      lines: [{ productId: fixture.phone, unitId: unitIds[2], quantity: 1 }],
      payments: [{ method: 'CASH', amount: 2_950_000 }],
    });

    const rapport = await stock.deleteUntouched(unitIds);
    expect(rapport.deleted).toBe(2);
    expect(rapport.kept).toHaveLength(1);

    const depot = new UnitRepository(fixture.db);
    expect(await depot.byId(unitIds[0]!)).toBeNull();
    expect(await depot.byId(unitIds[2]!)).not.toBeNull();
  });

  it("libère l'IMEI effacé, pour qu'il puisse être ressaisi", async () => {
    const stock = new StockService(context);
    const [valeur] = imeiSeries(1);
    const unitIds = await stock.receiveUnits({
      productId: fixture.phone,
      units: [{ imei1: valeur }],
    });

    await stock.deleteUntouched(unitIds);
    // C'est tout l'intérêt : un IMEI mal recopié doit redevenir disponible.
    const repris = await stock.receiveUnits({
      productId: fixture.phone,
      units: [{ imei1: valeur }],
    });
    expect(repris).toHaveLength(1);
  });
});
