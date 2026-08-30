import { beforeEach, describe, expect, it } from 'vitest';
import { SaleService } from '@/core/services/sale.service';
import { StockService } from '@/core/services/stock.service';
import { RefundService } from '@/core/services/refund.service';
import { ExchangeService } from '@/core/services/exchange.service';
import { SaleRepository } from '@/core/db/repositories/sale.repository';
import { UnitRepository } from '@/core/db/repositories/unit.repository';
import { StockRepository } from '@/core/db/repositories/stock.repository';
import { RefundRepository, ExchangeRepository } from '@/core/db/repositories/refund.repository';
import { contextFor } from './helpers/context';
import { imeiSeries, seedFixture, type Fixture } from './helpers/fixtures';
import type { AppContext } from '@/core/services/context';

/** Remboursements (§16) et échanges (§15) — priorités 4 et 5 des tests (§30). */
describe('remboursements', () => {
  let fixture: Fixture;
  let context: AppContext;
  let unitIds: string[];

  beforeEach(async () => {
    fixture = await seedFixture();
    context = await contextFor(fixture.db, fixture.adminId);
    const stock = new StockService(context);
    unitIds = await stock.receiveUnits({
      productId: fixture.phone,
      units: imeiSeries(4).map((value) => ({ imei1: value, costPrice: 2_400_000 })),
    });
    await stock.receiveQuantity({ productId: fixture.cable, quantity: 30 });
  });

  const sellPhone = async (index = 0) =>
    new SaleService(context).checkout({
      lines: [{ productId: fixture.phone, unitId: unitIds[index], quantity: 1 }],
      payments: [{ method: 'CASH', amount: 2_950_000 }],
    });

  it("remet l'appareil en stock et marque la vente remboursée", async () => {
    const sale = await sellPhone();
    const lines = await new SaleRepository(fixture.db).lines(sale.saleId);

    const result = await new RefundService(context).refund({
      saleId: sale.saleId,
      method: 'CASH',
      reason: 'client non satisfait',
      lines: [{ saleLineId: lines[0]!.id, quantity: 1 }],
    });

    expect(result.total).toBe(2_950_000);
    expect((await new SaleRepository(fixture.db).byId(sale.saleId))?.status).toBe('REFUNDED');

    const unit = await new UnitRepository(fixture.db).byId(unitIds[0]!);
    expect(unit?.status).toBe('RETURNED');
    expect(unit?.saleId).toBeNull();
  });

  it('interdit de rembourser deux fois la même vente', async () => {
    const sale = await sellPhone();
    const lines = await new SaleRepository(fixture.db).lines(sale.saleId);
    const service = new RefundService(context);

    await service.refund({
      saleId: sale.saleId,
      method: 'CASH',
      lines: [{ saleLineId: lines[0]!.id, quantity: 1 }],
    });

    await expect(
      service.refund({
        saleId: sale.saleId,
        method: 'CASH',
        lines: [{ saleLineId: lines[0]!.id, quantity: 1 }],
      }),
    ).rejects.toThrow(/1 rendus pour 0 remboursables/i);
  });

  it('rembourse partiellement une ligne de plusieurs articles', async () => {
    const sale = await new SaleService(context).checkout({
      lines: [{ productId: fixture.cable, quantity: 5 }],
      payments: [{ method: 'CASH', amount: 60_000 }],
    });
    const lines = await new SaleRepository(fixture.db).lines(sale.saleId);

    const result = await new RefundService(context).refund({
      saleId: sale.saleId,
      method: 'CASH',
      lines: [{ saleLineId: lines[0]!.id, quantity: 2 }],
    });

    expect(result.total).toBe(24_000);
    expect((await new SaleRepository(fixture.db).byId(sale.saleId))?.status).toBe(
      'PARTIALLY_REFUNDED',
    );
    const level = await new StockRepository(fixture.db).levelOf(fixture.cable, fixture.shopA);
    expect(level.quantity).toBe(30 - 5 + 2);
  });

  it('refuse de rendre plus que ce qui a été payé', async () => {
    const sale = await sellPhone();
    const lines = await new SaleRepository(fixture.db).lines(sale.saleId);
    await expect(
      new RefundService(context).refund({
        saleId: sale.saleId,
        method: 'CASH',
        lines: [{ saleLineId: lines[0]!.id, quantity: 1, amount: 5_000_000 }],
      }),
    ).rejects.toThrow(/part remboursable/i);
  });

  it('calcule le remboursement sur le prix NET, remise déduite', async () => {
    const sale = await new SaleService(context).checkout({
      lines: [{ productId: fixture.cable, quantity: 2, discount: 4_000 }],
      payments: [{ method: 'CASH', amount: 20_000 }],
    });
    const lines = await new SaleRepository(fixture.db).lines(sale.saleId);
    const result = await new RefundService(context).refund({
      saleId: sale.saleId,
      method: 'CASH',
      lines: [{ saleLineId: lines[0]!.id, quantity: 2 }],
    });
    expect(result.total).toBe(20_000);
  });

  it('garde hors du stock vendable un article rendu cassé', async () => {
    const sale = await sellPhone();
    const lines = await new SaleRepository(fixture.db).lines(sale.saleId);
    await new RefundService(context).refund({
      saleId: sale.saleId,
      method: 'CASH',
      lines: [{ saleLineId: lines[0]!.id, quantity: 1, restock: false }],
    });

    const unit = await new UnitRepository(fixture.db).byId(unitIds[0]!);
    expect(unit?.status).toBe('DEFECTIVE');

    const history = await new StockRepository(fixture.db).unitHistory(unitIds[0]!);
    expect(history.map((movement) => movement.type)).toEqual([
      'PURCHASE_RECEIPT',
      'SALE',
      'CUSTOMER_RETURN',
      'BREAKAGE',
    ]);
  });

  it('refuse de rembourser une vente annulée', async () => {
    const sale = await sellPhone();
    const lines = await new SaleRepository(fixture.db).lines(sale.saleId);
    await new SaleService(context).cancel(sale.saleId, 'erreur');
    await expect(
      new RefundService(context).refund({
        saleId: sale.saleId,
        method: 'CASH',
        lines: [{ saleLineId: lines[0]!.id, quantity: 1 }],
      }),
    ).rejects.toThrow(/annulée/i);
  });

  it('indique ce qui reste remboursable', async () => {
    const sale = await new SaleService(context).checkout({
      lines: [{ productId: fixture.cable, quantity: 4 }],
      payments: [{ method: 'CASH', amount: 48_000 }],
    });
    const lines = await new SaleRepository(fixture.db).lines(sale.saleId);
    const service = new RefundService(context);
    await service.refund({
      saleId: sale.saleId,
      method: 'CASH',
      lines: [{ saleLineId: lines[0]!.id, quantity: 1 }],
    });

    const remaining = await service.refundable(sale.saleId);
    expect(remaining.amount).toBe(36_000);
    expect(remaining.lines[0]?.remaining).toBe(3);
  });
});

describe('échanges', () => {
  let fixture: Fixture;
  let context: AppContext;
  let unitIds: string[];
  let imei: string[];

  beforeEach(async () => {
    fixture = await seedFixture();
    context = await contextFor(fixture.db, fixture.adminId);
    imei = imeiSeries(4);
    unitIds = await new StockService(context).receiveUnits({
      productId: fixture.phone,
      units: imei.map((value) => ({ imei1: value, costPrice: 2_400_000 })),
    });
  });

  const sell = async (index: number) =>
    new SaleService(context).checkout({
      lines: [{ productId: fixture.phone, unitId: unitIds[index], quantity: 1 }],
      payments: [{ method: 'CASH', amount: 2_950_000 }],
    });

  it("échange à valeur égale sans mouvement d'argent", async () => {
    const sale = await sell(0);
    const result = await new ExchangeService(context).exchange({
      originalSaleId: sale.saleId,
      returnedUnitId: unitIds[0]!,
      newUnitId: unitIds[1]!,
    });

    expect(result.priceDifference).toBe(0);
    expect(result.refundId).toBeNull();

    const units = new UnitRepository(fixture.db);
    expect((await units.byId(unitIds[0]!))?.status).toBe('RETURNED');
    expect((await units.byId(unitIds[1]!))?.status).toBe('SOLD');

    // La vente d'origine n'est pas touchée : elle reste consultable telle quelle.
    const original = await new SaleRepository(fixture.db).byId(sale.saleId);
    expect(original?.deletedAt).toBeNull();
    expect(original?.total).toBe(2_950_000);
  });

  it('encaisse la différence quand le nouvel appareil est plus cher', async () => {
    const sale = await sell(0);
    const result = await new ExchangeService(context).exchange({
      originalSaleId: sale.saleId,
      returnedUnitId: unitIds[0]!,
      newUnitId: unitIds[1]!,
      newUnitPrice: 3_400_000,
      settlement: { method: 'CASH', amount: 450_000 },
    });

    expect(result.priceDifference).toBe(450_000);
    const newSale = await new SaleRepository(fixture.db).byId(result.newSaleId!);
    expect(newSale?.total).toBe(450_000);
    const payments = await new SaleRepository(fixture.db).payments(result.newSaleId!);
    expect(payments[0]?.amount).toBe(450_000);
  });

  it('exige le règlement de la différence', async () => {
    const sale = await sell(0);
    await expect(
      new ExchangeService(context).exchange({
        originalSaleId: sale.saleId,
        returnedUnitId: unitIds[0]!,
        newUnitId: unitIds[1]!,
        newUnitPrice: 3_400_000,
      }),
    ).rejects.toThrow(/doit compléter de 450000/);
  });

  it('rembourse le solde quand le nouvel appareil est moins cher', async () => {
    const sale = await sell(0);
    const result = await new ExchangeService(context).exchange({
      originalSaleId: sale.saleId,
      returnedUnitId: unitIds[0]!,
      newUnitId: unitIds[1]!,
      newUnitPrice: 2_500_000,
    });

    expect(result.priceDifference).toBe(-450_000);
    expect(result.refundId).not.toBeNull();

    const refund = await new RefundRepository(fixture.db).byId(result.refundId!);
    expect(refund?.total).toBe(450_000);
    // La nouvelle vente est intégralement couverte par la reprise : total nul.
    const newSale = await new SaleRepository(fixture.db).byId(result.newSaleId!);
    expect(newSale?.total).toBe(0);
  });

  it('refuse un appareil qui ne figure pas sur la vente indiquée', async () => {
    const sale = await sell(0);
    await expect(
      new ExchangeService(context).exchange({
        originalSaleId: sale.saleId,
        returnedUnitId: unitIds[2]!,
        newUnitId: unitIds[1]!,
      }),
    ).rejects.toThrow(/ne figure pas sur la vente/i);
  });

  it('refuse un nouvel appareil déjà vendu', async () => {
    const first = await sell(0);
    await sell(1);
    await expect(
      new ExchangeService(context).exchange({
        originalSaleId: first.saleId,
        returnedUnitId: unitIds[0]!,
        newUnitId: unitIds[1]!,
      }),
    ).rejects.toThrow(/pas disponible/i);
  });

  it('refuse deux échanges successifs du même appareil', async () => {
    const sale = await sell(0);
    const service = new ExchangeService(context);
    await service.exchange({
      originalSaleId: sale.saleId,
      returnedUnitId: unitIds[0]!,
      newUnitId: unitIds[1]!,
    });
    await expect(
      service.exchange({
        originalSaleId: sale.saleId,
        returnedUnitId: unitIds[0]!,
        newUnitId: unitIds[2]!,
      }),
    ).rejects.toThrow(/déjà été rendu/i);
  });

  it("retrouve la vente d'origine à partir de l'IMEI rendu", async () => {
    const sale = await sell(0);
    const prepared = await new ExchangeService(context).prepare(imei[0]!);
    expect(prepared.saleId).toBe(sale.saleId);
    expect(prepared.creditedValue).toBe(2_950_000);
    expect(prepared.productName).toContain('iPhone');
  });

  it("conserve l'historique complet des deux appareils", async () => {
    const sale = await sell(0);
    const result = await new ExchangeService(context).exchange({
      originalSaleId: sale.saleId,
      returnedUnitId: unitIds[0]!,
      newUnitId: unitIds[1]!,
    });

    const stock = new StockRepository(fixture.db);
    expect((await stock.unitHistory(unitIds[0]!)).map((m) => m.type)).toEqual([
      'PURCHASE_RECEIPT',
      'SALE',
      'EXCHANGE_IN',
    ]);
    expect((await stock.unitHistory(unitIds[1]!)).map((m) => m.type)).toEqual([
      'PURCHASE_RECEIPT',
      'SALE',
    ]);

    const exchanges = await new ExchangeRepository(fixture.db).forSale(sale.saleId);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.number).toMatch(/^E-CENT-\d{4}-0001$/);
    expect(exchanges[0]?.newSaleId).toBe(result.newSaleId);
  });
});
