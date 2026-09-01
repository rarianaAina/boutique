import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DOSSIER_MIGRATIONS } from './helpers/sqlite-executor';

/**
 * La migration 0004 sur une base DÉJÀ EN SERVICE.
 *
 * Les autres épreuves partent d'une base vide : elles vérifient que le schéma
 * final est le bon, jamais que le chemin pour y arriver l'est. Or c'est ce
 * chemin-là qui s'exécutera chez les commerçants déjà installés, une seule
 * fois, sur des données réelles — et une reprise fausse ne se rejoue pas.
 *
 * On reconstitue donc une base à l'état d'avant, avec le défaut qu'elle porte :
 * plusieurs lignes empilées pour une même clé du poste.
 */

function baseAvant(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const nom of ['0001_init.sql', '0002_variantes.sql', '0003_historique_prix.sql']) {
    db.exec(readFileSync(`${DOSSIER_MIGRATIONS}${nom}`, 'utf8'));
  }
  return db;
}

function appliquer0004(db: DatabaseSync): void {
  db.exec(readFileSync(`${DOSSIER_MIGRATIONS}0004_reglages_poste.sql`, 'utf8'));
}

function ecrire(db: DatabaseSync, key: string, shopId: string | null, value: string, le: string) {
  db.prepare('INSERT INTO setting (key, shop_id, value, updated_at) VALUES (?, ?, ?, ?)').run(
    key,
    shopId,
    value,
    le,
  );
}

describe('migration 0004 sur une base en service', () => {
  it('garde la valeur la plus récente des doublons du poste', () => {
    const db = baseAvant();
    // Le défaut en question : trois écritures du cliquet d'horloge, trois
    // lignes, parce que SQLite tenait leurs `shop_id` NULL pour distincts.
    ecrire(db, 'licence.ratchet', null, '1000', '2026-01-01T00:00:00.000Z');
    ecrire(db, 'licence.ratchet', null, '2000', '2026-02-01T00:00:00.000Z');
    ecrire(db, 'licence.ratchet', null, '3000', '2026-03-01T00:00:00.000Z');

    appliquer0004(db);

    const lignes = db
      .prepare(`SELECT shop_id, value FROM setting WHERE key = 'licence.ratchet'`)
      .all() as unknown as { shop_id: string; value: string }[];
    expect(lignes).toEqual([{ shop_id: '', value: '3000' }]);
    db.close();
  });

  it('ne touche pas aux réglages rattachés à une boutique', () => {
    const db = baseAvant();
    db.prepare(
      `INSERT INTO shop (id, code, name, is_local, created_at, updated_at)
       VALUES ('s1', 'B1', 'Boutique', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    ecrire(db, 'commerce.currency', 's1', '{"code":"MGA"}', '2026-01-01T00:00:00.000Z');
    ecrire(db, 'licence.key', null, 'CLE', '2026-01-01T00:00:00.000Z');

    appliquer0004(db);

    const lignes = db
      .prepare('SELECT key, shop_id, value FROM setting ORDER BY key')
      .all() as unknown as { key: string; shop_id: string; value: string }[];
    expect(lignes).toEqual([
      { key: 'commerce.currency', shop_id: 's1', value: '{"code":"MGA"}' },
      { key: 'licence.key', shop_id: '', value: 'CLE' },
    ]);
    db.close();
  });

  it('empêche désormais un second empilement', () => {
    const db = baseAvant();
    appliquer0004(db);
    ecrire(db, 'licence.key', '', 'A', '2026-01-01T00:00:00.000Z');

    // C'est tout l'objet de la migration : la clé primaire s'oppose enfin au
    // doublon, ce qui rend `ON CONFLICT` opérant côté dépôt.
    expect(() => ecrire(db, 'licence.key', '', 'B', '2026-02-01T00:00:00.000Z')).toThrow(
      /UNIQUE constraint failed/,
    );
    db.close();
  });

  it('refuse un shop_id NULL après la reprise', () => {
    const db = baseAvant();
    appliquer0004(db);
    expect(() => ecrire(db, 'licence.key', null, 'A', '2026-01-01T00:00:00.000Z')).toThrow(
      /NOT NULL constraint failed/,
    );
    db.close();
  });
});

describe('migration 0006 sur une base en service', () => {
  function baseAvant0006(): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    for (const nom of [
      '0001_init.sql',
      '0002_variantes.sql',
      '0003_historique_prix.sql',
      '0004_reglages_poste.sql',
      '0005_identifiants_fiscaux.sql',
    ]) {
      db.exec(readFileSync(`${DOSSIER_MIGRATIONS}${nom}`, 'utf8'));
    }
    return db;
  }

  function role(db: DatabaseSync, code: string, permissions: string[]) {
    db.prepare(
      `INSERT INTO role (id, code, name, permissions, is_system, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run(code.toLowerCase(), code, code, JSON.stringify(permissions));
  }

  function permissionsDe(db: DatabaseSync, code: string): string[] {
    const ligne = db.prepare('SELECT permissions FROM role WHERE code = ?').get(code) as unknown as
      { permissions: string } | undefined;
    return JSON.parse(ligne?.permissions ?? '[]') as string[];
  }

  /**
   * Sans cette reprise, un administrateur d'une base déjà en service n'aurait
   * accès ni aux charges ni au compte de résultat — et rien ne le lui dirait :
   * les écrans seraient simplement absents de son menu.
   */
  it('donne les nouveaux droits aux rôles qui les attendent', () => {
    const db = baseAvant0006();
    role(db, 'ADMIN', ['sale.create', 'settings.manage']);
    role(db, 'MANAGER', ['sale.create']);
    role(db, 'SELLER', ['sale.create']);

    db.exec(readFileSync(`${DOSSIER_MIGRATIONS}0006_charges.sql`, 'utf8'));

    for (const code of ['ADMIN', 'MANAGER']) {
      expect(permissionsDe(db, code)).toEqual(
        expect.arrayContaining(['charge.manage', 'page.charges', 'page.resultat']),
      );
    }
    // Un vendeur ne saisit pas de charges et ne voit pas le résultat.
    expect(permissionsDe(db, 'SELLER')).toEqual(['sale.create']);
    db.close();
  });

  it('ne les donne pas deux fois si la migration est rejouée', () => {
    const db = baseAvant0006();
    role(db, 'ADMIN', ['sale.create']);

    const sql = readFileSync(`${DOSSIER_MIGRATIONS}0006_charges.sql`, 'utf8');
    db.exec(sql);
    // Le CREATE TABLE échouerait à la seconde exécution : on ne rejoue que la
    // reprise, qui est la partie susceptible de s'appliquer en double.
    db.exec(sql.slice(sql.indexOf('UPDATE role')));

    const permissions = permissionsDe(db, 'ADMIN');
    expect(permissions.filter((droit) => droit === 'charge.manage')).toHaveLength(1);
    db.close();
  });
});
