import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { listSheets, readSheet, readWorkbook, type SheetData } from '@/core/import/workbook';
import { suggestMapping } from '@/core/import/fields';
import { ImportService } from '@/core/services/import.service';
import { ProductRepository } from '@/core/db/repositories/product.repository';
import { CategoryRepository } from '@/core/db/repositories/category.repository';
import { SupplierRepository } from '@/core/db/repositories/supplier.repository';
import { StockRepository } from '@/core/db/repositories/stock.repository';
import { UnitRepository } from '@/core/db/repositories/unit.repository';
import { contextFor } from './helpers/context';
import { seedFixture, type Fixture } from './helpers/fixtures';
import type { AppContext } from '@/core/services/context';

/**
 * Import des fichiers RÉELS de la boutique (`examples/`).
 *
 * Ces tests ne portent pas sur des données inventées : ils lisent les classeurs
 * que le client utilise vraiment. C'est le seul moyen de savoir si
 * l'importateur tient devant leurs particularités — références manquantes,
 * colonnes « Étiquettes » et « Emplacement », plusieurs feuilles par fichier,
 * colonne IMEI présente mais vide.
 *
 * Si ces fichiers changent, ces tests le diront.
 */
const DOSSIER = fileURLToPath(new URL('../../../examples', import.meta.url));

const charger = (nom: string) => readWorkbook(readFileSync(`${DOSSIER}/${nom}`));

/**
 * Association d'une feuille, indexée par INTITULÉ de colonne.
 *
 * Les tests ci-dessous ne raisonnent jamais sur une position : le client
 * réorganise ses colonnes et en ajoute (une « Marque » est apparue en cours de
 * route). Figer `mapping[3] === 'color'` reviendrait à casser la suite de tests
 * à chaque fois qu'il déplace une colonne, pour un défaut qui n'existe pas.
 */
function associationParEntete(feuille: SheetData): Record<string, string | null> {
  const mapping = suggestMapping(feuille.headers);
  const resultat: Record<string, string | null> = {};
  feuille.headers.forEach((entete, index) => {
    if (entete.trim() !== '') resultat[entete] = mapping[index] ?? null;
  });
  return resultat;
}

describe('fichiers Excel réels du client', () => {
  let fixture: Fixture;
  let context: AppContext;
  let service: ImportService;

  beforeEach(async () => {
    fixture = await seedFixture();
    context = await contextFor(fixture.db, fixture.adminId);
    service = new ImportService(context);
  });

  it('les sept fichiers sont présents et lisibles', () => {
    const fichiers = readdirSync(DOSSIER).filter((nom) => nom.endsWith('.xlsx'));
    expect(fichiers.length).toBe(7);
    for (const nom of fichiers) {
      expect(listSheets(charger(nom)).length).toBeGreaterThan(0);
    }
  });

  describe('détection des colonnes', () => {
    it("associe toutes les colonnes d'une feuille d'accessoires", () => {
      const association = associationParEntete(readSheet(charger('Housses.xlsx'), 'Housses'));

      expect(association).toMatchObject({
        Nom: 'name',
        'Référence interne': 'sku',
        'Code-barres': 'barcode',
        Fournisseur: 'supplier',
        Emplacement: 'location',
        Etiquettes: 'category',
        'Prix de vente': 'salePrice',
        Quantité: 'quantity',
      });
    });

    it('associe toutes les colonnes de la feuille de téléphones', () => {
      const association = associationParEntete(
        readSheet(charger('Import téléphones pour test.xlsx'), 'IPHONE'),
      );

      // Chaque colonne PRÉSENTE doit trouver son champ. Celles que le client
      // ajoutera plus tard sont couvertes par le test « aucune orpheline ».
      const attendus: Record<string, string> = {
        Marque: 'brand',
        Désignation: 'name',
        Mémoire: 'capacity',
        Couleur: 'color',
        'Batterie %': 'batteryHealth',
        Garantie: 'warranty',
        Cycle: 'cycles',
        Etat: 'condition',
        'Prix de vente': 'salePrice',
        IMEI: 'imei1',
        'Référence interne': 'sku',
        'Code-barres': 'barcode',
        Fournisseurs: 'supplier',
        Emplacement: 'location',
        Etiquettes: 'category',
      };
      for (const [entete, champ] of Object.entries(attendus)) {
        if (entete in association) expect(association[entete], entete).toBe(champ);
      }
    });

    it('ne confond pas « Coût » et « Prix de vente »', () => {
      const association = associationParEntete(
        readSheet(charger('Cache-écrans_hydrogel.xlsx'), 'Film hydrogel'),
      );
      expect(association['Coût']).toBe('purchasePrice');
      expect(association['Prix de vente']).toBe('salePrice');
    });

    it('aucune colonne des fichiers réels ne reste orpheline', () => {
      for (const nom of readdirSync(DOSSIER).filter((f) => f.endsWith('.xlsx'))) {
        const livre = charger(nom);
        for (const info of listSheets(livre)) {
          const feuille = readSheet(livre, info.name);
          if (feuille.headers.length === 0) continue;
          const mapping = suggestMapping(feuille.headers);
          const orphelines = feuille.headers.filter(
            (entete, index) => entete.trim() !== '' && mapping[index] === undefined,
          );
          expect(orphelines, `${nom} / ${info.name}`).toEqual([]);
        }
      }
    });
  });

  describe('accessoires — Housses.xlsx', () => {
    it('importe toutes les lignes, y compris celles sans référence', async () => {
      const feuille = readSheet(charger('Housses.xlsx'), 'Housses');
      const plan = await service.plan(
        feuille,
        suggestMapping(feuille.headers),
        'CREATE_ONLY',
        'Housses.xlsx',
      );

      expect(plan.report.counts.ERROR).toBe(0);
      expect(plan.report.counts.CREATE).toBeGreaterThan(0);

      const resultat = await service.apply(plan);
      expect(resultat.errors).toBe(0);
      expect(resultat.created).toBeGreaterThan(0);
    });

    it("dérive une référence lisible quand le fichier n'en donne pas", async () => {
      const feuille = readSheet(charger('Housses.xlsx'), 'Housses');
      const plan = await service.plan(
        feuille,
        suggestMapping(feuille.headers),
        'CREATE_ONLY',
        'Housses.xlsx',
      );
      const derivee = plan.report.rows.find((ligne) => ligne.skuDerived);
      expect(derivee?.product?.sku).toMatch(/^AUTO-/);
      expect(derivee?.warnings.join(' ')).toMatch(/dérivée du modèle/);
    });

    it('crée la catégorie et le fournisseur lus dans le fichier', async () => {
      const feuille = readSheet(charger('Housses.xlsx'), 'Housses');
      const resultat = await service.apply(
        await service.plan(feuille, suggestMapping(feuille.headers), 'CREATE_ONLY', 'Housses.xlsx'),
      );

      expect(resultat.categoriesCreated).toBe(1);
      expect(resultat.suppliersCreated).toBe(1);

      const categories = await new CategoryRepository(fixture.db).list();
      expect(categories.some((element) => element.name === 'Housses')).toBe(true);
      const fournisseurs = await new SupplierRepository(fixture.db).list({});
      expect(fournisseurs.some((element) => element.code === 'SHAP')).toBe(true);
    });

    it("reprend l'emplacement de stockage dans les caractéristiques", async () => {
      const feuille = readSheet(charger('Housses.xlsx'), 'Housses');
      await service.apply(
        await service.plan(feuille, suggestMapping(feuille.headers), 'CREATE_ONLY', 'Housses.xlsx'),
      );
      const produit = await new ProductRepository(fixture.db).bySku('HOU-IP17PM-SIL');
      expect(produit?.attributes['emplacement']).toBe('DPKNG/Stock');
    });

    it('entre bien les quantités en stock', async () => {
      const feuille = readSheet(charger('Housses.xlsx'), 'Housses');
      await service.apply(
        await service.plan(feuille, suggestMapping(feuille.headers), 'CREATE_ONLY', 'Housses.xlsx'),
      );
      const produit = await new ProductRepository(fixture.db).bySku('HOU-RN15-TR');
      const niveau = await new StockRepository(fixture.db).levelOf(produit!.id, fixture.shopA);
      expect(niveau.quantity).toBe(15);
    });
  });

  describe('téléphones', () => {
    const feuilleTelephones = () =>
      readSheet(charger('Import téléphones pour test.xlsx'), 'IPHONE');

    /**
     * Ces tests DÉRIVENT leurs attentes du contenu du fichier plutôt que de le
     * figer : le client l'édite au fil de ses essais — il y a ajouté une
     * colonne « Marque » et changé le nombre de lignes en cours de route. Ce
     * qui doit rester vrai, c'est le COMPORTEMENT de l'importateur face à ce
     * qu'il y trouve.
     */
    const analyser = async (contexte = context) => {
      const feuille = feuilleTelephones();
      const service = new ImportService(contexte);
      const plan = await service.plan(
        feuille,
        suggestMapping(feuille.headers),
        'CREATE_ONLY',
        'telephones.xlsx',
      );
      return { feuille, service, plan };
    };

    it('traite chaque ligne du fichier', async () => {
      const { feuille, plan } = await analyser();
      expect(plan.report.rows).toHaveLength(feuille.rows.length);
      expect(feuille.rows.length).toBeGreaterThan(0);
    });

    it('crée les produits en suivi par IMEI, jamais par quantité', async () => {
      const { plan } = await analyser();
      for (const ligne of plan.report.rows) {
        if (ligne.outcome === 'ERROR') continue;
        expect(ligne.product?.tracking, `ligne ${ligne.rowNumber}`).toBe('IMEI');
      }
    });

    it("accepte un IMEI valide et entre l'appareil en stock", async () => {
      const { service, plan } = await analyser();
      const valides = plan.report.rows.filter(
        (ligne) => ligne.outcome !== 'ERROR' && ligne.unit?.imei1,
      );
      if (valides.length === 0) return; // Le fichier n'en porte aucun ce jour-là.

      const resultat = await service.apply(plan);
      expect(resultat.unitsCreated).toBe(valides.length);

      const identifiant = valides[0]!.unit!.imei1!;
      const unite = await new UnitRepository(fixture.db).byIdentifier(identifiant);
      expect(unite?.status).toBe('IN_STOCK');
      expect(unite?.shopId).toBe(fixture.shopA);
    });

    it('refuse un IMEI dont la clé de contrôle est fausse, en nommant le chiffre attendu', async () => {
      // Vérifié sur un numéro fabriqué, pour ne pas dépendre du contenu du
      // fichier : le client peut très bien n'y mettre que des IMEI corrects.
      const feuille: SheetData = {
        name: 'IPHONE',
        headers: ['Désignation', 'Prix de vente', 'IMEI'],
        rows: [['Téléphone', '1000000', '983748993829401']],
      };
      const plan = await service.plan(
        feuille,
        suggestMapping(feuille.headers),
        'CREATE_ONLY',
        'faux.xlsx',
      );
      expect(plan.report.counts.ERROR).toBe(1);
      expect(plan.report.rows[0]?.problems.join(' ')).toMatch(/devrait finir par \d/);
    });

    it('accepte le même numéro quand le contrôle strict est levé', async () => {
      const tolerant = await contextFor(fixture.db, fixture.adminId, {
        settings: { strictImeiChecksum: false },
      });
      const feuille: SheetData = {
        name: 'IPHONE',
        headers: ['Désignation', 'Prix de vente', 'IMEI'],
        rows: [['Téléphone', '1000000', '983748993829401']],
      };
      const service = new ImportService(tolerant);
      const plan = await service.plan(
        feuille,
        suggestMapping(feuille.headers),
        'CREATE_ONLY',
        'faux.xlsx',
      );

      expect(plan.report.counts.ERROR).toBe(0);
      // Le doute reste consigné : accepté n'est pas synonyme de sûr.
      expect(plan.report.rows[0]?.warnings.join(' ')).toMatch(/Clé de contrôle/);
      expect((await service.apply(plan)).unitsCreated).toBe(1);
    });

    it("crée le produit sans stock quand la ligne ne porte pas d'IMEI", async () => {
      const feuille: SheetData = {
        name: 'IPHONE',
        headers: ['Désignation', 'Prix de vente', 'IMEI'],
        rows: [['Téléphone à recevoir', '1000000', '']],
      };
      const plan = await service.plan(
        feuille,
        suggestMapping(feuille.headers),
        'CREATE_ONLY',
        'attente.xlsx',
      );

      expect(plan.report.counts.ERROR).toBe(0);
      expect(plan.report.rows[0]?.warnings.join(' ')).toMatch(/Aucun IMEI/);

      const resultat = await service.apply(plan);
      expect(resultat.created).toBe(1);
      expect(resultat.unitsCreated).toBe(0);
    });

    it('conserve les caractéristiques propres aux téléphones', async () => {
      const { feuille, plan } = await analyser();
      const association = associationParEntete(feuille);
      const premiere = plan.report.rows[0];
      expect(premiere).toBeDefined();

      // Chaque colonne présente doit se retrouver dans la ligne analysée.
      for (const [entete, champ] of Object.entries(association)) {
        if (!champ) continue;
        const position = feuille.headers.indexOf(entete);
        const brut = feuille.rows[0]?.[position] ?? '';
        if (brut === '') continue;
        if (champ === 'sku' || champ === 'imei1') continue; // dérivés ou normalisés
        expect(premiere?.values[champ], entete).toBe(brut);
      }
    });

    it('range couleur et capacité en colonnes, pas en attributs libres', async () => {
      const { service, plan } = await analyser();
      const avecVariante = plan.report.rows.find(
        (ligne) => ligne.outcome !== 'ERROR' && (ligne.values['color'] || ligne.values['capacity']),
      );
      if (!avecVariante) return;

      await service.apply(plan);
      const produit = await new ProductRepository(fixture.db).bySku(avecVariante.product!.sku);
      expect(produit?.color).toBe(avecVariante.values['color'] ?? null);
      expect(produit?.capacity).toBe(avecVariante.values['capacity'] ?? null);
      expect(produit?.attributes['couleur']).toBeUndefined();
      expect(produit?.variantGroup).toBeTruthy();
    });

    it("traduit l'état en condition d'appareil", async () => {
      const { plan } = await analyser();
      for (const ligne of plan.report.rows) {
        const etat = ligne.values['condition'];
        if (!etat) continue;
        const attendu = /scell|neuf/i.test(etat)
          ? 'NEW'
          : /recondition/i.test(etat)
            ? 'REFURBISHED'
            : 'USED';
        expect(ligne.condition, etat).toBe(attendu);
      }
    });
  });

  describe('colonne marque', () => {
    it('reconnaît une colonne « Marque » ajoutée au fichier', () => {
      // Les classeurs actuels n'en ont pas ; celui-ci anticipe son ajout.
      const mapping = suggestMapping([
        'Nom',
        'Marque',
        'Référence interne',
        'Couleur',
        'Mémoire',
        'Prix de vente',
        'Quantité',
      ]);
      expect(mapping).toMatchObject({ 1: 'brand', 3: 'color', 4: 'capacity' });
    });

    it('range la marque, la couleur et la capacité dans leurs colonnes', async () => {
      const feuille: SheetData = {
        name: 'Smartphones',
        headers: ['Nom', 'Marque', 'Couleur', 'Mémoire', 'Prix de vente', 'IMEI'],
        rows: [
          ['iPhone 17 Pro Max', 'Apple', 'Rouge', '256 Go', '3800000', ''],
          ['iPhone 17 Pro Max', 'Apple', 'Noir', '128 Go', '3400000', ''],
          ['Galaxy S26 Ultra', 'Samsung', 'Titane', '512 Go', '4100000', ''],
        ],
      };
      const plan = await service.plan(
        feuille,
        suggestMapping(feuille.headers),
        'CREATE_ONLY',
        'marques.xlsx',
      );
      expect(plan.report.counts.ERROR).toBe(0);
      await service.apply(plan);

      const depot = new ProductRepository(fixture.db);
      const page = await depot.search({ shopId: fixture.shopA, query: 'iphone 17' });
      expect(page.items).toHaveLength(2);

      const rouge = page.items.find((item) => item.color === 'Rouge');
      expect(rouge?.brand).toBe('Apple');
      expect(rouge?.capacity).toBe('256 Go');
      expect(rouge?.salePrice).toBe(3_800_000);
      // Les deux iPhone partagent leur modèle, le Samsung non.
      const noir = page.items.find((item) => item.color === 'Noir');
      expect(rouge?.variantGroup).toBe(noir?.variantGroup);

      const samsung = await depot.search({ shopId: fixture.shopA, query: 'galaxy s26' });
      expect(samsung.items[0]?.variantGroup).not.toBe(rouge?.variantGroup);
    });

    it('permet de filtrer le catalogue par marque', async () => {
      const feuille: SheetData = {
        name: 'Smartphones',
        headers: ['Nom', 'Marque', 'Prix de vente', 'Quantité'],
        rows: [
          ['Coque A', 'Apple', '45000', '10'],
          ['Coque B', 'Samsung', '35000', '10'],
        ],
      };
      await service.apply(
        await service.plan(feuille, suggestMapping(feuille.headers), 'CREATE_ONLY', 'm.xlsx'),
      );

      const depot = new ProductRepository(fixture.db);
      expect((await depot.brands()).includes('Apple')).toBe(true);
      const page = await depot.search({ shopId: fixture.shopA, brand: 'Samsung' });
      expect(page.items.every((item) => item.brand === 'Samsung')).toBe(true);
    });
  });

  describe('classeurs à plusieurs feuilles', () => {
    it('importe les trois feuilles de Boitiers_et_câbles sans conflit', async () => {
      const livre = charger('Boitiers_et_câbles.xlsx');
      let crees = 0;
      let erreurs = 0;

      for (const info of listSheets(livre)) {
        const feuille = readSheet(livre, info.name);
        const resultat = await service.apply(
          await service.plan(
            feuille,
            suggestMapping(feuille.headers),
            'CREATE_ONLY',
            'Boitiers_et_câbles.xlsx',
          ),
        );
        crees += resultat.created;
        erreurs += resultat.errors;
      }

      expect(erreurs).toBe(0);
      expect(crees).toBeGreaterThanOrEqual(24);

      // Chaque feuille apporte sa catégorie.
      const categories = await new CategoryRepository(fixture.db).list();
      const noms = categories.map((element) => element.name);
      expect(noms).toContain('Boitiers et câbles');
      expect(noms).toContain('Powerbank');
    });
  });

  describe('lignes incomplètes', () => {
    it('rejette les lignes sans prix de vente, et elles seules', async () => {
      const livre = charger('Ecouteurs_Micro_Camera_Casque_Stabilisateurs.xlsx');
      const feuille = readSheet(livre, 'Casque');
      const plan = await service.plan(
        feuille,
        suggestMapping(feuille.headers),
        'CREATE_ONLY',
        'casques.xlsx',
      );

      const rejetees = plan.report.rows.filter((ligne) => ligne.outcome === 'ERROR');
      expect(rejetees.length).toBeGreaterThan(0);
      for (const ligne of rejetees) {
        expect(ligne.problems.join(' ')).toMatch(/[Pp]rix de vente/);
      }
      // Les lignes complètes passent malgré tout.
      expect(plan.report.counts.CREATE).toBeGreaterThan(0);
    });
  });

  describe("l'ensemble du catalogue", () => {
    it('importe les sept fichiers, toutes feuilles, sans erreur technique', async () => {
      let total = 0;
      let crees = 0;
      let erreurs = 0;
      const motifs = new Set<string>();

      for (const nom of readdirSync(DOSSIER).filter((f) => f.endsWith('.xlsx'))) {
        const livre = charger(nom);
        for (const info of listSheets(livre)) {
          const feuille = readSheet(livre, info.name);
          if (feuille.rows.length === 0) continue;
          const plan = await service.plan(
            feuille,
            suggestMapping(feuille.headers),
            'CREATE_AND_UPDATE',
            nom,
          );
          expect(plan.report.missingFields, `${nom} / ${info.name}`).toEqual([]);
          total += plan.report.rows.length;

          const resultat = await service.apply(plan);
          crees += resultat.created;
          erreurs += resultat.errors;
          for (const ligne of plan.report.rows) {
            for (const probleme of ligne.problems) motifs.add(probleme.replace(/«[^»]*»/, '«…»'));
          }
        }
      }

      // Le nombre de lignes n'est pas figé : ces fichiers vivent. Ce qui doit
      // rester vrai, c'est que l'importateur les traite tous, et que les seuls
      // refus portent sur des données réellement manquantes ou fausses.
      expect(total).toBeGreaterThan(100);
      expect(crees).toBeGreaterThan(90);
      for (const motif of motifs) {
        expect(motif).toMatch(/[Pp]rix de vente|Clé de contrôle/);
      }
      expect(erreurs).toBeLessThan(total / 5);
    });
  });
});
