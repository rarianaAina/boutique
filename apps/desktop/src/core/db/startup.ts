import { nowIso, variantGroupKey } from '@boutique/shared';
import { ProductRepository } from './repositories/product.repository';
import { META_KEYS, MetaRepository } from './repositories/meta.repository';
import { OutboxRepository } from './repositories/outbox.repository';
import type { SqlExecutor } from './client';

/**
 * Entretien au démarrage.
 *
 * Trois tâches qui doivent tourner AVANT la première vente et qu'aucun
 * utilisateur ne pensera à déclencher. Aucune ne doit empêcher l'application de
 * démarrer : une sauvegarde impossible (disque plein, dossier en lecture seule)
 * est un incident à signaler, pas une raison de bloquer un comptoir devant un
 * client.
 */
export interface StartupReport {
  searchKeysRepaired: number;
  variantGroupsRepaired: number;
  outboxPurged: boolean;
  problems: string[];
}

/** Les envois confirmés de plus de 30 jours : la file n'est pas une archive. */
const OUTBOX_RETENTION_DAYS = 30;

export async function runStartupMaintenance(db: SqlExecutor): Promise<StartupReport> {
  const report: StartupReport = {
    searchKeysRepaired: 0,
    variantGroupsRepaired: 0,
    outboxPurged: false,
    problems: [],
  };
  const meta = new MetaRepository(db);

  try {
    // Le drapeau évite de rebalayer le catalogue à chaque lancement : la
    // requête est peu coûteuse mais grandit avec le nombre de produits, et
    // n'a plus rien à corriger une fois la reprise faite.
    if ((await meta.get(META_KEYS.schemaReady)) !== '1') {
      report.searchKeysRepaired = await new ProductRepository(db).rebuildSearchKeys();
      await meta.set(META_KEYS.schemaReady, '1');
    }
  } catch (cause) {
    report.problems.push(`Index de recherche : ${describe(cause)}`);
  }

  try {
    // Les produits créés avant l'arrivée des variantes n'ont pas de clé de
    // regroupement. Elle est calculée ICI, en TypeScript, avec la même
    // normalisation que partout ailleurs — la reproduire en SQL donnerait deux
    // règles qui finiraient par diverger.
    report.variantGroupsRepaired = await repairVariantGroups(db);
  } catch (cause) {
    report.problems.push(`Regroupement des variantes : ${describe(cause)}`);
  }

  try {
    const limit = new Date(Date.now() - OUTBOX_RETENTION_DAYS * 86_400_000).toISOString();
    await new OutboxRepository(db).purgeSent(limit);
    report.outboxPurged = true;
  } catch (cause) {
    report.problems.push(`File de synchronisation : ${describe(cause)}`);
  }

  return report;
}

async function repairVariantGroups(db: SqlExecutor): Promise<number> {
  const rows = await db.select<{
    id: string;
    name: string;
    brand: string | null;
    model: string | null;
  }>(
    `SELECT id, name, brand, model FROM product
     WHERE variant_group IS NULL OR variant_group = ''`,
  );
  if (rows.length === 0) return 0;

  await db.transaction(async (tx) => {
    for (const row of rows) {
      await tx.execute('UPDATE product SET variant_group = ? WHERE id = ?', [
        variantGroupKey({ brand: row.brand, model: row.model, name: row.name }),
        row.id,
      ]);
    }
  });
  return rows.length;
}

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export { nowIso };
