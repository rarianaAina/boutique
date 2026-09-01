import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Le schéma du commerce, dans les deux moteurs.
 *
 * POURQUOI CE PAQUET EXISTE. Le produit se vend sous deux formes : installé,
 * avec une base SQLite sur le poste, et en ligne, avec un Postgres. Un
 * commerçant doit pouvoir passer de l'une à l'autre en emportant ses données.
 * Cela suppose que les deux bases aient EXACTEMENT la même structure — et deux
 * fichiers de schéma tenus à la main dérivent toujours. La dérive ne se
 * découvrirait qu'au milieu d'une migration, chez un client.
 *
 * UNE SEULE SOURCE DE VÉRITÉ : les migrations SQLite, qui tournent déjà en
 * production et sont embarquées dans l'application. Le Postgres en est
 * TRADUIT, mécaniquement, et une épreuve compare les deux structures obtenues.
 *
 * Le traducteur reste volontairement étroit. Il ne comprend pas le SQL : il
 * connaît les quelques différences que ce schéma-ci présente, et rien de plus.
 * Un traducteur général serait faux à sa première surprise ; celui-ci échoue
 * bruyamment devant ce qu'il ne connaît pas, et l'épreuve de conformité le dit.
 */

export const DOSSIER_MIGRATIONS = fileURLToPath(
  new URL('../../../apps/desktop/src-tauri/migrations/', import.meta.url),
);

/**
 * Migrations SQLite, dans l'ordre d'application.
 *
 * Le dossier est BALAYÉ : les noms commencent par un numéro, l'ordre
 * alphabétique est donc l'ordre d'application. Une liste tenue à la main ici
 * s'oublierait — elle l'a été. La seule liste écrite à la main est celle de
 * `lib.rs`, que le compilateur Rust exige, et une épreuve vérifie qu'elle
 * recense bien tout le dossier.
 */
export function migrations(): string[] {
  return readdirSync(DOSSIER_MIGRATIONS)
    .filter((nom) => nom.endsWith('.sql'))
    .sort();
}

export function sqlSqlite(): string {
  return migrations()
    .map((nom) => readFileSync(`${DOSSIER_MIGRATIONS}${nom}`, 'utf8'))
    .join('\n');
}

/**
 * Marqueur d'une instruction que Postgres ne doit pas exécuter.
 *
 * Il ne sert QUE pour les reprises de données — remplir une colonne neuve à
 * partir de l'ancienne. Une base Postgres fraîche n'a rien à reprendre, et ces
 * instructions emploient des fonctions propres à SQLite. Elles ne touchent pas
 * à la structure : les écarter ne peut pas faire diverger les deux schémas, et
 * l'épreuve de conformité le vérifie de toute façon.
 *
 * IL NE S'ÉCRIT QUE DANS LES MIGRATIONS À VENIR. Une migration publiée ne se
 * modifie jamais — sqlx compare l'empreinte de chacune à celle enregistrée au
 * moment où elle a été appliquée, et refuse d'ouvrir la base si elles
 * diffèrent. Ajouter ne serait-ce qu'un commentaire à une migration déjà
 * livrée bloquerait tous les postes en service. Les reprises antérieures à ce
 * marqueur sont donc nommées ci-dessous, depuis l'extérieur.
 */
export const MARQUEUR_SQLITE = '@sqlite-uniquement';

/**
 * Reprises de données ANTÉRIEURES au marqueur, désignées par un fragment.
 *
 * Deux instructions de la migration 0002 remplissent les colonnes `color` et
 * `capacity` à partir des attributs libres des bases déjà en service. Elles
 * emploient `json_extract`, que Postgres ne connaît pas, et n'ont rien à faire
 * sur une base neuve. Le marqueur ne peut pas leur être ajouté (voir plus
 * haut) : elles sont donc listées ici.
 *
 * Cette liste ne doit pas grandir. Toute reprise nouvelle porte le marqueur.
 */
const REPRISES_HERITEES: readonly string[] = [
  "SET color = json_extract(attributes, '$.couleur')",
  "SET capacity = json_extract(attributes, '$.capacite')",
];

/**
 * Traduit le schéma SQLite en Postgres.
 *
 * Les différences que ce schéma présente, et rien d'autre :
 *
 *   — les `PRAGMA` ne veulent rien dire hors de SQLite ;
 *   — `INTEGER` devient `BIGINT`. Les montants sont dans la plus petite unité
 *     de la devise et un `INTEGER` Postgres s'arrête à deux milliards : à
 *     Madagascar, deux milliards d'ariary sont une somme qu'un grossiste
 *     atteint. Les booléens restent des entiers 0/1 plutôt que des `BOOLEAN`,
 *     pour que les données traversent une archive sans conversion ;
 *   — les reprises de données marquées sont écartées.
 *
 * Tout le reste — `TEXT`, `CHECK`, `DEFAULT`, `REFERENCES … ON DELETE CASCADE`,
 * les index partiels, la vue — s'écrit pareil dans les deux moteurs.
 */
export function versPostgres(sqlite: string): string {
  return decouper(sqlite)
    .filter((instruction) => !/^PRAGMA\b/i.test(verbe(instruction.sql)))
    .filter((instruction) => !instruction.sqliteUniquement)
    .filter(
      (instruction) => !REPRISES_HERITEES.some((fragment) => instruction.sql.includes(fragment)),
    )
    .map((instruction) => traduire(instruction.sql))
    .join(';\n\n')
    .concat(';\n');
}

interface Instruction {
  sql: string;
  sqliteUniquement: boolean;
}

/**
 * Découpe un fichier en instructions.
 *
 * Le point-virgule suffit ici parce que ce schéma n'en contient aucun à
 * l'intérieur d'une chaîne ou d'un corps de fonction. L'épreuve de conformité
 * s'en rendrait compte immédiatement si cela changeait : la base ne se
 * créerait pas.
 */
function decouper(sql: string): Instruction[] {
  const instructions: Instruction[] = [];
  let courante = '';
  let marquee = false;

  for (const ligne of sql.split('\n')) {
    if (ligne.includes(MARQUEUR_SQLITE)) marquee = true;
    courante += `${ligne}\n`;
    if (ligne.trimEnd().endsWith(';')) {
      const propre = courante.replace(/;\s*$/, '').trim();
      if (propre !== '') instructions.push({ sql: propre, sqliteUniquement: marquee });
      courante = '';
      marquee = false;
    }
  }
  const reste = courante.trim();
  if (reste !== '') instructions.push({ sql: reste, sqliteUniquement: marquee });
  return instructions;
}

/**
 * Première ligne de code d'une instruction, commentaires écartés.
 *
 * Sans cela, l'en-tête d'un fichier — plusieurs dizaines de lignes de
 * commentaire sans point-virgule — se colle à la première instruction, et l'on
 * ne reconnaît plus ce qu'elle est.
 */
function verbe(sql: string): string {
  for (const ligne of sql.split('\n')) {
    const propre = ligne.trim();
    if (propre === '' || propre.startsWith('--')) continue;
    return propre;
  }
  return '';
}

function traduire(sql: string): string {
  // `INTEGER` uniquement comme TYPE de colonne : précédé d'un nom de colonne
  // et suivi d'une contrainte ou d'une virgule. Une occurrence dans un
  // commentaire ou une chaîne n'est pas touchée.
  return sql.replace(/\b([a-z_]+)(\s+)INTEGER\b/g, '$1$2BIGINT');
}

/* ─── Comparaison des structures ─────────────────────────────────────────── */

export interface Colonne {
  nom: string;
  /** `texte` ou `entier` : ce que les deux moteurs ont en commun. */
  type: 'texte' | 'entier' | 'autre';
  obligatoire: boolean;
}

export interface StructureTable {
  colonnes: Colonne[];
  clePrimaire: string[];
  /** Index uniques, colonnes triées, pour comparer sans dépendre des noms. */
  uniques: string[];
  /** `colonne -> table visée`, trié. */
  etrangeres: string[];
}

export type Structure = Record<string, StructureTable>;

/** Ramène un type de l'un ou l'autre moteur à ce qu'ils ont en commun. */
export function familleDeType(type: string): Colonne['type'] {
  const brut = type.toLowerCase();
  if (brut.includes('char') || brut === 'text') return 'texte';
  if (brut.includes('int')) return 'entier';
  return 'autre';
}

/**
 * Colonnes de clé primaire que SQLite laisse nullables, et qu'on l'accepte.
 *
 * SQLite tolère un NULL dans une clé primaire TEXT — séquelle d'un défaut
 * ancien conservé par compatibilité — là où Postgres rend toute colonne de clé
 * primaire obligatoire. L'écart est réel mais il ne va que dans un sens :
 * Postgres est le plus strict des deux, et toute ligne qu'il accepte, SQLite
 * l'accepte aussi. Le risque se limiterait à une ligne dont la clé primaire
 * serait NULL, qu'aucun dépôt ne peut produire — tous tirent un UUID.
 *
 * ON NE LE CORRIGE PAS EN AMONT, et la raison est décisive : SQLite ne sait pas
 * changer la nullabilité d'une colonne sans rebâtir la table, et rebâtir
 * trente-trois tables déjà en service par migration ferait courir aux postes
 * installés un danger sans commune mesure avec celui qu'on écarterait.
 *
 * LA LISTE EST FIGÉE, et c'est là qu'est sa valeur. Elle recense exactement ce
 * qui existait quand la règle a été posée. Une table NOUVELLE dont la clé
 * primaire serait nullable ne s'y trouverait pas, et l'épreuve échouerait — ce
 * qui est le comportement voulu : les migrations à venir écrivent `NOT NULL`
 * sur leurs clés primaires.
 */
export const CLES_NULLABLES_TOLEREES: readonly string[] = [
  'app_meta.key',
  'app_user.id',
  'audit_log.id',
  'category.id',
  'customer.id',
  'exchange.id',
  'import_batch.id',
  'import_row.id',
  'inventory_line.id',
  'inventory_session.id',
  'invoice.id',
  'landed_cost.id',
  'payment_method.code',
  'price_history.id',
  'product.id',
  'product_unit.id',
  'purchase.id',
  'purchase_line.id',
  'purchase_receipt.id',
  'purchase_receipt_line.id',
  'refund.id',
  'refund_line.id',
  'role.id',
  'sale.id',
  'sale_line.id',
  'sale_payment.id',
  'shop.id',
  'stock_movement.id',
  'supplier.id',
  'sync_inbox.event_id',
  'sync_outbox.id',
  'transfer.id',
  'transfer_line.id',
  'unit_identifier.id',
];

/**
 * Ce qui diffère entre deux structures, en clair.
 *
 * Rend une liste de phrases plutôt qu'un booléen : quand l'épreuve échoue,
 * c'est le message qui doit dire quoi corriger, pas une différence d'objets de
 * huit cents lignes qu'il faut lire à la loupe.
 */
export function differences(sqlite: Structure, postgres: Structure): string[] {
  const ecarts: string[] = [];
  const tables = [...new Set([...Object.keys(sqlite), ...Object.keys(postgres)])].sort();

  for (const table of tables) {
    const gauche = sqlite[table];
    const droite = postgres[table];
    if (!gauche) {
      ecarts.push(`table « ${table} » absente de SQLite`);
      continue;
    }
    if (!droite) {
      ecarts.push(`table « ${table} » absente de Postgres`);
      continue;
    }

    const colonnes = [
      ...new Set([...gauche.colonnes, ...droite.colonnes].map((colonne) => colonne.nom)),
    ].sort();
    for (const nom of colonnes) {
      const a = gauche.colonnes.find((colonne) => colonne.nom === nom);
      const b = droite.colonnes.find((colonne) => colonne.nom === nom);
      if (!a) ecarts.push(`${table}.${nom} : absente de SQLite`);
      else if (!b) ecarts.push(`${table}.${nom} : absente de Postgres`);
      else {
        if (a.type !== b.type) {
          ecarts.push(`${table}.${nom} : type ${a.type} en SQLite, ${b.type} en Postgres`);
        }
        const toleree =
          !a.obligatoire &&
          b.obligatoire &&
          gauche.clePrimaire.includes(nom) &&
          CLES_NULLABLES_TOLEREES.includes(`${table}.${nom}`);
        if (a.obligatoire !== b.obligatoire && !toleree) {
          ecarts.push(
            `${table}.${nom} : ${a.obligatoire ? 'obligatoire' : 'facultative'} en SQLite, ` +
              `${b.obligatoire ? 'obligatoire' : 'facultative'} en Postgres`,
          );
        }
      }
    }

    comparer(ecarts, `${table} : clé primaire`, gauche.clePrimaire, droite.clePrimaire);
    comparer(ecarts, `${table} : index uniques`, gauche.uniques, droite.uniques);
    comparer(ecarts, `${table} : clés étrangères`, gauche.etrangeres, droite.etrangeres);
  }

  return ecarts;
}

function comparer(ecarts: string[], quoi: string, sqlite: string[], postgres: string[]): void {
  const a = JSON.stringify([...sqlite].sort());
  const b = JSON.stringify([...postgres].sort());
  if (a !== b) ecarts.push(`${quoi} : ${a} en SQLite, ${b} en Postgres`);
}
