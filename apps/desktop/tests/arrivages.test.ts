import { beforeEach, describe, expect, it } from 'vitest';
import { suggestMapping } from '@/core/import/fields';
import type { SheetData } from '@/core/import/workbook';
import { ImportService } from '@/core/services/import.service';
import { StockService } from '@/core/services/stock.service';
import { ReportService } from '@/core/services/report.service';
import { StockRepository } from '@/core/db/repositories/stock.repository';
import { contextFor } from './helpers/context';
import { imeiSeries, seedFixture, type Fixture } from './helpers/fixtures';
import type { AppContext } from '@/core/services/context';

/**
 * Traçabilité des arrivages.
 *
 * LA QUESTION POSÉE : « qu'est-ce qui est arrivé le 12 mars ? ». Le journal des
 * mouvements ne sait pas y répondre — un import de deux cents téléphones y
 * occupe deux cents lignes, et la livraison disparaît derrière ses grains.
 *
 * Un arrivage se reconnaît à son ORIGINE et à son JOUR. Ces deux informations
 * étaient déjà écrites dans le journal, à chaque entrée ; il ne manquait que
 * de savoir les lire ensemble.
 */

const FEUILLE: SheetData = {
  name: 'Housses',
  headers: ['Marque', 'Modèle', 'Prix de vente', 'Quantité', 'Coût'],
  rows: [
    ['Samsung', 'Iphone 17 Pro Max', '45000', '10', '30000'],
    ['Redmi', 'Redmi Note 15', '20000', '15', '12000'],
  ],
};

describe('arrivages', () => {
  let fixture: Fixture;
  let context: AppContext;
  let stock: StockRepository;

  beforeEach(async () => {
    fixture = await seedFixture();
    context = await contextFor(fixture.db, fixture.adminId);
    stock = new StockRepository(fixture.db);
  });

  const importer = async () => {
    const service = new ImportService(context);
    return service.apply(
      await service.plan(FEUILLE, suggestMapping(FEUILLE.headers), 'CREATE_ONLY', 'livraison.xlsx'),
    );
  };

  describe('regroupement', () => {
    it('réunit en UN arrivage les lignes d’un même import', async () => {
      // Deux produits, une seule livraison : c'est une ligne, pas deux.
      await importer();
      const arrivages = await stock.arrivals({ shopId: fixture.shopA });

      expect(arrivages).toHaveLength(1);
      expect(arrivages[0]?.source).toBe('IMPORT');
      expect(arrivages[0]?.products).toBe(2);
      expect(arrivages[0]?.units).toBe(25);
    });

    it('porte le document d’origine, pour qu’on sache d’où vient la marchandise', async () => {
      await importer();
      const arrivages = await stock.arrivals({ shopId: fixture.shopA });
      expect(arrivages[0]?.label).toBe('livraison.xlsx');
      expect(arrivages[0]?.userLabel).toBe('Rakoto Admin');
    });

    it('totalise le coût de la livraison', async () => {
      await importer();
      const arrivages = await stock.arrivals({ shopId: fixture.shopA });
      // 10 × 30 000 + 15 × 12 000
      expect(arrivages[0]?.cost).toBe(480_000);
    });

    it('sépare deux imports distincts du même jour', async () => {
      // Même origine, même jour, mais deux fichiers : deux livraisons, et l'on
      // doit pouvoir dire laquelle a apporté quoi.
      await importer();
      const service = new ImportService(context);
      await service.apply(
        await service.plan(
          { ...FEUILLE, rows: [['Anker', 'Powerbank', '90000', '4', '70000']] },
          suggestMapping(FEUILLE.headers),
          'CREATE_ONLY',
          'seconde-livraison.xlsx',
        ),
      );

      const arrivages = await stock.arrivals({ shopId: fixture.shopA });
      expect(arrivages).toHaveLength(2);
      expect(arrivages.map((a) => a.label).sort()).toEqual([
        'livraison.xlsx',
        'seconde-livraison.xlsx',
      ]);
    });

    it('compte à part les appareils identifiés', async () => {
      // Ce sont eux qu'on retrouve un par un, IMEI en main.
      await new StockService(context).receiveUnits({
        productId: fixture.phone,
        units: imeiSeries(2).map((value) => ({ imei1: value })),
      });
      const arrivages = await stock.arrivals({ shopId: fixture.shopA });
      const reception = arrivages.find((a) => a.identified > 0);
      expect(reception?.identified).toBe(2);
    });

    it('ne compte QUE les entrées', async () => {
      // Une vente et une correction à la baisse sont des sorties : les compter
      // gonflerait un chiffre censé dire « ce que j'ai reçu ».
      await importer();
      const stocks = new StockService(context);
      // Il faut du stock avant de pouvoir en retirer.
      await stocks.receiveQuantity({ productId: fixture.cable, quantity: 10, unitCost: 5_000 });
      await stocks.adjust({ productId: fixture.cable, quantity: -3, note: 'Casse' });

      const arrivages = await stock.arrivals({ shopId: fixture.shopA });
      // Toutes les lignes sont des entrées, et la sortie de trois câbles
      // n'apparaît nulle part — pas même en négatif.
      expect(arrivages.every((a) => a.units > 0)).toBe(true);
      const total = arrivages.reduce((somme, a) => somme + a.units, 0);
      expect(total).toBe(35); // 25 importés + 10 reçus, la casse non comptée
    });

    it('se filtre par origine', async () => {
      await importer();
      await new StockService(context).adjust({
        productId: fixture.cable,
        quantity: 5,
        note: 'Retrouvé',
      });

      expect(await stock.arrivals({ shopId: fixture.shopA, source: 'IMPORT' })).toHaveLength(1);
      const manuels = await stock.arrivals({ shopId: fixture.shopA, source: 'IMPORT' });
      expect(manuels.every((a) => a.source === 'IMPORT')).toBe(true);
    });

    it('ne montre pas les arrivages d’une autre boutique', async () => {
      await importer();
      expect(await stock.arrivals({ shopId: fixture.shopB })).toHaveLength(0);
    });
  });

  describe('bornes de dates', () => {
    it('retient une période qui contient la livraison', async () => {
      await importer();
      const aujourdhui = new Date().toISOString().slice(0, 10);
      const trouves = await stock.arrivals({
        shopId: fixture.shopA,
        from: `${aujourdhui}T00:00:00.000Z`,
        to: `${aujourdhui}T23:59:59.999Z`,
      });
      expect(trouves.length).toBeGreaterThan(0);
    });

    it('écarte une période qui ne la contient pas', async () => {
      await importer();
      const trouves = await stock.arrivals({
        shopId: fixture.shopA,
        from: '2020-01-01T00:00:00.000Z',
        to: '2020-01-02T00:00:00.000Z',
      });
      expect(trouves).toHaveLength(0);
    });
  });

  describe('détail d’un arrivage', () => {
    it('rend les lignes, avec leur coût unitaire', async () => {
      const resultat = await importer();
      expect(resultat.errors).toBe(0);

      const arrivage = (await stock.arrivals({ shopId: fixture.shopA }))[0]!;
      const lignes = await stock.arrivalDetail(arrivage.source, arrivage.sourceId, arrivage.day);

      expect(lignes).toHaveLength(2);
      const housse = lignes.find((ligne) => ligne.productName.includes('Iphone 17'));
      expect(housse?.quantity).toBe(10);
      expect(housse?.unitCost).toBe(30_000);
    });

    it('rend l’IMEI de chaque appareil identifié', async () => {
      // C'est ce qu'on vient chercher quand un client rapporte un téléphone et
      // qu'il faut savoir de quel arrivage il vient.
      const attendu = imeiSeries(1)[0]!;
      await new StockService(context).receiveUnits({
        productId: fixture.phone,
        units: [{ imei1: attendu }],
      });
      const arrivage = (await stock.arrivals({ shopId: fixture.shopA }))[0]!;
      const lignes = await stock.arrivalDetail(arrivage.source, arrivage.sourceId, arrivage.day);
      expect(lignes[0]?.identifier).toBe(attendu);
    });

    it('ne mêle pas deux livraisons de même origine', async () => {
      await importer();
      const service = new ImportService(context);
      await service.apply(
        await service.plan(
          { ...FEUILLE, rows: [['Anker', 'Powerbank', '90000', '4', '70000']] },
          suggestMapping(FEUILLE.headers),
          'CREATE_ONLY',
          'seconde-livraison.xlsx',
        ),
      );

      const arrivages = await stock.arrivals({ shopId: fixture.shopA });
      for (const arrivage of arrivages) {
        const lignes = await stock.arrivalDetail(arrivage.source, arrivage.sourceId, arrivage.day);
        expect(lignes.length).toBe(arrivage.products);
      }
    });
  });

  describe('tableau de bord', () => {
    it('compte les entrées de la période et leur coût', async () => {
      await importer();
      const rapport = new ReportService(fixture.db, fixture.shopA);
      const chiffres = await rapport.dashboard(3, ReportService.today());

      expect(chiffres.arrivalsUnits).toBe(25);
      expect(chiffres.arrivalsCost).toBe(480_000);
    });

    it('rend le chiffre d’affaires jour par jour, pour la courbe', async () => {
      const rapport = new ReportService(fixture.db, fixture.shopA);
      const chiffres = await rapport.dashboard(3, ReportService.thisMonth());
      expect(Array.isArray(chiffres.byDay)).toBe(true);
    });

    it('ne compte pas les entrées hors de la période', async () => {
      await importer();
      const rapport = new ReportService(fixture.db, fixture.shopA);
      const chiffres = await rapport.dashboard(3, {
        from: '2020-01-01T00:00:00.000Z',
        to: '2020-01-02T00:00:00.000Z',
      });
      expect(chiffres.arrivalsUnits).toBe(0);
      expect(chiffres.arrivalsCost).toBe(0);
    });
  });
});
