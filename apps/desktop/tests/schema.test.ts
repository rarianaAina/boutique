import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/sqlite-executor';
import { seedFixture } from './helpers/fixtures';

/**
 * Le schéma est la première ligne de défense de l'intégrité : ces tests
 * vérifient que les contraintes existent VRAIMENT, et pas seulement dans le
 * fichier de migration.
 */
describe('schéma local', () => {
  it("s'applique sans erreur et crée les tables attendues", async () => {
    const db = createTestDb();
    const tables = await db.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    const names = new Set(tables.map((row) => row.name));
    for (const expected of [
      'shop',
      'app_user',
      'role',
      'product',
      'product_unit',
      'unit_identifier',
      'stock_level',
      'stock_movement',
      'purchase',
      'sale',
      'refund',
      'exchange',
      'transfer',
      'sync_outbox',
      'sync_inbox',
      'audit_log',
    ]) {
      expect(names.has(expected), expected).toBe(true);
    }
    db.close();
  });

  it('refuse une deuxième boutique locale', async () => {
    const fixture = await seedFixture();
    await expect(
      fixture.db.execute('UPDATE shop SET is_local = 1 WHERE id = ?', [fixture.shopB]),
    ).rejects.toThrow();
    fixture.db.close();
  });

  it("refuse un transfert d'une boutique vers elle-même", async () => {
    const fixture = await seedFixture();
    await expect(
      fixture.db.execute(
        `INSERT INTO transfer (id, number, from_shop_id, to_shop_id, status, requested_by,
                               requested_at, created_at, updated_at)
         VALUES ('t1', 'TR-1', ?, ?, 'DRAFT', ?, ?, ?, ?)`,
        [
          fixture.shopA,
          fixture.shopA,
          fixture.adminId,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        ],
      ),
    ).rejects.toThrow();
    fixture.db.close();
  });

  it('refuse un mouvement de stock de quantité nulle', async () => {
    const fixture = await seedFixture();
    await expect(
      fixture.db.execute(
        `INSERT INTO stock_movement (id, shop_id, product_id, type, quantity, source, occurred_at, created_at)
         VALUES ('m1', ?, ?, 'ADJUSTMENT', 0, 'MANUAL', ?, ?)`,
        [fixture.shopA, fixture.cable, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
      ),
    ).rejects.toThrow();
    fixture.db.close();
  });

  it('refuse un statut inconnu sur une unité', async () => {
    const fixture = await seedFixture();
    await expect(
      fixture.db.execute(
        `INSERT INTO product_unit (id, product_id, shop_id, status, condition, created_at, updated_at)
         VALUES ('u1', ?, ?, 'PERDU_QUELQUE_PART', 'NEW', ?, ?)`,
        [fixture.phone, fixture.shopA, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
      ),
    ).rejects.toThrow();
    fixture.db.close();
  });
});
