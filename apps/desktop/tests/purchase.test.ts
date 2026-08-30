import { beforeEach, describe, expect, it } from 'vitest';
import { PurchaseService } from '@/core/services/purchase.service';
import { PurchaseRepository } from '@/core/db/repositories/purchase.repository';
import { SupplierRepository } from '@/core/db/repositories/supplier.repository';
import { UnitRepository } from '@/core/db/repositories/unit.repository';
import { StockRepository } from '@/core/db/repositories/stock.repository';
import { contextFor } from './helpers/context';
import { imeiSeries, seedFixture, type Fixture } from './helpers/fixtures';
import type { AppContext } from '@/core/services/context';

/** Achats, réceptions et coût réel d'acquisition (§10, §11). */
describe('achats', () => {
  let fixture: Fixture;
  let context: AppContext;
  let supplierId: string;

  beforeEach(async () => {
    fixture = await seedFixture();
    context = await contextFor(fixture.db, fixture.adminId);
    supplierId = await new SupplierRepository(fixture.db).create({
      code: 'SHZ-01',
      name: 'Shenzhen Trading',
      country: 'Chine',
    });
  });

  const draftWithPhones = async (quantity = 3, unitPrice = 2_400_000) => {
    const service = new PurchaseService(context);
    const id = await service.create({
      supplierId,
      lines: [{ productId: fixture.phone, label: 'iPhone 15 128 Go', quantity, unitPrice }],
    });
    await service.markOrdered(id);
    return { service, id };
  };

  it('crée un brouillon numéroté et calcule ses totaux', async () => {
    const service = new PurchaseService(context);
    const id = await service.create({
      supplierId,
      lines: [
        { productId: fixture.phone, label: 'iPhone 15', quantity: 2, unitPrice: 2_400_000 },
        { productId: fixture.cable, label: 'Câble', quantity: 100, unitPrice: 4_000 },
      ],
    });

    const detail = await new PurchaseRepository(fixture.db).detail(id);
    expect(detail?.purchase.number).toMatch(/^A-CENT-\d{4}-0001$/);
    expect(detail?.purchase.status).toBe('DRAFT');
    expect(detail?.purchase.total).toBe(2 * 2_400_000 + 100 * 4_000);
  });

  it('interdit de modifier les lignes une fois commandé', async () => {
    const { service, id } = await draftWithPhones();
    await expect(
      service.updateLines(id, [
        { productId: fixture.phone, label: 'iPhone 15', quantity: 9, unitPrice: 1 },
      ]),
    ).rejects.toThrow(/ne se modifient plus/i);
  });

  it('réceptionne les appareils avec leurs IMEI et fait entrer le stock', async () => {
    const { service, id } = await draftWithPhones(3);
    const lines = await new PurchaseRepository(fixture.db).lines(id);
    const imei = imeiSeries(3);

    const { unitIds } = await service.receive(id, [
      {
        purchaseLineId: lines[0]!.id,
        quantity: 3,
        units: imei.map((value) => ({ imei1: value })),
      },
    ]);

    expect(unitIds).toHaveLength(3);
    const purchase = await new PurchaseRepository(fixture.db).byId(id);
    expect(purchase?.status).toBe('RECEIVED');

    const units = new UnitRepository(fixture.db);
    for (const value of imei) {
      const unit = await units.byIdentifier(value);
      expect(unit?.status).toBe('IN_STOCK');
      expect(unit?.purchaseId).toBe(id);
    }
  });

  it('passe en réception partielle puis complète', async () => {
    const { service, id } = await draftWithPhones(3);
    const lines = await new PurchaseRepository(fixture.db).lines(id);
    const imei = imeiSeries(3);

    await service.receive(id, [
      { purchaseLineId: lines[0]!.id, quantity: 1, units: [{ imei1: imei[0] }] },
    ]);
    expect((await new PurchaseRepository(fixture.db).byId(id))?.status).toBe('PARTIALLY_RECEIVED');

    await service.receive(id, [
      {
        purchaseLineId: lines[0]!.id,
        quantity: 2,
        units: [{ imei1: imei[1] }, { imei1: imei[2] }],
      },
    ]);
    expect((await new PurchaseRepository(fixture.db).byId(id))?.status).toBe('RECEIVED');
  });

  it('refuse de recevoir plus que la quantité commandée', async () => {
    const { service, id } = await draftWithPhones(2);
    const lines = await new PurchaseRepository(fixture.db).lines(id);
    await expect(
      service.receive(id, [
        {
          purchaseLineId: lines[0]!.id,
          quantity: 3,
          units: imeiSeries(3).map((value) => ({ imei1: value })),
        },
      ]),
    ).rejects.toThrow(/3 reçus pour 2 attendus/);
  });

  it("exige autant d'IMEI que d'appareils annoncés", async () => {
    const { service, id } = await draftWithPhones(3);
    const lines = await new PurchaseRepository(fixture.db).lines(id);
    await expect(
      service.receive(id, [
        { purchaseLineId: lines[0]!.id, quantity: 3, units: [{ imei1: imeiSeries(1)[0] }] },
      ]),
    ).rejects.toThrow(/3 appareils annoncés mais 1 identifiants saisis/);
  });

  describe('coûts logistiques', () => {
    it("ventile les frais au prorata de la valeur, sans perdre d'unité monétaire", async () => {
      const service = new PurchaseService(context);
      const id = await service.create({
        supplierId,
        lines: [
          { productId: fixture.phone, label: 'iPhone', quantity: 2, unitPrice: 3_000_000 },
          { productId: fixture.cable, label: 'Câble', quantity: 100, unitPrice: 10_000 },
        ],
      });
      // Valeurs : 6 000 000 et 1 000 000, soit 6/7 et 1/7 de 700 001.
      await service.addLandedCost(id, { kind: 'TRANSPORT', amount: 700_001 });

      const lines = await new PurchaseRepository(fixture.db).lines(id);
      const total = lines.reduce((sum, line) => sum + line.allocatedCost, 0);
      expect(total).toBe(700_001);
      expect(lines[0]?.allocatedCost).toBe(600_001);
      expect(lines[1]?.allocatedCost).toBe(100_000);
    });

    it('ventile au prorata des quantités quand la clé le demande', async () => {
      const service = new PurchaseService(context);
      const id = await service.create({
        supplierId,
        lines: [
          { productId: fixture.phone, label: 'iPhone', quantity: 1, unitPrice: 3_000_000 },
          { productId: fixture.cable, label: 'Câble', quantity: 3, unitPrice: 10_000 },
        ],
      });
      await service.addLandedCost(id, {
        kind: 'DELIVERY',
        amount: 40_000,
        allocation: 'BY_QUANTITY',
      });

      const lines = await new PurchaseRepository(fixture.db).lines(id);
      expect(lines[0]?.allocatedCost).toBe(10_000);
      expect(lines[1]?.allocatedCost).toBe(30_000);
    });

    it('porte le coût réel sur chaque appareil reçu', async () => {
      const service = new PurchaseService(context);
      const id = await service.create({
        supplierId,
        lines: [{ productId: fixture.phone, label: 'iPhone', quantity: 2, unitPrice: 2_400_000 }],
      });
      await service.addLandedCost(id, { kind: 'CUSTOMS', amount: 120_000 });
      await service.markOrdered(id);

      const lines = await new PurchaseRepository(fixture.db).lines(id);
      const imei = imeiSeries(2);
      const { unitIds } = await service.receive(id, [
        {
          purchaseLineId: lines[0]!.id,
          quantity: 2,
          units: imei.map((value) => ({ imei1: value })),
        },
      ]);

      const unit = await new UnitRepository(fixture.db).byId(unitIds[0]!);
      // (2 × 2 400 000 + 120 000) / 2 = 2 460 000
      expect(unit?.costPrice).toBe(2_460_000);
    });

    it("met à jour le total de l'achat avec les frais", async () => {
      const service = new PurchaseService(context);
      const id = await service.create({
        supplierId,
        lines: [{ productId: fixture.cable, label: 'Câble', quantity: 10, unitPrice: 4_000 }],
      });
      await service.addLandedCost(id, { kind: 'TRANSPORT', amount: 15_000 });

      const purchase = await new PurchaseRepository(fixture.db).byId(id);
      expect(purchase?.landedCostTotal).toBe(15_000);
      expect(purchase?.total).toBe(40_000 + 15_000);
    });
  });

  it('réceptionne un produit suivi par quantité sans identifiants', async () => {
    const service = new PurchaseService(context);
    const id = await service.create({
      supplierId,
      lines: [{ productId: fixture.cable, label: 'Câble', quantity: 50, unitPrice: 4_000 }],
    });
    await service.markOrdered(id);
    const lines = await new PurchaseRepository(fixture.db).lines(id);
    await service.receive(id, [{ purchaseLineId: lines[0]!.id, quantity: 50 }]);

    const level = await new StockRepository(fixture.db).levelOf(fixture.cable, fixture.shopA);
    expect(level.quantity).toBe(50);
  });

  it("refuse d'annuler un achat déjà réceptionné", async () => {
    const { service, id } = await draftWithPhones(1);
    const lines = await new PurchaseRepository(fixture.db).lines(id);
    await service.receive(id, [
      { purchaseLineId: lines[0]!.id, quantity: 1, units: [{ imei1: imeiSeries(1)[0] }] },
    ]);
    await expect(service.cancel(id, 'erreur')).rejects.toThrow(/clôturez-le/i);
  });
});
