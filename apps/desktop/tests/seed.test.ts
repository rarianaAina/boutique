import { describe, expect, it } from 'vitest';
import { SeedService } from '@/core/services/seed.service';
import { ReportService } from '@/core/services/report.service';
import { StockRepository } from '@/core/db/repositories/stock.repository';
import { contextFor } from './helpers/context';
import { seedFixture } from './helpers/fixtures';

/**
 * Le jeu de démonstration (§29) passe par les MÊMES services que l'utilisation
 * normale. Ce test le vérifie là où ça compte : les mouvements de stock
 * existent, les rapports affichent des chiffres, et rien n'a été inséré
 * directement en base pour faire joli.
 */
describe('jeu de démonstration', () => {
  it('produit des données cohérentes et traçables', async () => {
    const fixture = await seedFixture();
    const context = await contextFor(fixture.db, fixture.adminId);
    const report = await new SeedService(context).run();

    expect(report.products).toBeGreaterThan(10);
    expect(report.units).toBeGreaterThan(10);
    expect(report.sales).toBeGreaterThan(2);

    // Chaque appareil en stock a au moins un mouvement d'entrée.
    const orphans = await fixture.db.select<{ total: number }>(
      `SELECT COUNT(*) AS total FROM product_unit u
       WHERE NOT EXISTS (SELECT 1 FROM stock_movement m WHERE m.unit_id = u.id)`,
    );
    expect(orphans[0]?.total).toBe(0);

    // Le tableau de bord affiche des chiffres réels.
    const figures = await new ReportService(fixture.db, fixture.shopA).dashboard();
    expect(figures.revenueToday).toBeGreaterThan(0);
    expect(figures.stockUnits).toBeGreaterThan(0);
    expect(figures.pendingTransfersOut).toBe(1);

    // Les niveaux de stock des produits par quantité se recalculent à
    // l'identique depuis les mouvements : preuve qu'aucun n'a été écrit à côté.
    const stock = new StockRepository(fixture.db);
    const before = await stock.levelOf(
      (
        await fixture.db.select<{ id: string }>("SELECT id FROM product WHERE sku = 'CAB-USBC-1M'")
      )[0]!.id,
      fixture.shopA,
    );
    await stock.rebuildLevels(fixture.shopA);
    const after = await stock.levelOf(
      (
        await fixture.db.select<{ id: string }>("SELECT id FROM product WHERE sku = 'CAB-USBC-1M'")
      )[0]!.id,
      fixture.shopA,
    );
    expect(after.quantity).toBe(before.quantity);

    fixture.db.close();
  });

  it('refuse de tourner sur une base qui contient déjà des ventes', async () => {
    const fixture = await seedFixture();
    const context = await contextFor(fixture.db, fixture.adminId);
    const service = new SeedService(context);
    await service.run();
    await expect(service.run()).rejects.toThrow(/contient déjà des ventes/i);
    fixture.db.close();
  });
});
