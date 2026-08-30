import { beforeEach, describe, expect, it } from 'vitest';
import { localDay, periodRange } from '@boutique/shared';
import { SearchService } from '@/core/services/search.service';
import { ReportService } from '@/core/services/report.service';
import { StockService } from '@/core/services/stock.service';
import { SaleService } from '@/core/services/sale.service';
import { RefundService } from '@/core/services/refund.service';
import { SaleRepository } from '@/core/db/repositories/sale.repository';
import { CustomerRepository } from '@/core/db/repositories/customer.repository';
import { contextFor } from './helpers/context';
import { imeiSeries, seedFixture, type Fixture } from './helpers/fixtures';
import type { AppContext } from '@/core/services/context';

/** Recherche globale (§23) et rapports (§22). */
describe('recherche globale', () => {
  let fixture: Fixture;
  let context: AppContext;
  let recherche: SearchService;
  let imei: string[];
  let unitIds: string[];

  beforeEach(async () => {
    fixture = await seedFixture();
    context = await contextFor(fixture.db, fixture.adminId);
    recherche = new SearchService(fixture.db);
    imei = imeiSeries(2);
    unitIds = await new StockService(context).receiveUnits({
      productId: fixture.phone,
      units: imei.map((valeur) => ({ imei1: valeur })),
    });
  });

  it('ouvre directement la fiche quand un IMEI est scanné', async () => {
    const resultat = await recherche.search(imei[0]!);
    expect(resultat.direct?.kind).toBe('UNIT');
    expect(resultat.direct?.id).toBe(unitIds[0]);
  });

  it('accepte un IMEI collé avec des séparateurs', async () => {
    const brut = imei[0]!;
    const resultat = await recherche.search(`${brut.slice(0, 6)}-${brut.slice(6)}`);
    expect(resultat.direct?.kind).toBe('UNIT');
  });

  it('trouve un produit par son SKU exact', async () => {
    const resultat = await recherche.search('CAB-USBC-1M');
    expect(resultat.hits[0]?.kind).toBe('PRODUCT');
    expect(resultat.hits[0]?.exact).toBe(true);
  });

  it('trouve un produit par un mot de son nom, sans accent', async () => {
    const resultat = await recherche.search('cable');
    expect(resultat.hits.some((hit) => hit.title.includes('Câble'))).toBe(true);
  });

  it('trouve un ticket par son numéro', async () => {
    const vente = await new SaleService(context).checkout({
      lines: [{ productId: fixture.phone, unitId: unitIds[0], quantity: 1 }],
      payments: [{ method: 'CASH', amount: 2_950_000 }],
    });
    const resultat = await recherche.search(vente.number);
    expect(resultat.direct?.kind).toBe('SALE');
    expect(resultat.direct?.id).toBe(vente.saleId);
  });

  it('trouve un client par son téléphone', async () => {
    await new CustomerRepository(fixture.db).create({
      lastName: 'Rakoto',
      firstName: 'Sitraka',
      phone: '0341234567',
    });
    const resultat = await recherche.search('0341234567');
    expect(resultat.hits.some((hit) => hit.kind === 'CUSTOMER')).toBe(true);
  });

  it('ne cherche pas sur une saisie trop courte', async () => {
    expect((await recherche.search('a')).hits).toHaveLength(0);
  });
});

describe('rapports', () => {
  let fixture: Fixture;
  let context: AppContext;
  let rapport: ReportService;

  beforeEach(async () => {
    fixture = await seedFixture();
    context = await contextFor(fixture.db, fixture.adminId);
    rapport = new ReportService(fixture.db, fixture.shopA);

    const stock = new StockService(context);
    const unitIds = await stock.receiveUnits({
      productId: fixture.phone,
      units: imeiSeries(2).map((valeur) => ({ imei1: valeur, costPrice: 2_400_000 })),
    });
    await stock.receiveQuantity({ productId: fixture.cable, quantity: 50 });

    const ventes = new SaleService(context);
    await ventes.checkout({
      lines: [{ productId: fixture.phone, unitId: unitIds[0], quantity: 1 }],
      payments: [{ method: 'CASH', amount: 2_950_000 }],
    });
    await ventes.checkout({
      lines: [{ productId: fixture.cable, quantity: 4 }],
      payments: [{ method: 'MOBILE_MONEY', amount: 48_000 }],
    });
  });

  const aujourdhui = () => periodRange(localDay(), localDay());

  it("calcule le chiffre d'affaires et la marge sur les coûts figés", async () => {
    const totaux = await rapport.salesTotals(aujourdhui());
    expect(totaux.count).toBe(2);
    expect(totaux.revenue).toBe(2_950_000 + 48_000);
    // Marge = 2 950 000 − 2 400 000 pour le téléphone, 48 000 − 16 000 pour les câbles.
    expect(totaux.margin).toBe(550_000 + 32_000);
  });

  it("exclut les ventes annulées du chiffre d'affaires", async () => {
    const ventes = await new SaleRepository(fixture.db).list({ shopId: fixture.shopA });
    const premiere = ventes.items[0];
    await new SaleService(context).cancel(premiere!.id, 'erreur de caisse');

    const totaux = await rapport.salesTotals(aujourdhui());
    expect(totaux.count).toBe(1);
  });

  it('compte les remboursements à part, sans les soustraire du CA', async () => {
    const ventes = await new SaleRepository(fixture.db).list({ shopId: fixture.shopA });
    const cible = ventes.items.find((vente) => vente.itemCount === 4);
    const lignes = await new SaleRepository(fixture.db).lines(cible!.id);
    await new RefundService(context).refund({
      saleId: cible!.id,
      method: 'CASH',
      lines: [{ saleLineId: lignes[0]!.id, quantity: 2 }],
    });

    const totaux = await rapport.salesTotals(aujourdhui());
    expect(totaux.revenue).toBe(2_950_000 + 48_000);
    expect(await rapport.refundTotal(aujourdhui())).toBe(24_000);
  });

  it('ventile les encaissements par mode de paiement', async () => {
    const modes = await rapport.paymentBreakdown(aujourdhui());
    const parCode = new Map(modes.map((mode) => [mode.method, mode.amount]));
    expect(parCode.get('CASH')).toBe(2_950_000);
    expect(parCode.get('MOBILE_MONEY')).toBe(48_000);
  });

  it("classe les produits par chiffre d'affaires", async () => {
    const meilleurs = await rapport.topProducts(aujourdhui());
    expect(meilleurs[0]?.sku).toBe('IPH15-128-NOIR');
    expect(meilleurs[0]?.margin).toBe(550_000);
  });

  it("valorise le stock au coût d'acquisition", async () => {
    const valeur = await rapport.stockValue();
    // Un téléphone restant à 2 400 000, plus 46 câbles à 4 000.
    expect(valeur.value).toBe(2_400_000 + 46 * 4_000);
  });

  it('compte les produits sous leur seuil', async () => {
    // Le câble a un seuil de 10 ; il en reste 46, il n'est donc pas en alerte.
    expect(await rapport.lowStockCount(3)).toBeGreaterThanOrEqual(1);
    await new StockService(context).adjust({
      productId: fixture.cable,
      quantity: -40,
      note: 'casse en réserve',
    });
    const apres = await rapport.lowStockCount(3);
    expect(apres).toBeGreaterThanOrEqual(2);
  });

  it('assemble le tableau de bord en une lecture', async () => {
    const chiffres = await rapport.dashboard(3);
    expect(chiffres.salesToday).toBe(2);
    expect(chiffres.revenueToday).toBe(2_998_000);
    expect(chiffres.averageBasket).toBe(1_499_000);
    expect(chiffres.stockUnits).toBeGreaterThan(0);
  });
});
