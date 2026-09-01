import { PERMISSIONS, nowIso } from '@boutique/shared';
import { POSTE_KEYS } from '../db/repositories/setting.repository';
import { AUDIT_ACTIONS, AuditRepository } from '../db/repositories/audit.repository';
import { BusinessError, assertCan, type AppContext } from './context';

/**
 * Emporter un commerce d'une base à l'autre (§37).
 *
 * TROIS TRAJETS, UN SEUL MÉCANISME : d'un poste vers un autre poste, du poste
 * vers l'offre en ligne, et de l'offre en ligne vers un poste. Ce sont les
 * mêmes données, la même structure, et il ne doit y avoir qu'une seule façon
 * de les déplacer — deux formats finiraient par diverger, et la divergence ne
 * se découvrirait qu'au milieu d'une migration, chez un client.
 *
 * POURQUOI PAS LE FICHIER SQLITE. Il ne se relit pas dans Postgres. L'archive
 * est donc neutre : du texte, une table par bloc, des identifiants qui sont
 * déjà des UUID et traversent sans renumérotation.
 *
 * POURQUOI DES COLONNES SÉPARÉES DES LIGNES. Répéter le nom de chaque colonne
 * sur chaque ligne triplerait la taille d'une archive qui voyage par clé USB
 * ou par courriel. Les colonnes sont déclarées une fois, les lignes sont des
 * tableaux — et l'archive reste lisible par un humain qui l'ouvre.
 */

/** Version du FORMAT d'archive. Change si la façon d'écrire change. */
export const FORMAT_ARCHIVE = 1;

/**
 * Version de la STRUCTURE de la base, indépendante du format.
 *
 * Une archive produite par une version plus récente n'est pas importable : les
 * tables ou les colonnes qu'elle porte n'existeraient pas encore ici. Refuser
 * vaut mieux que perdre la moitié des données en silence.
 */
export const VERSION_STRUCTURE = 5;

/**
 * Tables emportées, DANS L'ORDRE D'INSERTION.
 *
 * L'ordre suit les clés étrangères : une ligne ne s'insère jamais avant ce
 * qu'elle référence. C'est l'ordre de création du schéma, à une exception près
 * — `price_history`, ajoutée par une migration ultérieure, référence `product`,
 * `supplier` et `shop`, et se place donc après eux.
 */
export const TABLES_EXPORTEES = [
  'shop',
  'role',
  'app_user',
  'category',
  'supplier',
  'product',
  'product_unit',
  'unit_identifier',
  'stock_level',
  'stock_movement',
  'customer',
  'purchase',
  'purchase_line',
  'landed_cost',
  'purchase_receipt',
  'purchase_receipt_line',
  'sale',
  'sale_line',
  'payment_method',
  'sale_payment',
  'invoice',
  'refund',
  'refund_line',
  'exchange',
  'transfer',
  'transfer_line',
  'inventory_session',
  'inventory_line',
  'price_history',
  'audit_log',
  'sync_outbox',
  'sync_inbox',
  'document_counter',
  'import_batch',
  'import_row',
  'setting',
] as const;

/**
 * CE QUI NE VOYAGE PAS, et pourquoi chaque exclusion compte.
 *
 * `app_meta` porte l'identifiant du POSTE et le curseur de synchronisation. Un
 * autre ordinateur est un autre poste : lui donner l'identifiant du premier
 * ferait apparaître deux machines sous une seule identité côté serveur. Le
 * curseur repart donc de zéro, ce qui est sans danger — la réception des
 * événements est idempotente, elle relit sans réappliquer.
 *
 * Les réglages du POSTE — clé de licence, cliquet d'horloge, identifiant
 * d'installation, empreinte de la clé de secours — sont exclus un par un, et
 * c'est le point le plus important de ce fichier. S'ils voyageaient, il
 * suffirait de copier une archive sur cinq machines pour avoir cinq postes
 * activés avec une seule licence. La machine d'arrivée repart donc avec un
 * code d'installation neuf, et son propriétaire demande une clé — ce qui est
 * exactement le moment où l'éditeur veut savoir qu'il a changé de machine.
 */
const REGLAGES_DU_POSTE: readonly string[] = Object.values(POSTE_KEYS);

export interface ManifesteArchive {
  format: number;
  structure: number;
  /** Horodatage de production, à titre indicatif. */
  exporteLe: string;
  /** D'où vient l'archive : utile au diagnostic, jamais à une décision. */
  origine: 'poste' | 'en-ligne';
  /** Boutique locale au moment de l'export, pour reconnaître l'archive. */
  boutique: { code: string; nom: string } | null;
  /** Nombre de lignes par table, pour vérifier qu'il n'en manque aucune. */
  comptes: Record<string, number>;
}

export interface Archive {
  manifeste: ManifesteArchive;
  tables: Record<string, { colonnes: string[]; lignes: unknown[][] }>;
}

export interface RapportImport {
  tables: number;
  lignes: number;
  /** Détail par table, pour que l'écran puisse le montrer. */
  parTable: Record<string, number>;
}

export class PortabiliteService {
  constructor(private readonly context: AppContext) {}

  /* ─── Export ──────────────────────────────────────────────────────────── */

  /**
   * Produit l'archive complète du commerce.
   *
   * Réservée à qui administre les paramètres : l'archive contient TOUT — prix
   * d'achat, clients, empreintes de mots de passe. Ce n'est pas un export
   * comptable, c'est la base entière.
   */
  async exporter(): Promise<Archive> {
    assertCan(this.context, PERMISSIONS.settingsManage);

    const tables: Archive['tables'] = {};
    const comptes: Record<string, number> = {};

    for (const table of TABLES_EXPORTEES) {
      const lignes = await this.lire(table);
      tables[table] = lignes;
      comptes[table] = lignes.lignes.length;
    }

    const boutique = await this.context.db.select<{ code: string; name: string }>(
      'SELECT code, name FROM shop WHERE is_local = 1 LIMIT 1',
    );

    const archive: Archive = {
      manifeste: {
        format: FORMAT_ARCHIVE,
        structure: VERSION_STRUCTURE,
        exporteLe: nowIso(),
        origine: 'poste',
        boutique: boutique[0] ? { code: boutique[0].code, nom: boutique[0].name } : null,
        comptes,
      },
      tables,
    };

    await this.context.db.transaction(async (tx) => {
      await new AuditRepository(tx).write({
        action: AUDIT_ACTIONS.export,
        entity: 'archive',
        entityId: 'export',
        userId: this.context.session?.id ?? null,
        userLabel: this.context.session?.fullName ?? null,
        shopId: this.context.shopId,
        after: { lignes: Object.values(comptes).reduce((somme, n) => somme + n, 0) },
      });
    });

    return archive;
  }

  /**
   * Lit une table entière.
   *
   * Les colonnes sont découvertes sur la première ligne plutôt que déclarées :
   * une colonne ajoutée par une migration future part avec l'archive sans
   * qu'on ait à tenir une liste à jour, qu'on oublierait un jour.
   */
  private async lire(table: string): Promise<{ colonnes: string[]; lignes: unknown[][] }> {
    const filtre = table === 'setting' ? this.filtreReglages() : '';
    const rows = await this.context.db.select<Record<string, unknown>>(
      `SELECT * FROM ${table}${filtre}`,
    );
    if (rows.length === 0) return { colonnes: [], lignes: [] };

    const colonnes = Object.keys(rows[0] as object);
    return {
      colonnes,
      lignes: rows.map((row) => colonnes.map((colonne) => row[colonne] ?? null)),
    };
  }

  /** Écarte les réglages du poste : voir REGLAGES_DU_POSTE. */
  private filtreReglages(): string {
    const exclus = REGLAGES_DU_POSTE.map((cle) => `'${cle}'`).join(', ');
    return ` WHERE key NOT IN (${exclus})`;
  }

  /* ─── Import ──────────────────────────────────────────────────────────── */

  /**
   * Ce qu'une archive apporterait, sans rien écrire.
   *
   * On regarde AVANT d'agir : l'import remplace une base entière, et personne
   * ne doit découvrir après coup que l'archive venait d'une autre boutique ou
   * d'une version incompatible.
   */
  verifier(archive: unknown): ManifesteArchive {
    const candidate = archive as Partial<Archive>;
    const manifeste = candidate?.manifeste;

    if (!manifeste || typeof manifeste !== 'object' || !candidate.tables) {
      throw new BusinessError("Ce fichier n'est pas une archive de boutique.");
    }
    if (manifeste.format !== FORMAT_ARCHIVE) {
      throw new BusinessError(
        `Archive au format ${manifeste.format}, ce logiciel lit le format ${FORMAT_ARCHIVE}.`,
      );
    }
    if (manifeste.structure > VERSION_STRUCTURE) {
      // Refuser vaut mieux que perdre la moitié des données en silence : les
      // tables ou colonnes de cette archive n'existent pas encore ici.
      throw new BusinessError(
        `Archive produite par une version plus récente du logiciel (structure ${manifeste.structure} contre ${VERSION_STRUCTURE}). Mettez ce poste à jour avant d'importer.`,
      );
    }
    return manifeste;
  }

  /** Une base est-elle vierge ? Un import n'écrase jamais sans qu'on le demande. */
  async baseVierge(): Promise<boolean> {
    const rows = await this.context.db.select<{ total: number }>(
      'SELECT COUNT(*) AS total FROM shop',
    );
    return (rows[0]?.total ?? 0) === 0;
  }

  /**
   * Importe une archive.
   *
   * TOUT OU RIEN. Une boutique à moitié importée est pire que pas d'import du
   * tout : on ne sait plus ce qui manque, et rejouer l'archive créerait des
   * doublons. Tout passe donc dans une seule transaction — les écritures sont
   * accumulées et appliquées d'un bloc, ou rien ne l'est.
   *
   * `remplacer` vide la base au préalable. Sans lui, l'import refuse une base
   * qui contient déjà un commerce : deux commerces mêlés dans une même base ne
   * se démêlent plus.
   */
  async importer(archive: Archive, options: { remplacer?: boolean } = {}): Promise<RapportImport> {
    assertCan(this.context, PERMISSIONS.settingsManage);
    this.verifier(archive);

    if (!options.remplacer && !(await this.baseVierge())) {
      throw new BusinessError(
        'Cette base contient déjà un commerce. Demandez explicitement le remplacement pour l’écraser — l’opération est irréversible.',
      );
    }

    const rapport: RapportImport = { tables: 0, lignes: 0, parTable: {} };

    await this.context.db.transaction(async (tx) => {
      if (options.remplacer) {
        // Ordre INVERSE de l'insertion : on retire les enfants avant les
        // parents, sinon les clés étrangères s'y opposent.
        for (const table of [...TABLES_EXPORTEES].reverse()) {
          await tx.execute(`DELETE FROM ${table}`);
        }
      }

      for (const table of TABLES_EXPORTEES) {
        const bloc = archive.tables[table];
        if (!bloc || bloc.lignes.length === 0) continue;

        const colonnes = bloc.colonnes.map((colonne) => `"${colonne}"`).join(', ');
        const marques = bloc.colonnes.map(() => '?').join(', ');
        for (const ligne of bloc.lignes) {
          await tx.execute(`INSERT INTO ${table} (${colonnes}) VALUES (${marques})`, [...ligne]);
        }

        rapport.tables += 1;
        rapport.lignes += bloc.lignes.length;
        rapport.parTable[table] = bloc.lignes.length;
      }
    });

    return rapport;
  }
}
