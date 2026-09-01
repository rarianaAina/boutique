import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  differences,
  familleDeType,
  migrations,
  sqlSqlite,
  versPostgres,
  type Structure,
} from '../src/index.js';

/**
 * Les deux moteurs portent-ils la MÊME structure ?
 *
 * C'est la promesse sur laquelle repose tout le modèle à deux bases : un
 * commerçant hors ligne exporte, un commerçant en ligne importe, et
 * réciproquement. Si les structures divergent d'une colonne, la migration
 * échoue — chez un client, au milieu d'une opération qui ne se refait pas.
 *
 * Deux fichiers de schéma tenus à la main dérivent toujours. Ici le Postgres
 * est TRADUIT du SQLite, et cette épreuve vérifie que la traduction donne bien
 * la même chose.
 *
 * ELLE NE TOURNE QUE SI UN POSTGRES EST FOURNI, par `DATABASE_URL`. La suite
 * quotidienne doit rester rapide et sans service à démarrer ; l'intégration
 * continue, elle, fournit la base et l'épreuve s'exécute.
 */

const URL_POSTGRES = process.env['DATABASE_URL'];

describe('traduction vers Postgres', () => {
  const postgres = versPostgres(sqlSqlite());

  it('écarte ce qui n’existe pas hors de SQLite', () => {
    expect(postgres).not.toMatch(/PRAGMA/);
    expect(postgres).not.toMatch(/json_extract/);
  });

  it('élargit les entiers', () => {
    // Les montants sont dans la plus petite unité de la devise, et un INTEGER
    // Postgres s'arrête à deux milliards : à Madagascar, deux milliards
    // d'ariary sont une somme qu'un grossiste atteint.
    expect(postgres).toMatch(/quantity\s+BIGINT/);
    expect(postgres).not.toMatch(/\s+INTEGER\b/);
  });

  it('garde les booléens en entiers', () => {
    // Pas de BOOLEAN : les données doivent traverser une archive sans
    // conversion, dans un sens comme dans l'autre.
    expect(postgres).toMatch(/is_local\s+BIGINT NOT NULL DEFAULT 0 CHECK \(is_local IN \(0, 1\)\)/);
  });

  it('conserve les index partiels et la vue', () => {
    expect(postgres).toMatch(/CREATE UNIQUE INDEX ux_shop_local ON shop \(is_local\) WHERE/);
    expect(postgres).toMatch(/CREATE VIEW v_unit/);
  });

  it('conserve les suppressions en cascade', () => {
    expect(postgres).toMatch(/ON DELETE CASCADE/);
  });
});

describe.skipIf(!URL_POSTGRES)('structures identiques', () => {
  it('SQLite et Postgres décrivent le même commerce', async () => {
    const attendue = structureSqlite();
    const obtenue = await structurePostgres(URL_POSTGRES!);

    const ecarts = differences(attendue, obtenue);
    expect(ecarts, `\n  ${ecarts.join('\n  ')}\n`).toEqual([]);
  });

  it('porte le même nombre de tables', async () => {
    const attendue = structureSqlite();
    const obtenue = await structurePostgres(URL_POSTGRES!);
    expect(Object.keys(obtenue).sort()).toEqual(Object.keys(attendue).sort());
  });
});

/* ─── Relevé des structures ──────────────────────────────────────────────── */

function structureSqlite(): Structure {
  const db = new DatabaseSync(':memory:');
  db.exec(sqlSqlite());

  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as unknown as { name: string }[];

  const structure: Structure = {};
  for (const { name } of tables) {
    const colonnes = db.prepare(`PRAGMA table_info("${name}")`).all() as unknown as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }[];
    const index = db.prepare(`PRAGMA index_list("${name}")`).all() as unknown as {
      name: string;
      unique: number;
      partial: number;
    }[];
    const etrangeres = db.prepare(`PRAGMA foreign_key_list("${name}")`).all() as unknown as {
      table: string;
      from: string;
    }[];

    const clePrimaire = colonnes
      .filter((colonne) => colonne.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((colonne) => colonne.name);

    const uniques: string[] = [];
    for (const entree of index) {
      if (entree.unique !== 1) continue;
      // Les index PARTIELS sont écartés : les deux moteurs les acceptent mais
      // ne les décrivent pas pareil dans leurs catalogues. Le texte de la
      // clause est déjà vérifié plus haut.
      if (entree.partial === 1) continue;

      const membres = db.prepare(`PRAGMA index_info("${entree.name}")`).all() as unknown as {
        name: string;
      }[];
      const colonnesIndex = membres.map((membre) => membre.name).sort();

      // SQLite décrit la clé primaire comme un index unique de plus ; Postgres
      // la range à part. On l'écarte ici pour comparer la même chose.
      if (JSON.stringify(colonnesIndex) === JSON.stringify([...clePrimaire].sort())) continue;
      uniques.push(colonnesIndex.join('+'));
    }

    structure[name] = {
      colonnes: colonnes.map((colonne) => ({
        nom: colonne.name,
        type: familleDeType(colonne.type),
        // La nullabilité RÉELLE de chaque moteur, sans arrangement. SQLite
        // tolère un NULL dans une colonne de clé primaire, Postgres non : si
        // l'on « corrigeait » SQLite ici, on masquerait précisément
        // l'incompatibilité que cette épreuve existe pour trouver.
        obligatoire: colonne.notnull === 1,
      })),
      clePrimaire,
      uniques,
      etrangeres: etrangeres.map((cle) => `${cle.from}->${cle.table}`),
    };
  }

  db.close();
  return structure;
}

/**
 * Relève la structure d'un Postgres, après y avoir joué le schéma traduit.
 *
 * Le schéma est créé dans un SCHÉMA nommé, puis détruit : l'épreuve ne laisse
 * rien derrière elle, et deux exécutions simultanées ne se marchent pas dessus.
 */
async function structurePostgres(url: string): Promise<Structure> {
  const { default: postgres } = await import('postgres');
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  const espace = `conformite_${Date.now()}_${Math.floor(Math.random() * 10_000)}`;

  try {
    await sql.unsafe(`CREATE SCHEMA "${espace}"`);
    await sql.unsafe(`SET search_path TO "${espace}"`);
    await sql.unsafe(versPostgres(sqlSqlite()));

    const colonnes = (await sql.unsafe(
      `SELECT table_name, column_name, data_type, is_nullable, ordinal_position
         FROM information_schema.columns
        WHERE table_schema = '${espace}'
        ORDER BY table_name, ordinal_position`,
    )) as unknown as {
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
    }[];

    const tables = (await sql.unsafe(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = '${espace}' AND table_type = 'BASE TABLE'`,
    )) as unknown as { table_name: string }[];

    // Clés primaires : GROUPÉES par contrainte, sinon une clé à deux colonnes
    // se lirait comme deux clés distinctes.
    const clefs = (await sql.unsafe(
      `SELECT tc.table_name, tc.constraint_name, kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
        WHERE tc.table_schema = '${espace}' AND tc.constraint_type = 'PRIMARY KEY'
        ORDER BY tc.constraint_name, kcu.ordinal_position`,
    )) as unknown as { table_name: string; constraint_name: string; column_name: string }[];

    // Les index uniques se lisent dans `pg_index`, PAS dans les contraintes :
    // un `CREATE UNIQUE INDEX` ne crée pas de contrainte et n'apparaîtrait
    // nulle part dans `information_schema`. On écarte ceux qui portent la clé
    // primaire (Postgres en crée un pour elle) et les index PARTIELS —
    // `indpred` — que le relevé SQLite écarte aussi.
    const index = (await sql.unsafe(
      `SELECT cl.relname AS table_name,
              array_to_string(array_agg(att.attname ORDER BY att.attname), '+') AS colonnes
         FROM pg_index ix
         JOIN pg_class cl ON cl.oid = ix.indrelid
         JOIN pg_namespace ns ON ns.oid = cl.relnamespace
         JOIN pg_attribute att ON att.attrelid = cl.oid AND att.attnum = ANY (ix.indkey)
        WHERE ns.nspname = '${espace}'
          AND ix.indisunique AND NOT ix.indisprimary AND ix.indpred IS NULL
        GROUP BY cl.relname, ix.indexrelid`,
    )) as unknown as { table_name: string; colonnes: string }[];

    // Les clés étrangères se lisent ailleurs : le passage par
    // `constraint_column_usage` multiplierait les lignes des deux autres.
    const etrangeres = (await sql.unsafe(
      `SELECT tc.table_name, kcu.column_name, ccu.table_name AS cible
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
        WHERE tc.table_schema = '${espace}' AND tc.constraint_type = 'FOREIGN KEY'`,
    )) as unknown as { table_name: string; column_name: string; cible: string }[];

    const structure: Structure = {};
    const nomsDeTables = new Set(tables.map((table) => table.table_name));

    for (const nom of nomsDeTables) {
      const siennes = colonnes.filter((colonne) => colonne.table_name === nom);
      const leurs = clefs.filter((contrainte) => contrainte.table_name === nom);

      const parContrainte = new Map<string, string[]>();
      for (const contrainte of leurs) {
        const entree = parContrainte.get(contrainte.constraint_name) ?? [];
        entree.push(contrainte.column_name);
        parContrainte.set(contrainte.constraint_name, entree);
      }

      structure[nom] = {
        colonnes: siennes.map((colonne) => ({
          nom: colonne.column_name,
          type: familleDeType(colonne.data_type),
          obligatoire: colonne.is_nullable === 'NO',
        })),
        clePrimaire: [...parContrainte.values()][0] ?? [],
        uniques: index
          .filter((entree) => entree.table_name === nom)
          .map((entree) => entree.colonnes),
        etrangeres: etrangeres
          .filter((cle) => cle.table_name === nom)
          .map((cle) => `${cle.column_name}->${cle.cible}`),
      };
    }

    return structure;
  } finally {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${espace}" CASCADE`).catch(() => undefined);
    await sql.end();
  }
}

/* ─── Les migrations sont-elles toutes embarquées ? ──────────────────────── */

describe('migrations embarquées', () => {
  /**
   * `lib.rs` recense les migrations une par une : `include_str!` est résolu à
   * la compilation, il n'y a pas d'autre façon de les embarquer dans le
   * binaire. Rien, en revanche, n'obligeait cette liste à être complète — une
   * migration écrite mais non déclarée ne s'appliquerait tout simplement
   * jamais, et le défaut ne se verrait que chez le commerçant, sur une base
   * restée à l'ancienne structure.
   */
  it('lib.rs les déclare toutes', () => {
    const rust = readFileSync(
      fileURLToPath(new URL('../../../apps/desktop/src-tauri/src/lib.rs', import.meta.url)),
      'utf8',
    );
    const declarees = [...rust.matchAll(/include_str!\("\.\.\/migrations\/([^"]+)"\)/g)].map(
      (trouve) => trouve[1],
    );
    expect(declarees).toEqual(migrations());
  });

  it('les numérote sans trou ni doublon', () => {
    const numeros = migrations().map((nom) => Number(nom.slice(0, 4)));
    expect(numeros).toEqual(numeros.map((_, rang) => rang + 1));
  });
});
