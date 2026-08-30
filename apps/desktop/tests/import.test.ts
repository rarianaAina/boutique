import { completeImei } from '@boutique/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { ImportService } from '@/core/services/import.service';
import { ProductRepository } from '@/core/db/repositories/product.repository';
import { ProductService } from '@/core/services/catalog.service';
import { UnitRepository } from '@/core/db/repositories/unit.repository';
import { StockRepository } from '@/core/db/repositories/stock.repository';
import { suggestMapping } from '@/core/import/fields';
import { cellToText } from '@/core/import/workbook';
import type { SheetData } from '@/core/import/workbook';
import { contextFor } from './helpers/context';
import { seedFixture, type Fixture } from './helpers/fixtures';
import type { AppContext } from '@/core/services/context';

/** Import Excel (§8) — priorité n°10 des tests (§30). */

const imei = (index: number) => completeImei(`35980100${String(index).padStart(6, '0')}`);

const sheet = (headers: string[], rows: string[][]): SheetData => ({
  name: 'Feuil1',
  headers,
  rows,
});

describe('détection des colonnes', () => {
  it('reconnaît des en-têtes français courants', () => {
    const mapping = suggestMapping([
      'Désignation',
      'Marque',
      'Référence',
      'IMEI',
      'Prix Achat',
      'Prix Vente',
    ]);
    expect(mapping).toEqual({
      0: 'name',
      1: 'brand',
      2: 'sku',
      3: 'imei1',
      4: 'purchasePrice',
      5: 'salePrice',
    });
  });

  it('ne laisse pas « Prix » rafler la colonne « Prix Achat »', () => {
    const mapping = suggestMapping(['SKU', 'Prix Achat', 'Prix Vente']);
    expect(mapping[1]).toBe('purchasePrice');
    expect(mapping[2]).toBe('salePrice');
  });

  it('reconnaît aussi des en-têtes anglais', () => {
    const mapping = suggestMapping(['SKU', 'Name', 'Brand', 'Serial Number', 'Price']);
    expect(mapping[3]).toBe('serial');
    expect(mapping[4]).toBe('salePrice');
  });
});

describe('lecture des cellules', () => {
  it('rend un IMEI numérique sans notation scientifique', () => {
    // Excel stocke un IMEI saisi sans apostrophe comme un nombre.
    expect(cellToText(356920051000007)).toBe('356920051000007');
  });

  it('conserve les décimales des prix', () => {
    expect(cellToText(12.5)).toBe('12.5');
  });

  it('rend une cellule vide comme une chaîne vide', () => {
    expect(cellToText(null)).toBe('');
  });
});

describe('import de produits', () => {
  let fixture: Fixture;
  let context: AppContext;
  let service: ImportService;

  const MAPPING = {
    0: 'sku',
    1: 'name',
    2: 'brand',
    3: 'imei1',
    4: 'purchasePrice',
    5: 'salePrice',
  };

  beforeEach(async () => {
    fixture = await seedFixture();
    context = await contextFor(fixture.db, fixture.adminId);
    service = new ImportService(context);
  });

  it("crée produits et appareils à partir d'un fichier de téléphones", async () => {
    const data = sheet(
      ['Référence', 'Désignation', 'Marque', 'IMEI', 'Prix Achat', 'Prix Vente'],
      [
        ['SAM-A54', 'Samsung Galaxy A54', 'Samsung', imei(1), '900000', '1150000'],
        ['SAM-A54', 'Samsung Galaxy A54', 'Samsung', imei(2), '900000', '1150000'],
        ['XIA-13', 'Xiaomi 13', 'Xiaomi', imei(3), '1200000', '1490000'],
      ],
    );

    const plan = await service.plan(data, MAPPING, 'CREATE_ONLY', 'stock.xlsx');
    expect(plan.report.counts.CREATE).toBe(3);
    expect(plan.report.counts.ERROR).toBe(0);

    const result = await service.apply(plan);
    expect(result.created).toBe(2); // deux produits distincts
    expect(result.unitsCreated).toBe(3); // trois appareils
    expect(result.errors).toBe(0);

    const units = new UnitRepository(fixture.db);
    expect((await units.byIdentifier(imei(1)))?.status).toBe('IN_STOCK');
    const product = await new ProductRepository(fixture.db).bySku('SAM-A54');
    expect(product?.tracking).toBe('IMEI');
    expect(product?.salePrice).toBe(1_150_000);
  });

  it('signale un IMEI invalide sans bloquer les autres lignes', async () => {
    const data = sheet(
      ['Référence', 'Désignation', 'Marque', 'IMEI', 'Prix Achat', 'Prix Vente'],
      [
        ['A', 'Téléphone A', 'X', imei(1), '100', '200'],
        ['B', 'Téléphone B', 'X', '123456789012345', '100', '200'],
        ['C', 'Téléphone C', 'X', imei(3), '100', '200'],
      ],
    );

    const plan = await service.plan(data, MAPPING, 'CREATE_ONLY', 'stock.xlsx');
    expect(plan.report.counts.ERROR).toBe(1);
    expect(plan.report.rows[1]?.problems[0]).toMatch(/clé de contrôle/i);

    const result = await service.apply(plan);
    expect(result.unitsCreated).toBe(2);
    expect(result.errors).toBe(1);
  });

  it("détecte un doublon d'IMEI à l'intérieur du fichier", async () => {
    const data = sheet(
      ['Référence', 'Désignation', 'Marque', 'IMEI', 'Prix Achat', 'Prix Vente'],
      [
        ['A', 'Téléphone A', 'X', imei(1), '100', '200'],
        ['B', 'Téléphone B', 'X', imei(1), '100', '200'],
      ],
    );
    const plan = await service.plan(data, MAPPING, 'CREATE_ONLY', 'stock.xlsx');
    expect(plan.report.rows[1]?.problems[0]).toMatch(/apparaît déjà ligne 2/);
  });

  it('détecte un IMEI déjà présent dans la base', async () => {
    const data = sheet(
      ['Référence', 'Désignation', 'Marque', 'IMEI', 'Prix Achat', 'Prix Vente'],
      [['A', 'Téléphone A', 'X', imei(1), '100', '200']],
    );
    await service.apply(await service.plan(data, MAPPING, 'CREATE_ONLY', 'stock.xlsx'));

    const second = await service.plan(data, MAPPING, 'CREATE_ONLY', 'stock.xlsx');
    expect(second.report.counts.ERROR).toBe(1);
    expect(second.report.rows[0]?.problems[0]).toMatch(/déjà enregistré dans la base/);
  });

  it("n'écrase pas un produit existant en mode « création seule »", async () => {
    const before = await new ProductRepository(fixture.db).bySku('CAB-USBC-1M');
    const data = sheet(
      ['Référence', 'Désignation', 'Marque', 'Quantité', 'Prix Achat', 'Prix Vente'],
      [['CAB-USBC-1M', 'Câble modifié', 'Autre', '5', '1', '99999']],
    );
    const mapping = {
      0: 'sku',
      1: 'name',
      2: 'brand',
      3: 'quantity',
      4: 'purchasePrice',
      5: 'salePrice',
    };

    const plan = await service.plan(data, mapping, 'CREATE_ONLY', 'maj.xlsx');
    expect(plan.report.counts.SKIP).toBe(1);
    await service.apply(plan);

    const after = await new ProductRepository(fixture.db).bySku('CAB-USBC-1M');
    expect(after?.name).toBe(before?.name);
    expect(after?.salePrice).toBe(before?.salePrice);
  });

  it('met à jour un produit existant quand le mode le demande', async () => {
    const data = sheet(
      ['Référence', 'Désignation', 'Marque', 'Quantité', 'Prix Achat', 'Prix Vente'],
      [['CAB-USBC-1M', 'Câble USB-C 1 m renforcé', 'Generic', '25', '4500', '14000']],
    );
    const mapping = {
      0: 'sku',
      1: 'name',
      2: 'brand',
      3: 'quantity',
      4: 'purchasePrice',
      5: 'salePrice',
    };

    const plan = await service.plan(data, mapping, 'CREATE_AND_UPDATE', 'maj.xlsx');
    expect(plan.report.counts.UPDATE).toBe(1);
    const result = await service.apply(plan);
    expect(result.updated).toBe(1);

    const after = await new ProductRepository(fixture.db).bySku('CAB-USBC-1M');
    expect(after?.salePrice).toBe(14_000);
    const level = await new StockRepository(fixture.db).levelOf(fixture.cable, fixture.shopA);
    expect(level.quantity).toBe(25);
  });

  it('refuse un import dont un champ obligatoire est non associé', async () => {
    const data = sheet(['Désignation'], [['Un produit']]);
    const plan = await service.plan(data, { 0: 'name' }, 'CREATE_ONLY', 'incomplet.xlsx');
    expect(plan.report.missingFields.length).toBeGreaterThan(0);
    await expect(service.apply(plan)).rejects.toThrow(/obligatoires/i);
  });

  it('tient un journal ligne à ligne', async () => {
    const data = sheet(
      ['Référence', 'Désignation', 'Marque', 'IMEI', 'Prix Achat', 'Prix Vente'],
      [
        ['A', 'Téléphone A', 'X', imei(1), '100', '200'],
        ['B', 'Téléphone B', 'X', 'pas-un-imei', '100', '200'],
      ],
    );
    const result = await service.apply(
      await service.plan(data, MAPPING, 'CREATE_ONLY', 'journal.xlsx'),
    );

    const rows = await service.rowsOf(result.batchId);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.outcome).toBe('ERROR');
    expect(rows[1]?.message).toBeTruthy();

    const history = await service.history();
    expect(history[0]?.fileName).toBe('journal.xlsx');
    expect(history[0]?.status).toBe('APPLIED');
  });

  describe('annulation', () => {
    it("retire les appareils créés qui n'ont pas bougé", async () => {
      const data = sheet(
        ['Référence', 'Désignation', 'Marque', 'IMEI', 'Prix Achat', 'Prix Vente'],
        [
          ['A', 'Téléphone A', 'X', imei(1), '100', '200'],
          ['A', 'Téléphone A', 'X', imei(2), '100', '200'],
        ],
      );
      const result = await service.apply(
        await service.plan(data, MAPPING, 'CREATE_ONLY', 'erreur.xlsx'),
      );

      const rollback = await service.rollback(result.batchId);
      expect(rollback.removed).toBe(2);
      expect(await new UnitRepository(fixture.db).byIdentifier(imei(1))).toBeNull();
    });

    it('conserve un appareil déjà vendu et le dit', async () => {
      const data = sheet(
        ['Référence', 'Désignation', 'Marque', 'IMEI', 'Prix Achat', 'Prix Vente'],
        [['A', 'Téléphone A', 'X', imei(1), '100', '200']],
      );
      const result = await service.apply(
        await service.plan(data, MAPPING, 'CREATE_ONLY', 'vendu.xlsx'),
      );
      const unit = await new UnitRepository(fixture.db).byIdentifier(imei(1));
      await fixture.db.execute("UPDATE product_unit SET status = 'SOLD' WHERE id = ?", [unit!.id]);

      const rollback = await service.rollback(result.batchId);
      expect(rollback.removed).toBe(0);
      expect(rollback.kept).toBe(1);
      expect(rollback.reasons[0]).toMatch(/SOLD/);
    });
  });
});

/**
 * La référence interne est FACULTATIVE partout — pas seulement à l'import.
 *
 * Ces tests portent sur le service produit, celui qu'emploie le formulaire de
 * création : c'est là que le manque avait subsisté après la première correction
 * de l'import.
 */
describe('référence facultative', () => {
  let fixture: Fixture;
  let context: AppContext;

  beforeEach(async () => {
    fixture = await seedFixture();
    context = await contextFor(fixture.db, fixture.adminId);
  });

  it('crée un produit sans référence, en la dérivant du modèle', async () => {
    const id = await new ProductService(context).create({
      name: 'Housse iPhone 17 Pro Max Silicone',
      brand: 'Generic',
      tracking: 'QUANTITY',
      purchasePrice: 20_000,
      salePrice: 45_000,
    });

    const produit = await new ProductRepository(fixture.db).byId(id);
    expect(produit?.sku).toBe('AUTO-HOUSSE-IPHONE-17-PRO-MAX-SILICONE-GENERIC');
  });

  it('reprend telle quelle une référence fournie', async () => {
    const id = await new ProductService(context).create({
      sku: 'HOU-IP17PM-SIL',
      name: 'Housse',
      tracking: 'QUANTITY',
      purchasePrice: 1,
      salePrice: 2,
    });
    expect((await new ProductRepository(fixture.db).byId(id))?.sku).toBe('HOU-IP17PM-SIL');
  });

  it('suffixe quand deux modèles portent la même désignation', async () => {
    const service = new ProductService(context);
    const commun = {
      name: 'Samsung',
      tracking: 'QUANTITY' as const,
      purchasePrice: 1,
      salePrice: 2,
    };
    const premier = await service.create(commun);
    const second = await service.create(commun);

    const depot = new ProductRepository(fixture.db);
    expect((await depot.byId(premier))?.sku).toBe('AUTO-SAMSUNG');
    expect((await depot.byId(second))?.sku).toBe('AUTO-SAMSUNG-2');
  });

  it('distingue deux modèles par leur capacité et leur couleur', async () => {
    const service = new ProductService(context);
    const noir = await service.create({
      name: 'iPhone 15',
      tracking: 'IMEI',
      purchasePrice: 1,
      salePrice: 2,
      attributes: { capacite: '128 Go', couleur: 'Noir' },
    });
    const bleu = await service.create({
      name: 'iPhone 15',
      tracking: 'IMEI',
      purchasePrice: 1,
      salePrice: 2,
      attributes: { capacite: '256 Go', couleur: 'Bleu' },
    });

    const depot = new ProductRepository(fixture.db);
    expect((await depot.byId(noir))?.sku).toBe('AUTO-IPHONE-15-128-GO-NOIR');
    expect((await depot.byId(bleu))?.sku).toBe('AUTO-IPHONE-15-256-GO-BLEU');
  });

  it('ne renomme pas une fiche existante quand le champ est vidé', async () => {
    const service = new ProductService(context);
    const id = await service.create({
      sku: 'REF-ORIGINE',
      name: 'Chargeur',
      tracking: 'QUANTITY',
      purchasePrice: 1,
      salePrice: 2,
    });

    await service.update(id, {
      sku: '',
      name: 'Chargeur rapide',
      tracking: 'QUANTITY',
      purchasePrice: 1,
      salePrice: 3,
    });

    const produit = await new ProductRepository(fixture.db).byId(id);
    expect(produit?.sku).toBe('REF-ORIGINE');
    expect(produit?.name).toBe('Chargeur rapide');
  });

  it('refuse toujours une référence saisie déjà utilisée', async () => {
    await expect(
      new ProductService(context).create({
        sku: 'CAB-USBC-1M',
        name: 'Doublon',
        tracking: 'QUANTITY',
        purchasePrice: 1,
        salePrice: 2,
      }),
    ).rejects.toThrow(/déjà utilisé/i);
  });
});
