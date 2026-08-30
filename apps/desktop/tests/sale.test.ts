import { PERMISSIONS } from '@boutique/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { SaleService } from '@/core/services/sale.service';
import { StockService } from '@/core/services/stock.service';
import { SaleRepository } from '@/core/db/repositories/sale.repository';
import { UnitRepository } from '@/core/db/repositories/unit.repository';
import { StockRepository } from '@/core/db/repositories/stock.repository';
import { CustomerRepository } from '@/core/db/repositories/customer.repository';
import { contextFor } from './helpers/context';
import { imeiSeries, seedFixture, type Fixture } from './helpers/fixtures';
import type { AppContext } from '@/core/services/context';

/** Encaissement — priorité n°3 des tests demandés (§30). */
describe('ventes', () => {
  let fixture: Fixture;
  let context: AppContext;
  let unitIds: string[];
  let imei: string[];

  beforeEach(async () => {
    fixture = await seedFixture();
    context = await contextFor(fixture.db, fixture.adminId);
    imei = imeiSeries(3);
    const stock = new StockService(context);
    unitIds = await stock.receiveUnits({
      productId: fixture.phone,
      units: imei.map((value) => ({ imei1: value, costPrice: 2_400_000 })),
    });
    await stock.receiveQuantity({ productId: fixture.cable, quantity: 20 });
  });

  it('encaisse un smartphone et marque son IMEI vendu', async () => {
    const result = await new SaleService(context).checkout({
      lines: [{ productId: fixture.phone, unitId: unitIds[0], quantity: 1 }],
      payments: [{ method: 'CASH', amount: 3_000_000 }],
    });

    expect(result.number).toMatch(/^T-CENT-\d{4}-00001$/);
    expect(result.total).toBe(2_950_000);
    expect(result.change).toBe(50_000);

    const unit = await new UnitRepository(fixture.db).byId(unitIds[0]!);
    expect(unit?.status).toBe('SOLD');
    expect(unit?.saleId).toBe(result.saleId);

    const history = await new StockRepository(fixture.db).unitHistory(unitIds[0]!);
    expect(history.map((movement) => movement.type)).toEqual(['PURCHASE_RECEIPT', 'SALE']);
  });

  it("fige le coût de l'appareil sur la ligne, pour une marge qui ne bouge plus", async () => {
    const service = new SaleService(context);
    const result = await service.checkout({
      lines: [{ productId: fixture.phone, unitId: unitIds[0], quantity: 1 }],
      payments: [{ method: 'CASH', amount: 2_950_000 }],
    });
    const lines = await new SaleRepository(fixture.db).lines(result.saleId);
    expect(lines[0]?.unitCost).toBe(2_400_000);
    expect(lines[0]?.identifier).toBe(imei[0]);
  });

  it('refuse de vendre deux fois le même IMEI', async () => {
    const service = new SaleService(context);
    await service.checkout({
      lines: [{ productId: fixture.phone, unitId: unitIds[0], quantity: 1 }],
      payments: [{ method: 'CASH', amount: 2_950_000 }],
    });

    await expect(
      service.checkout({
        lines: [{ productId: fixture.phone, unitId: unitIds[0], quantity: 1 }],
        payments: [{ method: 'CASH', amount: 2_950_000 }],
      }),
    ).rejects.toThrow(/pas disponible/i);
  });

  it("refuse un IMEI qui n'existe pas", async () => {
    await expect(
      new SaleService(context).checkout({
        lines: [{ productId: fixture.phone, unitId: 'inexistant', quantity: 1 }],
        payments: [{ method: 'CASH', amount: 2_950_000 }],
      }),
    ).rejects.toThrow(/appareil introuvable/i);
  });

  it("refuse de vendre un appareil d'une autre boutique", async () => {
    await fixture.db.execute('UPDATE product_unit SET shop_id = ? WHERE id = ?', [
      fixture.shopB,
      unitIds[0],
    ]);
    await expect(
      new SaleService(context).checkout({
        lines: [{ productId: fixture.phone, unitId: unitIds[0], quantity: 1 }],
        payments: [{ method: 'CASH', amount: 2_950_000 }],
      }),
    ).rejects.toThrow(/autre boutique/i);
  });

  it('exige un appareil précis pour un produit suivi par IMEI', async () => {
    await expect(
      new SaleService(context).checkout({
        lines: [{ productId: fixture.phone, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 2_950_000 }],
      }),
    ).rejects.toThrow(/sélectionnez l'appareil/i);
  });

  it('refuse deux fois le même appareil dans un seul panier', async () => {
    await expect(
      new SaleService(context).checkout({
        lines: [
          { productId: fixture.phone, unitId: unitIds[0], quantity: 1 },
          { productId: fixture.phone, unitId: unitIds[0], quantity: 1 },
        ],
        payments: [{ method: 'CASH', amount: 6_000_000 }],
      }),
    ).rejects.toThrow(/figure déjà dans le panier/i);
  });

  it('décrémente le stock des produits par quantité', async () => {
    await new SaleService(context).checkout({
      lines: [{ productId: fixture.cable, quantity: 3 }],
      payments: [{ method: 'CASH', amount: 36_000 }],
    });
    const level = await new StockRepository(fixture.db).levelOf(fixture.cable, fixture.shopA);
    expect(level.quantity).toBe(17);
  });

  it('refuse de vendre plus que le stock disponible', async () => {
    await expect(
      new SaleService(context).checkout({
        lines: [{ productId: fixture.cable, quantity: 25 }],
        payments: [{ method: 'CASH', amount: 300_000 }],
      }),
    ).rejects.toThrow(/stock insuffisant/i);
  });

  it('additionne les quantités du même produit avant de contrôler le stock', async () => {
    await expect(
      new SaleService(context).checkout({
        lines: [
          { productId: fixture.cable, quantity: 15 },
          { productId: fixture.cable, quantity: 10 },
        ],
        payments: [{ method: 'CASH', amount: 300_000 }],
      }),
    ).rejects.toThrow(/stock insuffisant/i);
  });

  it('refuse un règlement insuffisant', async () => {
    await expect(
      new SaleService(context).checkout({
        lines: [{ productId: fixture.phone, unitId: unitIds[0], quantity: 1 }],
        payments: [{ method: 'CASH', amount: 1_000_000 }],
      }),
    ).rejects.toThrow(/règlement insuffisant/i);
  });

  it('accepte un règlement mixte', async () => {
    const result = await new SaleService(context).checkout({
      lines: [{ productId: fixture.phone, unitId: unitIds[0], quantity: 1 }],
      payments: [
        { method: 'CASH', amount: 1_000_000 },
        { method: 'MOBILE_MONEY', amount: 1_950_000, reference: 'MVOLA-8817' },
      ],
    });
    const payments = await new SaleRepository(fixture.db).payments(result.saleId);
    expect(payments).toHaveLength(2);
    expect(payments[1]?.reference).toBe('MVOLA-8817');
  });

  it('refuse un mode de paiement désactivé', async () => {
    await fixture.db.execute("UPDATE payment_method SET is_active = 0 WHERE code = 'CARD'");
    await expect(
      new SaleService(context).checkout({
        lines: [{ productId: fixture.cable, quantity: 1 }],
        payments: [{ method: 'CARD', amount: 12_000 }],
      }),
    ).rejects.toThrow(/désactivé/i);
  });

  describe('remises', () => {
    it('refuse une remise à un vendeur qui ne peut pas en accorder', async () => {
      const seller = await contextFor(fixture.db, fixture.sellerId, {
        permissions: [PERMISSIONS.saleCreate, PERMISSIONS.productView, PERMISSIONS.stockView],
      });
      await expect(
        new SaleService(seller).checkout({
          lines: [{ productId: fixture.cable, quantity: 1, discount: 2_000 }],
          payments: [{ method: 'CASH', amount: 10_000 }],
        }),
      ).rejects.toThrow(/autorisé à accorder une remise/i);
    });

    it('refuse un prix inférieur au plancher du produit', async () => {
      await fixture.db.execute('UPDATE product SET min_price = ? WHERE id = ?', [
        2_800_000,
        fixture.phone,
      ]);
      await expect(
        new SaleService(context).checkout({
          lines: [
            { productId: fixture.phone, unitId: unitIds[0], quantity: 1, unitPrice: 2_700_000 },
          ],
          payments: [{ method: 'CASH', amount: 2_700_000 }],
        }),
      ).rejects.toThrow(/prix plancher/i);
    });

    it('applique une remise autorisée au total', async () => {
      const result = await new SaleService(context).checkout({
        lines: [{ productId: fixture.cable, quantity: 2, discount: 4_000 }],
        payments: [{ method: 'CASH', amount: 20_000 }],
      });
      expect(result.total).toBe(2 * 12_000 - 4_000);
    });
  });

  describe('annulation', () => {
    it("remet l'appareil en stock et écrit un mouvement inverse", async () => {
      const service = new SaleService(context);
      const result = await service.checkout({
        lines: [{ productId: fixture.phone, unitId: unitIds[0], quantity: 1 }],
        payments: [{ method: 'CASH', amount: 2_950_000 }],
      });

      await service.cancel(result.saleId, 'erreur de caisse');

      const sale = await new SaleRepository(fixture.db).byId(result.saleId);
      expect(sale?.status).toBe('CANCELLED');
      expect(sale?.deletedAt).toBeNull();

      const unit = await new UnitRepository(fixture.db).byId(unitIds[0]!);
      expect(unit?.status).toBe('IN_STOCK');
      expect(unit?.saleId).toBeNull();

      const history = await new StockRepository(fixture.db).unitHistory(unitIds[0]!);
      expect(history.map((movement) => movement.type)).toEqual([
        'PURCHASE_RECEIPT',
        'SALE',
        'SALE_CANCELLED',
      ]);
    });

    it('exige un motif', async () => {
      const service = new SaleService(context);
      const result = await service.checkout({
        lines: [{ productId: fixture.cable, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 12_000 }],
      });
      await expect(service.cancel(result.saleId, '  ')).rejects.toThrow(/motif/i);
    });

    it('refuse une seconde annulation', async () => {
      const service = new SaleService(context);
      const result = await service.checkout({
        lines: [{ productId: fixture.cable, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 12_000 }],
      });
      await service.cancel(result.saleId, 'erreur');
      await expect(service.cancel(result.saleId, 'encore')).rejects.toThrow(/déjà annulée/i);
    });
  });

  it("rattache la vente au client et alimente son historique d'appareils", async () => {
    const customerId = await new CustomerRepository(fixture.db).create({
      lastName: 'Rasoa',
      firstName: 'Hery',
      phone: '0341234567',
    });
    await new SaleService(context).checkout({
      lines: [{ productId: fixture.phone, unitId: unitIds[0], quantity: 1 }],
      payments: [{ method: 'CASH', amount: 2_950_000 }],
      customerId,
    });

    const history = await new CustomerRepository(fixture.db).history(customerId);
    expect(history.totals.salesCount).toBe(1);
    expect(history.devices[0]?.identifier).toBe(imei[0]);
  });
});
