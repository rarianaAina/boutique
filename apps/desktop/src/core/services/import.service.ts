import { PERMISSIONS, newId, nowIso } from '@boutique/shared';
import type { ImportMode, Tracking } from '@boutique/shared';
import { ProductRepository } from '../db/repositories/product.repository';
import { UnitRepository } from '../db/repositories/unit.repository';
import { CategoryRepository } from '../db/repositories/category.repository';
import { SupplierRepository } from '../db/repositories/supplier.repository';
import { AUDIT_ACTIONS } from '../db/repositories/audit.repository';
import { analyze, type AnalysisReport, type AnalyzedRow } from '../import/analyze';
import type { SheetData } from '../import/workbook';
import { AuditService } from './audit.service';
import { StockService } from './stock.service';
import { ProductService } from './catalog.service';
import { BusinessError, assertCan, type AppContext } from './context';

/**
 * Mémoire des références résolues pendant un import.
 *
 * Sans elle, un fichier de deux cents lignes portant toutes la même catégorie
 * ferait deux cents recherches identiques — et, pire, pourrait créer la
 * catégorie plusieurs fois si deux lignes étaient traitées avant que la
 * première écriture ne soit visible.
 */
class ReferenceCache {
  private readonly connus = new Map<string, string>();
  private cree = false;

  constructor(
    private readonly chercher: (libelle: string) => Promise<string | null>,
    private readonly creer: (libelle: string) => Promise<string>,
  ) {}

  async resolve(libelle: string): Promise<string> {
    const cle = libelle.trim().toLowerCase();
    const connu = this.connus.get(cle);
    if (connu) return connu;

    const existant = await this.chercher(libelle.trim());
    if (existant) {
      this.connus.set(cle, existant);
      return existant;
    }

    const id = await this.creer(libelle.trim());
    this.connus.set(cle, id);
    this.cree = true;
    return id;
  }

  /** Vrai une seule fois après chaque création : sert à compter les nouveautés. */
  consumeCreation(): boolean {
    const valeur = this.cree;
    this.cree = false;
    return valeur;
  }
}

/** Code technique dérivé d'un libellé : majuscules, sans accent ni espace. */
function codeDe(libelle: string): string {
  return libelle
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
}

/**
 * Import de fichiers Excel (§8).
 *
 * DEUX RÈGLES QUI PRIMENT SUR TOUT LE RESTE :
 *
 *  1. RIEN N'EST ÉCRASÉ EN SILENCE. Un produit existant n'est modifié que si
 *     l'utilisateur a choisi le mode « mise à jour », et l'écran lui montre
 *     combien de lignes seront modifiées avant qu'il ne valide.
 *
 *  2. TOUT EST TRACÉ. Chaque ligne laisse une entrée dans le journal d'import,
 *     avec ce qu'elle a produit. C'est ce qui rend l'annulation possible : on
 *     sait exactement quelles entités ce lot a créées.
 *
 * L'analyse et l'application sont séparées : on n'écrit jamais sans avoir
 * montré le rapport.
 */

export interface ImportPlan {
  report: AnalysisReport;
  mode: ImportMode;
  fileName: string;
  sheetName: string;
  mapping: Record<number, string>;
}

export interface ImportResult {
  batchId: string;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  unitsCreated: number;
  /** Catégories et fournisseurs créés au passage, à partir du fichier. */
  categoriesCreated: number;
  suppliersCreated: number;
}

export class ImportService {
  private readonly products: ProductRepository;
  private readonly units: UnitRepository;
  private readonly audit: AuditService;

  constructor(private readonly context: AppContext) {
    this.products = new ProductRepository(context.db);
    this.units = new UnitRepository(context.db);
    this.audit = new AuditService(context);
  }

  /**
   * Analyse un fichier sans rien écrire.
   *
   * Les SKU et identifiants déjà présents sont chargés ICI, en deux requêtes,
   * plutôt qu'une par ligne : un fichier de trois mille lignes ferait sinon six
   * mille allers-retours.
   */
  async plan(
    sheet: SheetData,
    mapping: Record<number, string>,
    mode: ImportMode,
    fileName: string,
  ): Promise<ImportPlan> {
    assertCan(this.context, PERMISSIONS.importRun);

    const skus = new Set<string>();
    const identifiers = new Set<string>();
    for (const row of sheet.rows) {
      for (const [column, key] of Object.entries(mapping)) {
        const value = (row[Number(column)] ?? '').trim();
        if (value === '') continue;
        if (key === 'sku') skus.add(value);
        if (key === 'imei1' || key === 'imei2') identifiers.add(value.replace(/\D/g, ''));
        if (key === 'serial') identifiers.add(value.toUpperCase().replace(/\s+/g, ''));
      }
    }

    const existingSkus = await this.existingSkus([...skus]);
    const existingIdentifiers = await this.units.existingIdentifiers([...identifiers]);

    const report = analyze(sheet, mapping, {
      existingSkus,
      existingIdentifiers,
      mode,
      currencyDecimals: this.context.settings.currency.decimals,
      strictImeiChecksum: this.context.settings.strictImeiChecksum,
    });

    return { report, mode, fileName, sheetName: sheet.name, mapping };
  }

  /**
   * Applique un plan validé.
   *
   * Les lignes en erreur sont IGNORÉES, pas bloquantes : un fichier de mille
   * lignes dont trois sont fautives doit pouvoir entrer, avec un rapport
   * nommant les trois. Refuser tout obligerait à corriger le fichier à
   * l'aveugle, ligne par ligne, sans jamais voir l'ensemble des erreurs.
   */
  async apply(plan: ImportPlan): Promise<ImportResult> {
    assertCan(this.context, PERMISSIONS.importRun);
    const userId = this.context.session?.id;
    if (!userId) throw new BusinessError('Session requise.');
    if (plan.report.missingFields.length > 0) {
      throw new BusinessError(
        `Champs obligatoires non associés : ${plan.report.missingFields.join(', ')}.`,
      );
    }

    const batchId = newId();
    const startedAt = nowIso();
    await this.context.db.execute(
      `INSERT INTO import_batch (id, shop_id, file_name, sheet_name, mode, status, mapping,
                                 total_rows, started_at, user_id)
       VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
      [
        batchId,
        this.context.shopId,
        plan.fileName,
        plan.sheetName,
        plan.mode,
        JSON.stringify(plan.mapping),
        plan.report.rows.length,
        startedAt,
        userId,
      ],
    );

    const result: ImportResult = {
      batchId,
      created: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      unitsCreated: 0,
      categoriesCreated: 0,
      suppliersCreated: 0,
    };
    const productService = new ProductService(this.context);
    const stockService = new StockService(this.context);
    // Catégories et fournisseurs sont créés à la volée d'après le fichier :
    // obliger le gérant à les saisir d'avance, à l'identique, transformerait un
    // import de dix minutes en une matinée de préparation.
    const categories = new ReferenceCache(
      (libelle) => this.findCategory(libelle),
      (libelle) => this.createCategory(libelle),
    );
    const suppliers = new ReferenceCache(
      (libelle) => this.findSupplier(libelle),
      (libelle) => this.createSupplier(libelle),
    );
    // Un même SKU peut revenir sur plusieurs lignes (un modèle, dix appareils) :
    // on mémorise le produit créé pour ne pas le recréer à chaque ligne.
    const productIdBySku = new Map<string, string>();

    for (const row of plan.report.rows) {
      if (row.outcome === 'ERROR' || !row.product) {
        result.errors += 1;
        await this.logRow(batchId, row, 'ERROR', null, null, row.problems.join(' '));
        continue;
      }
      if (row.outcome === 'SKIP') {
        result.skipped += 1;
        await this.logRow(batchId, row, 'SKIPPED', null, null, row.warnings.join(' '));
        continue;
      }

      try {
        const categoryId = row.categoryLabel ? await categories.resolve(row.categoryLabel) : null;
        if (categoryId && categories.consumeCreation()) result.categoriesCreated += 1;
        const supplierId = row.supplierLabel ? await suppliers.resolve(row.supplierLabel) : null;
        if (supplierId && suppliers.consumeCreation()) result.suppliersCreated += 1;

        const productId = await this.upsertProduct(
          row,
          plan.mode,
          productIdBySku,
          productService,
          result,
          { categoryId, supplierId },
        );

        if (row.unit) {
          const [unitId] = await stockService.receiveUnits({
            productId,
            units: [
              {
                imei1: row.unit.imei1,
                imei2: row.unit.imei2,
                serial: row.unit.serial,
                color: row.product.attributes['couleur'] ?? null,
                capacity: row.product.attributes['capacite'] ?? null,
                condition: row.condition ?? 'NEW',
                costPrice: row.product.purchasePrice,
              },
            ],
            supplierId,
            source: 'IMPORT',
            sourceId: batchId,
            sourceLabel: plan.fileName,
          });
          result.unitsCreated += 1;
          await this.logRow(batchId, row, 'CREATED', 'product_unit', unitId ?? null, null);
        } else if (row.quantity > 0 && row.product.tracking === 'QUANTITY') {
          await stockService.receiveQuantity({
            productId,
            quantity: row.quantity,
            unitCost: row.product.purchasePrice,
            source: 'IMPORT',
            sourceId: batchId,
            sourceLabel: plan.fileName,
          });
          await this.logRow(batchId, row, 'CREATED', 'product', productId, null);
        } else {
          await this.logRow(
            batchId,
            row,
            row.outcome === 'UPDATE' ? 'UPDATED' : 'CREATED',
            'product',
            productId,
            null,
          );
        }
      } catch (cause) {
        result.errors += 1;
        const message = cause instanceof Error ? cause.message : String(cause);
        await this.logRow(batchId, row, 'ERROR', null, null, message);
      }
    }

    await this.context.db.execute(
      `UPDATE import_batch SET status = 'APPLIED', created_rows = ?, updated_rows = ?,
              skipped_rows = ?, error_rows = ?, finished_at = ?
       WHERE id = ?`,
      [result.created, result.updated, result.skipped, result.errors, nowIso(), batchId],
    );

    await this.context.db.transaction(async (tx) => {
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.import,
        entity: 'import_batch',
        entityId: batchId,
        after: {
          fichier: plan.fileName,
          feuille: plan.sheetName,
          mode: plan.mode,
          crees: result.created,
          modifies: result.updated,
          ignores: result.skipped,
          erreurs: result.errors,
          appareils: result.unitsCreated,
        },
      });
    });

    return result;
  }

  /**
   * Annule un import.
   *
   * CE QUI EST RÉVERSIBLE : les appareils créés par le lot et jamais bougés
   * depuis. CE QUI NE L'EST PAS : un appareil déjà vendu ou transféré, et les
   * modifications de produits — leur état antérieur n'est pas conservé ligne à
   * ligne. La méthode annule ce qu'elle peut et DIT ce qu'elle n'a pas pu
   * défaire, plutôt que de prétendre à un retour en arrière complet.
   */
  async rollback(batchId: string): Promise<{ removed: number; kept: number; reasons: string[] }> {
    assertCan(this.context, PERMISSIONS.importRun);

    const rows = await this.context.db.select<{ entity_id: string }>(
      `SELECT entity_id FROM import_row
       WHERE batch_id = ? AND entity = 'product_unit' AND outcome = 'CREATED'
         AND entity_id IS NOT NULL`,
      [batchId],
    );

    let removed = 0;
    const reasons: string[] = [];
    for (const row of rows) {
      const unit = await this.units.byId(row.entity_id);
      if (!unit) continue;
      if (unit.status !== 'IN_STOCK') {
        reasons.push(
          `${unit.imei1 ?? unit.serial ?? unit.id.slice(0, 8)} : statut « ${unit.status} », conservé.`,
        );
        continue;
      }
      const movements = await this.context.db.select<{ total: number }>(
        `SELECT COUNT(*) AS total FROM stock_movement WHERE unit_id = ? AND source <> 'IMPORT'`,
        [unit.id],
      );
      if ((movements[0]?.total ?? 0) > 0) {
        reasons.push(
          `${unit.imei1 ?? unit.serial ?? unit.id.slice(0, 8)} : a déjà bougé, conservé.`,
        );
        continue;
      }

      await this.context.db.transaction(async (tx) => {
        await tx.execute('DELETE FROM unit_identifier WHERE unit_id = ?', [unit.id]);
        await tx.execute(`DELETE FROM stock_movement WHERE unit_id = ? AND source = 'IMPORT'`, [
          unit.id,
        ]);
        await tx.execute('DELETE FROM product_unit WHERE id = ?', [unit.id]);
        await tx.execute(`DELETE FROM sync_outbox WHERE entity_id = ? AND status = 'PENDING'`, [
          unit.id,
        ]);
      });
      removed += 1;
    }

    await this.context.db.execute(`UPDATE import_batch SET status = 'ROLLED_BACK' WHERE id = ?`, [
      batchId,
    ]);
    await this.context.db.transaction(async (tx) => {
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.import,
        entity: 'import_batch',
        entityId: batchId,
        after: { annulation: true, supprimes: removed, conserves: reasons.length },
      });
    });

    return { removed, kept: reasons.length, reasons };
  }

  /** Journal des imports, pour l'écran d'historique. */
  async history(limit = 50): Promise<
    {
      id: string;
      fileName: string;
      sheetName: string | null;
      status: string;
      mode: string;
      totals: { total: number; created: number; updated: number; skipped: number; errors: number };
      startedAt: string;
      userLabel: string;
    }[]
  > {
    const rows = await this.context.db.select<{
      id: string;
      file_name: string;
      sheet_name: string | null;
      status: string;
      mode: string;
      total_rows: number;
      created_rows: number;
      updated_rows: number;
      skipped_rows: number;
      error_rows: number;
      started_at: string;
      user_label: string;
    }>(
      `SELECT b.*, u.full_name AS user_label FROM import_batch b
       JOIN app_user u ON u.id = b.user_id
       WHERE b.shop_id = ? ORDER BY b.started_at DESC LIMIT ?`,
      [this.context.shopId, limit],
    );
    return rows.map((row) => ({
      id: row.id,
      fileName: row.file_name,
      sheetName: row.sheet_name,
      status: row.status,
      mode: row.mode,
      totals: {
        total: row.total_rows,
        created: row.created_rows,
        updated: row.updated_rows,
        skipped: row.skipped_rows,
        errors: row.error_rows,
      },
      startedAt: row.started_at,
      userLabel: row.user_label,
    }));
  }

  async rowsOf(
    batchId: string,
    outcome?: string,
  ): Promise<{ rowNumber: number; outcome: string; message: string | null }[]> {
    const rows = await this.context.db.select<{
      row_number: number;
      outcome: string;
      message: string | null;
    }>(
      `SELECT row_number, outcome, message FROM import_row
       WHERE batch_id = ? ${outcome ? 'AND outcome = ?' : ''}
       ORDER BY row_number LIMIT 2000`,
      outcome ? [batchId, outcome] : [batchId],
    );
    return rows.map((row) => ({
      rowNumber: row.row_number,
      outcome: row.outcome,
      message: row.message,
    }));
  }

  /* ─── Détail ──────────────────────────────────────────────────────────── */

  private async upsertProduct(
    row: AnalyzedRow,
    mode: ImportMode,
    cache: Map<string, string>,
    service: ProductService,
    result: ImportResult,
    references: { categoryId: string | null; supplierId: string | null },
  ): Promise<string> {
    const product = row.product;
    if (!product) throw new BusinessError('Ligne sans produit.');

    const cached = cache.get(product.sku);
    if (cached) return cached;

    const existing = await this.products.bySku(product.sku);
    const input = {
      sku: product.sku,
      name: product.name,
      brand: product.brand,
      model: product.model,
      reference: product.reference,
      barcode: product.barcode,
      tracking: product.tracking as Tracking,
      purchasePrice: product.purchasePrice,
      salePrice: product.salePrice,
      minPrice: product.minPrice,
      taxRate: product.taxRate,
      unit: product.unit,
      minStock: product.minStock,
      // Couleur et capacité sont des AXES DE VARIATION, pas des attributs
      // libres : le service les range en colonnes et les retire des attributs.
      color: product.attributes['couleur'] ?? null,
      capacity: product.attributes['capacite'] ?? null,
      attributes: product.attributes,
      categoryId: references.categoryId,
      defaultSupplierId: references.supplierId,
    };

    if (existing) {
      // Mise à jour SEULEMENT si l'utilisateur l'a demandée : c'est la règle
      // « ne jamais écraser en silence » du §8.
      if (mode !== 'CREATE_ONLY') {
        // `ProductService.update` consigne lui-même les prix modifiés : le
        // faire ici en plus créerait deux points pour un seul changement.
        await service.update(existing.id, input);
        result.updated += 1;
      }
      cache.set(product.sku, existing.id);
      return existing.id;
    }

    const id = await service.create(input);
    result.created += 1;
    cache.set(product.sku, id);
    return id;
  }

  private async logRow(
    batchId: string,
    row: AnalyzedRow,
    outcome: 'CREATED' | 'UPDATED' | 'SKIPPED' | 'ERROR',
    entity: string | null,
    entityId: string | null,
    message: string | null,
  ): Promise<void> {
    await this.context.db.execute(
      `INSERT INTO import_row (id, batch_id, row_number, outcome, entity, entity_id, message, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId(),
        batchId,
        row.rowNumber,
        outcome,
        entity,
        entityId,
        message && message !== '' ? message.slice(0, 500) : null,
        JSON.stringify(row.values),
      ],
    );
  }

  private async findCategory(libelle: string): Promise<string | null> {
    const rows = await this.context.db.select<{ id: string }>(
      'SELECT id FROM category WHERE deleted_at IS NULL AND (code = ? OR name = ?) LIMIT 1',
      [codeDe(libelle), libelle],
    );
    return rows[0]?.id ?? null;
  }

  private async createCategory(libelle: string): Promise<string> {
    return new CategoryRepository(this.context.db).create({ code: codeDe(libelle), name: libelle });
  }

  private async findSupplier(libelle: string): Promise<string | null> {
    const rows = await this.context.db.select<{ id: string }>(
      'SELECT id FROM supplier WHERE deleted_at IS NULL AND (code = ? OR name = ?) LIMIT 1',
      [codeDe(libelle), libelle],
    );
    return rows[0]?.id ?? null;
  }

  private async createSupplier(libelle: string): Promise<string> {
    // Le fichier ne donne qu'un code (« GOODL », « AWAP ») : on le reprend comme
    // nom, à charge pour le gérant de compléter la fiche. Mieux vaut un
    // fournisseur incomplet mais rattaché qu'un achat sans fournisseur.
    return new SupplierRepository(this.context.db).create({
      code: codeDe(libelle),
      name: libelle,
    });
  }

  private async existingSkus(skus: readonly string[]): Promise<Set<string>> {
    const found = new Set<string>();
    const size = 400;
    for (let index = 0; index < skus.length; index += size) {
      const batch = skus.slice(index, index + size);
      if (batch.length === 0) continue;
      const rows = await this.context.db.select<{ sku: string }>(
        `SELECT sku FROM product WHERE deleted_at IS NULL AND sku IN (${batch.map(() => '?').join(', ')})`,
        [...batch],
      );
      for (const row of rows) found.add(row.sku);
    }
    return found;
  }
}
