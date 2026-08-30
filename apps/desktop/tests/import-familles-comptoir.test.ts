import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { listSheets, readSheet, readWorkbook, type SheetData } from '@/core/import/workbook';
import { suggestMapping } from '@/core/import/fields';
import { FAMILLES, devinerFamille } from '@/core/import/familles';
import { ImportService } from '@/core/services/import.service';
import { ProductRepository } from '@/core/db/repositories/product.repository';
import { CategoryRepository } from '@/core/db/repositories/category.repository';
import { axeSeparant, filtrer, valeursDe, SANS_VALEUR } from '@/core/catalogue/facettes';
import { contextFor } from './helpers/context';
import { seedFixture, type Fixture } from './helpers/fixtures';
import type { AppContext } from '@/core/services/context';

/**
 * Famille d'import, composition des désignations, et parcours au comptoir.
 *
 * Ces trois sujets tiennent dans un même fichier parce qu'ils décrivent une
 * seule chaîne : ce que le client range dans son classeur, ce que
 * l'importateur en fait, et ce que le vendeur retrouve à l'écran. Les vérifier
 * séparément laisserait passer les ruptures entre les maillons.
 */
const DOSSIER = fileURLToPath(new URL('../../../examples', import.meta.url));
const charger = (nom: string) => readWorkbook(readFileSync(`${DOSSIER}/${nom}`));

describe('lecture des classeurs', () => {
  /**
   * Ce test protège une seconde de patience contre une demi-minute d'attente.
   *
   * Les classeurs du client déclarent `A1:L1048576` parce qu'un format a été
   * appliqué à des colonnes entières. Sans resserrement de la plage, chaque
   * lecture de feuille parcourt un million de lignes vides : huit secondes pour
   * en lire trois, et une application qui paraît figée à l'ouverture.
   */
  it('ramène la plage déclarée aux lignes réellement remplies', () => {
    const livre = charger('Boitiers_et_câbles.xlsx');
    for (const info of listSheets(livre)) {
      expect(info.rows, info.name).toBeLessThan(100);
      expect(readSheet(livre, info.name).rows.length, info.name).toBeLessThan(100);
    }
  });

  it('lit tout le dossier en moins de deux secondes', () => {
    const debut = Date.now();
    for (const nom of [
      'Boitiers_et_câbles.xlsx',
      'Cache écrans.xlsx',
      'Housses.xlsx',
      'Montres_connectés.xlsx',
    ]) {
      const livre = charger(nom);
      for (const info of listSheets(livre)) readSheet(livre, info.name);
    }
    expect(Date.now() - debut).toBeLessThan(2000);
  });

  it('détoure les intitulés de colonnes entourés d’espaces', () => {
    const feuille = readSheet(charger('Housses.xlsx'), 'Housses');
    for (const entete of feuille.headers) expect(entete).toBe(entete.trim());
  });
});

describe('familles de produits', () => {
  it('devine la famille du nom de la feuille', () => {
    expect(devinerFamille('Boitiers')?.code).toBe('boitiers');
    expect(devinerFamille('Câbles')?.code).toBe('cables');
    expect(devinerFamille('Powerbank')?.code).toBe('powerbank');
    expect(devinerFamille('Verre trempé')?.code).toBe('cache-ecrans');
    expect(devinerFamille('Housses')?.code).toBe('housses');
    expect(devinerFamille('IPHONE')?.code).toBe('smartphones');
    expect(devinerFamille('Montres connectés')?.code).toBe('montres');
  });

  it("préfère l'indice le plus long", () => {
    // « batterie externe » doit l'emporter sur « batterie », et « cache
    // ecran » sur « ecran » : sans cela, une powerbank finirait en accessoire.
    expect(devinerFamille('Batterie externe')?.code).toBe('powerbank');
    expect(devinerFamille('Cache écrans')?.code).toBe('cache-ecrans');
  });

  it('ne devine rien plutôt que de deviner mal', () => {
    expect(devinerFamille('Feuil1')).toBeNull();
    expect(devinerFamille('')).toBeNull();
  });

  it('couvre chaque feuille des classeurs réels', () => {
    for (const nom of ['Boitiers_et_câbles.xlsx', 'Cache écrans.xlsx', 'Housses.xlsx']) {
      const livre = charger(nom);
      for (const info of listSheets(livre)) {
        expect(devinerFamille(info.name, nom), `${nom} / ${info.name}`).not.toBeNull();
      }
    }
  });

  it('déclare un mode de suivi cohérent pour chaque famille', () => {
    for (const famille of FAMILLES) {
      expect(['IMEI', 'SERIAL', 'QUANTITY']).toContain(famille.tracking);
      expect(famille.label.trim()).not.toBe('');
    }
    expect(FAMILLES.find((f) => f.code === 'smartphones')?.tracking).toBe('IMEI');
    expect(FAMILLES.find((f) => f.code === 'cables')?.tracking).toBe('QUANTITY');
  });
});

describe('import', () => {
  let fixture: Fixture;
  let context: AppContext;
  let service: ImportService;

  beforeEach(async () => {
    fixture = await seedFixture();
    context = await contextFor(fixture.db, fixture.adminId);
    service = new ImportService(context);
  });

  const importer = async (feuille: SheetData, famille?: string) =>
    service.plan(feuille, suggestMapping(feuille.headers), 'CREATE_ONLY', 'test.xlsx', famille);

  describe('désignation composée', () => {
    it('compose le nom à partir de la marque et du modèle', async () => {
      const plan = await importer({
        name: 'Housses',
        headers: ['Marque', 'Modèle', 'Couleur', 'Prix de vente', 'Quantité'],
        rows: [['Samsung', 'Iphone 17 Pro Max', 'Rouge', '45000', '10']],
      });
      expect(plan.report.counts.ERROR).toBe(0);
      // La couleur reste HORS du nom : c'est un axe de variante, affiché à part.
      expect(plan.report.rows[0]?.product?.name).toBe('Samsung Iphone 17 Pro Max');
    });

    it('ajoute le qualificatif qui distingue deux articles de même marque', async () => {
      const plan = await importer({
        name: 'Boitiers',
        headers: ['Marque', 'Modèle', 'Puissance', 'Prix de vente', 'Quantité'],
        rows: [
          ['Samsung', '', '25W', '35000', '5'],
          ['Samsung', '', '45W', '45000', '5'],
        ],
      });
      expect(plan.report.counts.ERROR).toBe(0);
      const noms = plan.report.rows.map((ligne) => ligne.product?.name);
      expect(noms).toEqual(['Samsung 25W', 'Samsung 45W']);
      // Deux noms distincts, donc deux références dérivées distinctes : sans
      // cela le second chargeur écraserait le premier.
      const references = new Set(plan.report.rows.map((ligne) => ligne.product?.sku));
      expect(references.size).toBe(2);
    });

    it('traduit « Oui » et « Non » par le libellé de la colonne', async () => {
      const plan = await importer({
        name: 'Câbles',
        headers: ['Marque', 'Modèle', 'Avec Boitier', 'Prix de vente', 'Quantité'],
        rows: [
          ['Samsung', 'C to C', 'Oui', '20000', '15'],
          ['Samsung', 'C to C', 'Non', '15000', '15'],
        ],
      });
      expect(plan.report.rows[0]?.product?.name).toBe('Samsung C to C avec boîtier');
      // « Non » ne s'écrit pas : un câble sans boîtier est simplement un câble.
      expect(plan.report.rows[1]?.product?.name).toBe('Samsung C to C');
    });

    it('ne répète pas une marque déjà contenue dans le modèle', async () => {
      const plan = await importer({
        name: 'Cache-écrans',
        headers: ['Marque', 'Modèle', 'Type', 'Prix de vente', 'Quantité'],
        rows: [['Verre', 'Verre', 'Verre', '15000', '3']],
      });
      expect(plan.report.rows[0]?.product?.name).toBe('Verre');
    });

    it('refuse la ligne qui ne nomme rien du tout', async () => {
      const plan = await importer({
        name: 'Vide',
        headers: ['Marque', 'Modèle', 'Prix de vente', 'Quantité'],
        rows: [['', '', '15000', '3']],
      });
      expect(plan.report.counts.ERROR).toBe(1);
      expect(plan.report.rows[0]?.problems.join(' ')).toMatch(/ne nomme aucun produit/);
    });

    it('laisse la désignation du fichier telle quelle quand elle existe', async () => {
      const plan = await importer({
        name: 'IPHONE',
        headers: ['Marque', 'Désignation', 'Prix de vente', 'IMEI'],
        rows: [['Oppo', 'Oppo A73', '1300000', '']],
      });
      expect(plan.report.rows[0]?.product?.name).toBe('Oppo A73');
    });
  });

  describe('famille choisie avant l’import', () => {
    const feuille: SheetData = {
      name: 'Feuil1',
      headers: ['Marque', 'Modèle', 'Etiquettes', 'Prix de vente', 'Quantité'],
      rows: [['Samsung', 'C to C', 'Divers', '20000', '15']],
    };

    it('impose sa catégorie à la place de la colonne du fichier', async () => {
      const plan = await importer(feuille, 'cables');
      expect(plan.famille).toBe('cables');
      expect(plan.report.rows[0]?.categoryLabel).toBe('Câbles');

      await service.apply(plan);
      const noms = (await new CategoryRepository(fixture.db).list()).map((c) => c.name);
      expect(noms).toContain('Câbles');
      expect(noms).not.toContain('Divers');
    });

    it('impose son mode de suivi', async () => {
      // Le fichier ne porte aucune colonne d'identifiant : sans la famille, ces
      // téléphones entreraient en suivi par quantité et n'accepteraient jamais
      // d'IMEI.
      const plan = await importer(feuille, 'smartphones');
      expect(plan.report.rows[0]?.product?.tracking).toBe('IMEI');
    });

    it('laisse le fichier décider quand aucune famille n’est choisie', async () => {
      const plan = await importer(feuille);
      expect(plan.famille).toBeNull();
      expect(plan.report.rows[0]?.categoryLabel).toBe('Divers');
      expect(plan.report.rows[0]?.product?.tracking).toBe('QUANTITY');
    });
  });

  describe('colonne coût', () => {
    it("lit « Coût » comme prix d'achat sur toutes les feuilles qui en portent", () => {
      const livre = charger('Boitiers_et_câbles.xlsx');
      for (const info of listSheets(livre)) {
        const feuille = readSheet(livre, info.name);
        const position = feuille.headers.findIndex((entete) => /co[ûu]t/i.test(entete));
        if (position < 0) continue;
        expect(suggestMapping(feuille.headers)[position], info.name).toBe('purchasePrice');
      }
    });

    it('range le coût en prix d’achat et le prix de vente séparément', async () => {
      const plan = await importer({
        name: 'Boitiers',
        headers: ['Marque', 'Modèle', 'Prix de vente', 'Quantité', 'Coût'],
        rows: [['Samsung', 'PD', '45000', '15', '40000']],
      });
      await service.apply(plan);
      const produit = plan.report.rows[0]?.product;
      expect(produit?.salePrice).toBe(45_000);
      expect(produit?.purchasePrice).toBe(40_000);
    });
  });

  describe('parcours au comptoir', () => {
    /**
     * Le scénario décrit par le client, de bout en bout : on importe la vraie
     * feuille de cache-écrans, puis on parcourt le catalogue comme un vendeur.
     */
    it('descend cache-écrans → type → appareil jusqu’aux articles', async () => {
      const feuille = readSheet(charger('Cache écrans.xlsx'), 'Verre trempé');
      await service.apply(
        await service.plan(
          feuille,
          suggestMapping(feuille.headers),
          'CREATE_AND_UPDATE',
          'Cache écrans.xlsx',
          'cache-ecrans',
        ),
      );

      const categories = await new CategoryRepository(fixture.db).list();
      const rayon = categories.find((element) => element.name === 'Cache-écrans');
      expect(rayon).toBeDefined();

      const depot = new ProductRepository(fixture.db);
      const comptes = await depot.countByCategory();
      expect(comptes.get(rayon!.id)).toBeGreaterThan(0);

      const articles = (await depot.search({ shopId: fixture.shopA, categoryId: rayon!.id })).items;

      // Premier écran : le type.
      const premier = axeSeparant(articles, []);
      expect(premier?.cle).toBe('type');
      expect(valeursDe(articles, premier!)).toEqual(['Hydrogel', 'Verre']);

      // On choisit « Hydrogel ».
      const hydrogel = filtrer(articles, [{ axe: premier!, valeur: 'Hydrogel' }]);
      expect(hydrogel.length).toBeGreaterThan(0);
      expect(hydrogel.every((produit) => produit.attributes['type'] === 'Hydrogel')).toBe(true);

      // Écran suivant : l'appareil visé, que ces fichiers rangent en « Marque ».
      const second = axeSeparant(hydrogel, ['type']);
      if (second) expect(second.cle).not.toBe('type');
    });

    it("s'arrête d'un cran dès qu'un seul article reste distinguable", async () => {
      const feuille = readSheet(charger('Housses.xlsx'), 'Housses');
      await service.apply(
        await service.plan(
          feuille,
          suggestMapping(feuille.headers),
          'CREATE_ONLY',
          'Housses.xlsx',
          'housses',
        ),
      );
      const rayon = (await new CategoryRepository(fixture.db).list()).find(
        (element) => element.name === 'Housses',
      );
      const depot = new ProductRepository(fixture.db);
      const articles = (await depot.search({ shopId: fixture.shopA, categoryId: rayon!.id })).items;

      // Deux housses de marques différentes : un seul écran suffit, et il ne
      // doit surtout pas y en avoir un par caractéristique.
      let etapes = 0;
      let lot = articles;
      const utilises: string[] = [];
      while (lot.length > 1) {
        const axe = axeSeparant(lot, utilises);
        if (!axe) break;
        utilises.push(axe.cle);
        lot = filtrer(lot, [{ axe, valeur: valeursDe(lot, axe)[0]! }]);
        etapes += 1;
      }
      expect(etapes).toBeLessThanOrEqual(2);
    });
  });
});

describe('critères de descente', () => {
  const article = (valeurs: Partial<Record<string, string>>, attributs: Record<string, string>) =>
    ({
      id: Math.random().toString(36),
      brand: valeurs['brand'] ?? null,
      color: valeurs['color'] ?? null,
      capacity: valeurs['capacity'] ?? null,
      attributes: attributs,
    }) as never;

  it('ignore un critère que tous les articles partagent', () => {
    const lot = [
      article({ brand: 'Apple' }, { type: 'Verre' }),
      article({ brand: 'Apple' }, { type: 'Verre' }),
    ];
    expect(axeSeparant(lot, [])).toBeNull();
  });

  it('place les articles sans valeur en fin de liste', () => {
    const lot = [
      article({}, { type: 'Verre' }),
      article({}, {}),
      article({}, { type: 'Hydrogel' }),
    ];
    const axe = axeSeparant(lot, [])!;
    expect(valeursDe(lot, axe)).toEqual(['Hydrogel', 'Verre', SANS_VALEUR]);
  });

  it('lit la couleur dans sa colonne avant les caractéristiques libres', () => {
    const lot = [
      article({ color: ' Rouge ' }, { couleur: 'Bleu' }),
      article({ color: 'Noir' }, {}),
    ];
    const axe = axeSeparant(lot, [])!;
    expect(axe.cle).toBe('couleur');
    expect(valeursDe(lot, axe)).toEqual(['Noir', 'Rouge']);
  });
});
