import { beforeEach, describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@boutique/shared';
import {
  PortabiliteService,
  TABLES_EXPORTEES,
  VERSION_STRUCTURE,
  type Archive,
} from '@/core/services/portabilite.service';
import { SaleService } from '@/core/services/sale.service';
import { StockService } from '@/core/services/stock.service';
import { AuthService } from '@/core/services/auth.service';
import { SetupService } from '@/core/services/setup.service';
import { POSTE_KEYS, SettingRepository } from '@/core/db/repositories/setting.repository';
import { createTestDb, type TestExecutor } from './helpers/sqlite-executor';
import { contextFor } from './helpers/context';
import { imeiSeries, seedFixture, type Fixture } from './helpers/fixtures';
import type { AppContext } from '@/core/services/context';

/**
 * Emporter un commerce d'une base à l'autre.
 *
 * TROIS TRAJETS : d'un poste vers un autre, du poste vers l'offre en ligne, et
 * l'inverse. L'épreuve qui compte est l'ALLER-RETOUR : exporter, importer dans
 * une base neuve, et retrouver exactement ce qu'on avait. Une migration ne se
 * refait pas, et une ligne perdue ne se remarque que des mois plus tard.
 */

/** Toutes les lignes d'une table, dans un ordre stable, pour comparer. */
async function contenu(db: TestExecutor, table: string): Promise<string> {
  const rows = await db.select<Record<string, unknown>>(`SELECT * FROM ${table}`);
  return JSON.stringify(
    rows
      .map((row) =>
        Object.keys(row)
          .sort()
          .map((colonne) => [colonne, row[colonne]]),
      )
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
}

/** Une boutique qui a vraiment vécu : des ventes, du stock, des appareils. */
async function commerceGarni(): Promise<{ fixture: Fixture; context: AppContext }> {
  const fixture = await seedFixture();
  const context = await contextFor(fixture.db, fixture.adminId);

  const stocks = new StockService(context);
  await stocks.receiveQuantity({ productId: fixture.cable, quantity: 40, unitCost: 5_000 });
  const [unite] = await stocks.receiveUnits({
    productId: fixture.phone,
    units: imeiSeries(3).map((value) => ({ imei1: value })),
  });

  await new SaleService(context).checkout({
    lines: [{ productId: fixture.cable, quantity: 2, unitPrice: 12_000 }],
    payments: [{ method: 'CASH', amount: 24_000 }],
  });
  await new SaleService(context).checkout({
    lines: [{ productId: fixture.phone, unitId: unite, quantity: 1, unitPrice: 1_400_000 }],
    payments: [{ method: 'CASH', amount: 1_400_000 }],
  });

  return { fixture, context };
}

describe('archive produite', () => {
  let fixture: Fixture;
  let context: AppContext;

  beforeEach(async () => {
    ({ fixture, context } = await commerceGarni());
  });

  it('porte un manifeste qui dit ce qu’elle contient', async () => {
    const archive = await new PortabiliteService(context).exporter();

    expect(archive.manifeste.format).toBe(1);
    expect(archive.manifeste.structure).toBe(VERSION_STRUCTURE);
    expect(archive.manifeste.origine).toBe('poste');
    expect(archive.manifeste.boutique?.code).toBe('CENT');
    expect(archive.manifeste.comptes['sale']).toBe(2);
  });

  it('emporte TOUTES les tables du commerce', async () => {
    const archive = await new PortabiliteService(context).exporter();
    for (const table of TABLES_EXPORTEES) {
      expect(archive.tables[table], table).toBeDefined();
    }
  });

  it('sépare les colonnes des lignes, pour ne pas tripler la taille', async () => {
    const archive = await new PortabiliteService(context).exporter();
    const ventes = archive.tables['sale']!;
    expect(ventes.colonnes).toContain('id');
    expect(ventes.lignes[0]).toHaveLength(ventes.colonnes.length);
  });

  it('exige le droit d’administrer les paramètres', async () => {
    // L'archive contient TOUT : prix d'achat, clients, empreintes de mots de
    // passe. Ce n'est pas un export comptable.
    const vendeur = await contextFor(fixture.db, fixture.sellerId, {
      permissions: [PERMISSIONS.saleCreate],
    });
    await expect(new PortabiliteService(vendeur).exporter()).rejects.toThrow();
  });
});

describe('ce qui NE voyage PAS', () => {
  it('laisse les réglages du poste derrière elle', async () => {
    /*
     * LE POINT LE PLUS IMPORTANT DE CE FICHIER. Si la clé de licence, le
     * cliquet d'horloge, l'identifiant d'installation ou l'empreinte de la clé
     * de secours voyageaient, il suffirait de copier une archive sur cinq
     * machines pour avoir cinq postes activés avec une seule licence.
     */
    const db = createTestDb();
    await new SetupService(db).run({
      shopCode: 'CENT',
      shopName: 'Boutique Centre',
      adminFullName: 'Rakoto Admin',
      adminLogin: 'admin',
      adminPassword: 'MotDePasse-2026',
    });
    const reglages = new SettingRepository(db);
    await reglages.set(POSTE_KEYS.licenceKey, 'BOUTIQUE-2.charge.signature', null);
    await reglages.set(POSTE_KEYS.dateRatchet, '1780000000000', null);

    const context = await contextFor(
      db,
      (await db.select<{ id: string }>('SELECT id FROM app_user LIMIT 1'))[0]!.id,
    );
    const archive = await new PortabiliteService(context).exporter();
    const clefs = archive.tables['setting']!;
    const colonneCle = clefs.colonnes.indexOf('key');
    const emportees = clefs.lignes.map((ligne) => ligne[colonneCle]);

    for (const interdite of Object.values(POSTE_KEYS)) {
      expect(emportees, interdite).not.toContain(interdite);
    }
    // L'archive ne doit pas non plus porter la clé en clair ailleurs.
    expect(JSON.stringify(archive)).not.toContain('BOUTIQUE-2.charge.signature');
  });

  it('n’emporte pas l’identité du poste', async () => {
    // Un autre ordinateur est un autre poste : lui donner l'identifiant du
    // premier ferait apparaître deux machines sous une seule identité.
    const { context } = await commerceGarni();
    const archive = await new PortabiliteService(context).exporter();
    expect(Object.keys(archive.tables)).not.toContain('app_meta');
  });
});

describe('aller-retour vers une base neuve', () => {
  it('retrouve EXACTEMENT le même contenu, table par table', async () => {
    // L'épreuve qui compte. Une migration ne se refait pas.
    const { fixture, context } = await commerceGarni();
    const archive = await new PortabiliteService(context).exporter();

    const cible = createTestDb();
    const arrivee = await contextFor(fixture.db, fixture.adminId);
    await new PortabiliteService({ ...arrivee, db: cible }).importer(archive);

    for (const table of TABLES_EXPORTEES) {
      // `setting` et `audit_log` diffèrent LÉGITIMEMENT et sont comparés
      // juste après : la première perd les réglages du poste, la seconde
      // gagne la trace de l'export lui-même.
      if (table === 'setting' || table === 'audit_log') continue;
      expect(await contenu(cible, table), table).toBe(await contenu(fixture.db, table));
    }
  });

  it('retrouve les réglages du COMMERCE, sans ceux du poste', async () => {
    const { fixture, context } = await commerceGarni();
    const archive = await new PortabiliteService(context).exporter();

    const cible = createTestDb();
    const arrivee = await contextFor(fixture.db, fixture.adminId);
    await new PortabiliteService({ ...arrivee, db: cible }).importer(archive);

    const commerce = (base: TestExecutor) =>
      base.select<{ key: string; value: string }>(
        `SELECT key, value FROM setting WHERE shop_id IS NOT NULL ORDER BY key`,
      );
    expect(await commerce(cible)).toEqual(await commerce(fixture.db));

    const duPoste = await cible.select<{ total: number }>(
      'SELECT COUNT(*) AS total FROM setting WHERE shop_id IS NULL',
    );
    expect(duPoste[0]?.total).toBe(0);
  });

  it('retrouve le journal d’audit tel que l’archive le portait', async () => {
    // Il ne peut pas être identique à la source : l'export s'y inscrit
    // lui-même, APRÈS avoir lu les tables. Ce qui doit correspondre, c'est
    // l'archive et ce qui est entré.
    const { fixture, context } = await commerceGarni();
    const archive = await new PortabiliteService(context).exporter();

    const cible = createTestDb();
    const arrivee = await contextFor(fixture.db, fixture.adminId);
    await new PortabiliteService({ ...arrivee, db: cible }).importer(archive);

    const entrees = await cible.select<{ total: number }>(
      'SELECT COUNT(*) AS total FROM audit_log',
    );
    expect(entrees[0]?.total).toBe(archive.manifeste.comptes['audit_log']);
    expect(entrees[0]?.total).toBeGreaterThan(0);
  });

  it('laisse la boutique utilisable : on peut vendre juste après', async () => {
    // Une base importée qui ne sait pas encaisser n'a pas été migrée, elle a
    // été recopiée.
    const { fixture, context } = await commerceGarni();
    const archive = await new PortabiliteService(context).exporter();

    const cible = createTestDb();
    const arrivee = await contextFor(fixture.db, fixture.adminId);
    await new PortabiliteService({ ...arrivee, db: cible }).importer(archive);

    const suite = { ...arrivee, db: cible };
    await expect(
      new SaleService(suite).checkout({
        lines: [{ productId: fixture.cable, quantity: 1, unitPrice: 12_000 }],
        payments: [{ method: 'CASH', amount: 12_000 }],
      }),
    ).resolves.toBeTruthy();
  });

  it('permet de se reconnecter avec le même mot de passe', async () => {
    const db = createTestDb();
    await new SetupService(db).run({
      shopCode: 'CENT',
      shopName: 'Boutique Centre',
      adminFullName: 'Rakoto Admin',
      adminLogin: 'admin',
      adminPassword: 'MotDePasse-2026',
    });
    const depart = await contextFor(
      db,
      (await db.select<{ id: string }>('SELECT id FROM app_user LIMIT 1'))[0]!.id,
    );
    const archive = await new PortabiliteService(depart).exporter();

    const cible = createTestDb();
    await new PortabiliteService({ ...depart, db: cible }).importer(archive);
    await expect(new AuthService(cible).login('admin', 'MotDePasse-2026')).resolves.toBeTruthy();
  });

  it('rend un rapport de ce qui est entré', async () => {
    const { fixture, context } = await commerceGarni();
    const archive = await new PortabiliteService(context).exporter();

    const cible = createTestDb();
    const arrivee = await contextFor(fixture.db, fixture.adminId);
    const rapport = await new PortabiliteService({ ...arrivee, db: cible }).importer(archive);

    expect(rapport.lignes).toBeGreaterThan(0);
    expect(rapport.parTable['sale']).toBe(2);
    expect(rapport.lignes).toBe(
      Object.values(archive.manifeste.comptes).reduce((somme, n) => somme + n, 0),
    );
  });
});

describe('refus', () => {
  let fixture: Fixture;
  let context: AppContext;
  let archive: Archive;

  beforeEach(async () => {
    ({ fixture, context } = await commerceGarni());
    archive = await new PortabiliteService(context).exporter();
  });

  it('refuse un fichier qui n’est pas une archive', async () => {
    await expect(
      new PortabiliteService(context).importer({ n: 'importe quoi' } as unknown as Archive),
    ).rejects.toThrow(/n'est pas une archive/);
  });

  it('refuse une archive produite par une version plus récente', async () => {
    // Ses tables ou ses colonnes n'existent pas encore ici : refuser vaut
    // mieux que perdre la moitié des données en silence.
    const future = {
      ...archive,
      manifeste: { ...archive.manifeste, structure: VERSION_STRUCTURE + 1 },
    };
    await expect(new PortabiliteService(context).importer(future)).rejects.toThrow(/plus récente/);
  });

  it('refuse d’écraser une base qui contient déjà un commerce', async () => {
    // Deux commerces mêlés dans une même base ne se démêlent plus.
    await expect(new PortabiliteService(context).importer(archive)).rejects.toThrow(
      /contient déjà un commerce/,
    );
  });

  it('accepte le remplacement quand il est demandé explicitement', async () => {
    const rapport = await new PortabiliteService(context).importer(archive, { remplacer: true });
    expect(rapport.lignes).toBeGreaterThan(0);
    const ventes = await fixture.db.select<{ total: number }>('SELECT COUNT(*) AS total FROM sale');
    expect(ventes[0]?.total).toBe(2);
  });

  it('n’écrit RIEN quand l’import échoue en cours de route', async () => {
    /*
     * Tout ou rien. Une boutique à moitié importée est pire que pas d'import :
     * on ne sait plus ce qui manque, et rejouer l'archive créerait des
     * doublons.
     */
    const cible = createTestDb();
    const arrivee = { ...(await contextFor(fixture.db, fixture.adminId)), db: cible };

    const abimee: Archive = {
      ...archive,
      tables: {
        ...archive.tables,
        // Une ligne de vente qui référence un produit inexistant : la clé
        // étrangère la refusera, au milieu de l'import.
        sale_line: {
          colonnes: archive.tables['sale_line']!.colonnes,
          lignes: [
            archive.tables['sale_line']!.colonnes.map((colonne) =>
              colonne === 'product_id' ? 'produit-fantome' : 'x',
            ),
          ],
        },
      },
    };

    await expect(new PortabiliteService(arrivee).importer(abimee)).rejects.toThrow();
    const boutiques = await cible.select<{ total: number }>('SELECT COUNT(*) AS total FROM shop');
    expect(boutiques[0]?.total).toBe(0);
  });

  it('exige le droit d’administrer les paramètres', async () => {
    const vendeur = await contextFor(fixture.db, fixture.sellerId, { permissions: [] });
    await expect(new PortabiliteService(vendeur).importer(archive)).rejects.toThrow();
  });
});

describe('une base vierge se reconnaît', () => {
  it('dit vrai avant toute installation', async () => {
    // C'est ce qui protège d'un import par-dessus un commerce existant.
    const vierge = createTestDb();
    const { fixture, context } = await commerceGarni();
    const service = new PortabiliteService({ ...context, db: vierge });
    expect(await service.baseVierge()).toBe(true);
    expect(await new PortabiliteService(context).baseVierge()).toBe(false);
    expect(fixture.shopA).toBeTruthy();
  });
});
