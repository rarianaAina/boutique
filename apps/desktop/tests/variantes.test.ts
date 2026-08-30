import { beforeEach, describe, expect, it } from 'vitest';
import { variantGroupKey, variantLabel } from '@boutique/shared';
import { ProductService } from '@/core/services/catalog.service';
import { StockService } from '@/core/services/stock.service';
import { SaleService } from '@/core/services/sale.service';
import { ProductRepository } from '@/core/db/repositories/product.repository';
import { UnitRepository } from '@/core/db/repositories/unit.repository';
import { runStartupMaintenance } from '@/core/db/startup';
import { contextFor } from './helpers/context';
import { imeiSeries, seedFixture, type Fixture } from './helpers/fixtures';
import type { AppContext } from '@/core/services/context';

/**
 * Variantes de produit : couleur et capacité.
 *
 * « iPhone 17 Pro Max rouge 256 Go » et « iPhone 17 Pro Max noir 128 Go » sont
 * deux produits — deux prix, deux stocks — et un seul modèle aux yeux du
 * vendeur. Ces tests portent sur ce double statut.
 */
describe('regroupement des déclinaisons', () => {
  it("réunit les variantes d'un même modèle", () => {
    const rouge = variantGroupKey({ brand: 'Apple', model: 'iPhone 17 Pro Max', name: 'x' });
    const noir = variantGroupKey({ brand: 'apple', model: 'IPHONE 17 PRO MAX', name: 'y' });
    expect(rouge).toBe(noir);
  });

  it('ignore la couleur et la capacité : ce sont les axes, pas le groupe', () => {
    const a = variantGroupKey({ brand: 'Apple', model: 'iPhone 17', name: 'iPhone 17 Rouge' });
    const b = variantGroupKey({ brand: 'Apple', model: 'iPhone 17', name: 'iPhone 17 Noir' });
    expect(a).toBe(b);
  });

  it('retombe sur le nom quand le modèle manque', () => {
    expect(variantGroupKey({ name: 'Iphone 12 Pro Max ' })).toBe('iphone 12 pro max');
  });

  it('sépare deux modèles différents', () => {
    expect(variantGroupKey({ brand: 'Apple', name: 'iPhone 17' })).not.toBe(
      variantGroupKey({ brand: 'Apple', name: 'iPhone 16' }),
    );
  });

  it('met en forme un libellé lisible', () => {
    expect(variantLabel('Rouge', '256 Go')).toBe('256 Go · Rouge');
    expect(variantLabel(null, '128 Go')).toBe('128 Go');
    expect(variantLabel(null, null)).toBe('');
  });
});

describe('variantes en base', () => {
  let fixture: Fixture;
  let context: AppContext;

  const modele = {
    name: 'iPhone 17 Pro Max',
    brand: 'Apple',
    model: 'iPhone 17 Pro Max',
    tracking: 'IMEI' as const,
    purchasePrice: 3_000_000,
    salePrice: 3_800_000,
  };

  beforeEach(async () => {
    fixture = await seedFixture();
    context = await contextFor(fixture.db, fixture.adminId);
  });

  it('crée des variantes distinctes qui partagent leur groupe', async () => {
    const service = new ProductService(context);
    const rouge = await service.create({ ...modele, color: 'Rouge', capacity: '256 Go' });
    const noir = await service.create({ ...modele, color: 'Noir', capacity: '128 Go' });

    const depot = new ProductRepository(fixture.db);
    const a = await depot.byId(rouge);
    const b = await depot.byId(noir);

    expect(a?.variantGroup).toBe(b?.variantGroup);
    expect(a?.id).not.toBe(b?.id);
    expect(a?.sku).toBe('AUTO-IPHONE-17-PRO-MAX-APPLE-256-GO-ROUGE');
    expect(b?.sku).toBe('AUTO-IPHONE-17-PRO-MAX-APPLE-128-GO-NOIR');
  });

  it('remonte couleur et capacité en colonnes, hors des attributs libres', async () => {
    const id = await new ProductService(context).create({
      ...modele,
      attributes: { couleur: 'Rouge', capacite: '256 Go', ram: '8 Go' },
    });
    const produit = await new ProductRepository(fixture.db).byId(id);

    expect(produit?.color).toBe('Rouge');
    expect(produit?.capacity).toBe('256 Go');
    // Une seule vérité : les attributs ne gardent plus de copie.
    expect(produit?.attributes).toEqual({ ram: '8 Go' });
  });

  it('liste les déclinaisons avec leur disponibilité, épuisées comprises', async () => {
    const service = new ProductService(context);
    const rouge = await service.create({ ...modele, color: 'Rouge', capacity: '256 Go' });
    const noir = await service.create({ ...modele, color: 'Noir', capacity: '256 Go' });
    await service.create({ ...modele, color: 'Bleu', capacity: '512 Go' });

    await new StockService(context).receiveUnits({
      productId: rouge,
      units: imeiSeries(2).map((valeur) => ({ imei1: valeur })),
    });

    const depot = new ProductRepository(fixture.db);
    const groupe = (await depot.byId(rouge))!.variantGroup!;
    const variantes = await depot.variantsOf(groupe, fixture.shopA);

    expect(variantes).toHaveLength(3);
    const parId = new Map(variantes.map((v) => [v.id, v]));
    expect(parId.get(rouge)?.available).toBe(2);
    // Le noir est proposé bien qu'épuisé : le vendeur doit pouvoir dire
    // « je ne l'ai plus » plutôt que de laisser croire qu'il n'existe pas.
    expect(parId.get(noir)?.available).toBe(0);
  });

  it('compte les déclinaisons dans la recherche du comptoir', async () => {
    const service = new ProductService(context);
    await service.create({ ...modele, color: 'Rouge', capacity: '256 Go' });
    await service.create({ ...modele, color: 'Noir', capacity: '128 Go' });

    const page = await new ProductRepository(fixture.db).search({
      shopId: fixture.shopA,
      query: 'iphone 17',
    });
    expect(page.items).toHaveLength(2);
    for (const item of page.items) expect(item.variantCount).toBe(2);
  });

  it('permet des prix différents par déclinaison', async () => {
    const service = new ProductService(context);
    const petit = await service.create({ ...modele, capacity: '128 Go', salePrice: 3_400_000 });
    const grand = await service.create({ ...modele, capacity: '512 Go', salePrice: 4_200_000 });

    const depot = new ProductRepository(fixture.db);
    expect((await depot.byId(petit))?.salePrice).toBe(3_400_000);
    expect((await depot.byId(grand))?.salePrice).toBe(4_200_000);
  });

  it('renseigne les groupes manquants au démarrage', async () => {
    const id = await new ProductService(context).create({ ...modele, color: 'Rouge' });
    // On simule une base créée avant l'arrivée des variantes.
    await fixture.db.execute('UPDATE product SET variant_group = NULL');

    const rapport = await runStartupMaintenance(fixture.db);
    expect(rapport.variantGroupsRepaired).toBeGreaterThan(0);

    const produit = await new ProductRepository(fixture.db).byId(id);
    expect(produit?.variantGroup).toBe(
      variantGroupKey({ brand: 'Apple', model: 'iPhone 17 Pro Max', name: modele.name }),
    );
  });
});

describe('vente sans scanner', () => {
  let fixture: Fixture;
  let context: AppContext;
  let unitIds: string[];

  beforeEach(async () => {
    fixture = await seedFixture();
    context = await contextFor(fixture.db, fixture.adminId);
    unitIds = await new StockService(context).receiveUnits({
      productId: fixture.phone,
      units: imeiSeries(3).map((valeur) => ({ imei1: valeur })),
    });
  });

  it('propose les exemplaires disponibles, du plus ancien au plus récent', async () => {
    const disponibles = await new UnitRepository(fixture.db).availableFor(
      fixture.phone,
      fixture.shopA,
    );
    expect(disponibles.map((unite) => unite.id)).toEqual(unitIds);
  });

  it('vend un appareil désigné à la main, sans passer par un scan', async () => {
    // Le deuxième de la liste : c'est bien un choix, pas le premier venu.
    const choisi = unitIds[1]!;
    const resultat = await new SaleService(context).checkout({
      lines: [{ productId: fixture.phone, unitId: choisi, quantity: 1 }],
      payments: [{ method: 'CASH', amount: 2_950_000 }],
    });

    const unite = await new UnitRepository(fixture.db).byId(choisi);
    expect(unite?.status).toBe('SOLD');
    expect(unite?.saleId).toBe(resultat.saleId);
  });

  it("retire l'appareil vendu de la liste proposée", async () => {
    await new SaleService(context).checkout({
      lines: [{ productId: fixture.phone, unitId: unitIds[0], quantity: 1 }],
      payments: [{ method: 'CASH', amount: 2_950_000 }],
    });

    const restants = await new UnitRepository(fixture.db).availableFor(
      fixture.phone,
      fixture.shopA,
    );
    expect(restants.map((unite) => unite.id)).toEqual(unitIds.slice(1));
  });
});

describe('suppression de produit', () => {
  let fixture: Fixture;
  let context: AppContext;

  beforeEach(async () => {
    fixture = await seedFixture();
    context = await contextFor(fixture.db, fixture.adminId);
  });

  it('efface définitivement un produit que rien ne cite', async () => {
    const service = new ProductService(context);
    const id = await service.create({
      name: 'Erreur de saisie',
      tracking: 'QUANTITY',
      purchasePrice: 1,
      salePrice: 2,
    });

    expect((await service.deletionImpact(id)).removable).toBe(true);
    const resultat = await service.remove(id);

    expect(resultat.definitive).toBe(true);
    expect(await new ProductRepository(fixture.db).byId(id)).toBeNull();
  });

  it("archive plutôt que d'effacer un produit qui a du stock", async () => {
    const service = new ProductService(context);
    await new StockService(context).receiveQuantity({ productId: fixture.cable, quantity: 10 });

    const impact = await service.deletionImpact(fixture.cable);
    expect(impact.removable).toBe(false);
    expect(impact.movements).toBeGreaterThan(0);

    const resultat = await service.remove(fixture.cable);
    expect(resultat.definitive).toBe(false);

    const produit = await new ProductRepository(fixture.db).byId(fixture.cable);
    expect(produit).not.toBeNull();
    expect(produit?.status).toBe('ARCHIVED');
    expect(produit?.deletedAt).not.toBeNull();
  });

  it('archive un produit vendu, pour que le ticket reste lisible', async () => {
    const unitIds = await new StockService(context).receiveUnits({
      productId: fixture.phone,
      units: [{ imei1: imeiSeries(1)[0] }],
    });
    const vente = await new SaleService(context).checkout({
      lines: [{ productId: fixture.phone, unitId: unitIds[0], quantity: 1 }],
      payments: [{ method: 'CASH', amount: 2_950_000 }],
    });

    const service = new ProductService(context);
    expect((await service.deletionImpact(fixture.phone)).saleLines).toBe(1);
    expect((await service.remove(fixture.phone)).definitive).toBe(false);

    // La ligne de vente cite toujours le produit.
    const lignes = await fixture.db.select<{ total: number }>(
      'SELECT COUNT(*) AS total FROM sale_line WHERE sale_id = ? AND product_id = ?',
      [vente.saleId, fixture.phone],
    );
    expect(lignes[0]?.total).toBe(1);
  });

  it('fait disparaître un produit archivé du comptoir', async () => {
    await new ProductService(context).archive(fixture.speaker);
    const page = await new ProductRepository(fixture.db).search({
      shopId: fixture.shopA,
      query: 'JBL',
    });
    expect(page.items).toHaveLength(0);
  });

  it('refuse la suppression sans la permission', async () => {
    const vendeur = await contextFor(fixture.db, fixture.sellerId, { permissions: [] });
    await expect(new ProductService(vendeur).remove(fixture.cable)).rejects.toThrow(
      /Permission requise/,
    );
  });
});
