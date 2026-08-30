import {
  PERMISSIONS,
  SYNC_EVENT,
  Validator,
  derivedSku,
  isDerivedSku,
  isEmail,
  isPhone,
  nextFreeSku,
  variantGroupKey,
} from '@boutique/shared';
import type { Product } from '@boutique/shared';
import { ProductRepository, type ProductInput } from '../db/repositories/product.repository';
import { SupplierRepository, type SupplierInput } from '../db/repositories/supplier.repository';
import { CategoryRepository } from '../db/repositories/category.repository';
import { OutboxRepository } from '../db/repositories/outbox.repository';
import {
  PriceHistoryRepository,
  type PriceKind,
} from '../db/repositories/price-history.repository';
import { AUDIT_ACTIONS } from '../db/repositories/audit.repository';
import { AuditService } from './audit.service';
import { BusinessError, assertCan, type AppContext } from './context';
import type { SqlExecutor } from '../db/client';

/**
 * Catalogue : produits, fournisseurs, catégories.
 *
 * Le catalogue est la seule donnée qui se PARTAGE entre boutiques : un produit
 * créé au Centre doit pouvoir être vendu au Nord sans double saisie. Chaque
 * écriture émet donc un événement, contrairement au stock, qui reste propre à
 * chaque boutique.
 */

/** Instantané complet d'un produit, tel qu'il voyage dans un événement. */
export function productSnapshot(product: Product): Record<string, unknown> {
  return {
    id: product.id,
    sku: product.sku,
    reference: product.reference,
    barcode: product.barcode,
    name: product.name,
    brand: product.brand,
    model: product.model,
    categoryId: product.categoryId,
    description: product.description,
    tracking: product.tracking,
    purchasePrice: product.purchasePrice,
    salePrice: product.salePrice,
    minPrice: product.minPrice,
    taxRate: product.taxRate,
    unit: product.unit,
    minStock: product.minStock,
    status: product.status,
    attributes: product.attributes,
    updatedAt: product.updatedAt,
  };
}

export class ProductService {
  private readonly products: ProductRepository;
  private readonly audit: AuditService;

  constructor(private readonly context: AppContext) {
    this.products = new ProductRepository(context.db);
    this.audit = new AuditService(context);
  }

  async create(input: ProductInput): Promise<string> {
    assertCan(this.context, PERMISSIONS.productManage);
    const complet = this.normalise({ ...input, sku: await this.resolveSku(input, null) });
    await this.validate(complet, null);

    let id = '';
    await this.context.db.transaction(async (tx) => {
      id = await new ProductRepository(tx).create(complet);
      // Point de départ de l'historique : sans lui, la première variation
      // partirait de nulle part et la courbe commencerait au deuxième prix.
      await this.recordPrices(tx, id, null, complet, 'MANUAL');
      await new OutboxRepository(tx).enqueue({
        type: SYNC_EVENT.productCreated,
        entity: 'product',
        entityId: id,
        shopId: this.context.shopId,
        userId: this.context.session?.id ?? null,
        payload: { ...complet, id },
      });
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.create,
        entity: 'product',
        entityId: id,
        after: { sku: complet.sku, nom: complet.name, prixVente: complet.salePrice },
      });
    });
    return id;
  }

  async update(id: string, input: ProductInput): Promise<void> {
    assertCan(this.context, PERMISSIONS.productManage);
    const before = await this.products.byId(id);
    if (!before) throw new BusinessError('Produit introuvable.');
    // À la modification, une référence SAISIE est conservée telle quelle :
    // effacer le champ ne doit jamais renommer une fiche que des documents
    // citent déjà.
    //
    // Une référence DÉRIVÉE, en revanche, suit la déclinaison. Sans cela, un
    // produit passé de « 512 Silver » à « 128 Rouge » garderait un SKU
    // `AUTO-…-512-SILVER` qui contredirait sa propre fiche — exactement le
    // genre de détail qui fait douter de tout le reste.
    const conserve = input.sku?.trim() || (isDerivedSku(before.sku) ? '' : before.sku);
    const complet = this.normalise({
      ...input,
      sku: conserve || (await this.resolveSku(input, id)),
    });
    await this.validate(complet, id);

    // Changer le mode de suivi d'un produit qui a déjà du stock rendrait
    // incohérent tout ce qui existe : des unités sans quantité, ou l'inverse.
    if (before.tracking !== input.tracking) {
      const units = await this.context.db.select<{ total: number }>(
        'SELECT COUNT(*) AS total FROM product_unit WHERE product_id = ?',
        [id],
      );
      const level = await this.context.db.select<{ total: number }>(
        'SELECT COALESCE(SUM(quantity), 0) AS total FROM stock_level WHERE product_id = ?',
        [id],
      );
      if ((units[0]?.total ?? 0) > 0 || (level[0]?.total ?? 0) !== 0) {
        throw new BusinessError(
          'Ce produit a déjà du stock : son mode de suivi ne peut plus changer. Créez un nouveau produit.',
        );
      }
    }

    await this.context.db.transaction(async (tx) => {
      await new ProductRepository(tx).update(id, complet);
      await this.recordPrices(tx, id, before, complet, 'MANUAL');
      await new OutboxRepository(tx).enqueue({
        type: SYNC_EVENT.productUpdated,
        entity: 'product',
        entityId: id,
        shopId: this.context.shopId,
        userId: this.context.session?.id ?? null,
        payload: { ...complet, id },
      });
      await this.audit.recordChange(
        tx,
        input.salePrice !== before.salePrice ? AUDIT_ACTIONS.priceChange : AUDIT_ACTIONS.update,
        'product',
        id,
        {
          sku: before.sku,
          nom: before.name,
          prixAchat: before.purchasePrice,
          prixVente: before.salePrice,
          statut: before.status,
        },
        {
          sku: complet.sku,
          nom: complet.name,
          prixAchat: complet.purchasePrice,
          prixVente: complet.salePrice,
          statut: complet.status ?? 'ACTIVE',
        },
      );
    });
  }

  /**
   * Consigne les prix qui ont changé.
   *
   * Les trois prix sont traités séparément : baisser un prix de vente et subir
   * une hausse du prix d'achat sont deux événements distincts, et les fondre en
   * une seule ligne rendrait l'historique inexploitable.
   *
   * Un prix inchangé n'écrit rien — le dépôt s'en assure.
   */
  private async recordPrices(
    tx: SqlExecutor,
    productId: string,
    avant: Pick<Product, 'purchasePrice' | 'salePrice' | 'minPrice'> | null,
    apres: ProductInput,
    source: 'MANUAL' | 'IMPORT',
  ): Promise<void> {
    const historique = new PriceHistoryRepository(tx);
    const acteur = this.context.session;

    const points: { kind: PriceKind; ancien: number | null; nouveau: number | null }[] = [
      { kind: 'PURCHASE', ancien: avant?.purchasePrice ?? null, nouveau: apres.purchasePrice },
      { kind: 'SALE', ancien: avant?.salePrice ?? null, nouveau: apres.salePrice },
      { kind: 'MIN', ancien: avant?.minPrice ?? null, nouveau: apres.minPrice ?? null },
    ];

    for (const point of points) {
      if (point.nouveau === null) continue;
      await historique.record({
        productId,
        kind: point.kind,
        oldValue: point.ancien,
        newValue: point.nouveau,
        source,
        shopId: this.context.shopId,
        userId: acteur?.id ?? null,
        userLabel: acteur?.fullName ?? null,
      });
    }
  }

  /**
   * Ce qui empêche une suppression définitive.
   *
   * Un produit cité par une vente, un achat, un transfert ou un mouvement
   * appartient à l'histoire comptable de la boutique : l'effacer rendrait
   * illisibles des documents déjà émis. On compte donc ces références AVANT de
   * décider — et l'on dit à l'utilisateur ce qui retient sa suppression, plutôt
   * que de refuser sans expliquer.
   */
  async deletionImpact(id: string): Promise<{
    units: number;
    stock: number;
    saleLines: number;
    purchaseLines: number;
    transferLines: number;
    movements: number;
    /** Vrai si rien ne le cite : la suppression peut être définitive. */
    removable: boolean;
  }> {
    const compter = async (sql: string): Promise<number> => {
      const rows = await this.context.db.select<{ total: number }>(sql, [id]);
      return rows[0]?.total ?? 0;
    };

    const impact = {
      units: await compter('SELECT COUNT(*) AS total FROM product_unit WHERE product_id = ?'),
      stock: await compter(
        'SELECT COALESCE(SUM(ABS(quantity)), 0) AS total FROM stock_level WHERE product_id = ?',
      ),
      saleLines: await compter('SELECT COUNT(*) AS total FROM sale_line WHERE product_id = ?'),
      purchaseLines: await compter(
        'SELECT COUNT(*) AS total FROM purchase_line WHERE product_id = ?',
      ),
      transferLines: await compter(
        'SELECT COUNT(*) AS total FROM transfer_line WHERE product_id = ?',
      ),
      movements: await compter('SELECT COUNT(*) AS total FROM stock_movement WHERE product_id = ?'),
    };

    return {
      ...impact,
      removable: Object.values(impact).every((valeur) => valeur === 0),
    };
  }

  /**
   * Supprime un produit.
   *
   * DEUX COMPORTEMENTS, et l'appelant sait lequel s'est appliqué :
   *
   *  - rien ne le cite (créé par erreur, jamais reçu ni vendu) : il est effacé
   *    POUR DE BON, avec les entrées de file de synchronisation qui n'ont pas
   *    encore été envoyées. C'est le cas d'une faute de frappe qu'on corrige
   *    dans la minute, et laisser une fiche fantôme au catalogue serait une
   *    pollution que personne ne nettoie jamais.
   *  - il a une histoire : il est ARCHIVÉ (§27). Il disparaît des listes et du
   *    comptoir, mais tous les documents qui le citent restent lisibles.
   */
  async remove(id: string): Promise<{ definitive: boolean }> {
    assertCan(this.context, PERMISSIONS.productManage);
    const produit = await this.products.byId(id);
    if (!produit) throw new BusinessError('Produit introuvable.');

    const impact = await this.deletionImpact(id);

    if (!impact.removable) {
      await this.archive(id);
      return { definitive: false };
    }

    await this.context.db.transaction(async (tx) => {
      await tx.execute('DELETE FROM stock_level WHERE product_id = ?', [id]);
      // L'historique des prix référence le produit. Ce n'est PAS un document
      // comptable — c'est une donnée dérivée du produit lui-même — donc il
      // disparaît avec lui plutôt que d'empêcher sa suppression.
      await tx.execute('DELETE FROM price_history WHERE product_id = ?', [id]);
      await tx.execute(
        `DELETE FROM sync_outbox WHERE entity = 'product' AND entity_id = ? AND status = 'PENDING'`,
        [id],
      );
      await tx.execute('DELETE FROM product WHERE id = ?', [id]);
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.softDelete,
        entity: 'product',
        entityId: id,
        before: { sku: produit.sku, nom: produit.name, suppression: 'définitive' },
      });
    });

    return { definitive: true };
  }

  /**
   * Supprime plusieurs produits d'un coup.
   *
   * Chaque produit garde sa propre issue — effacé ou archivé selon son
   * histoire : appliquer la même décision à tout le lot effacerait des fiches
   * citées par des ventes, ou archiverait inutilement des fiches vierges.
   *
   * Un échec sur l'un n'interrompt pas les autres, et le rapport nomme ce qui
   * n'a pas pu être supprimé : découvrir les trois problèmes d'un coup vaut
   * mieux que les découvrir un par un.
   */
  async removeMany(ids: readonly string[]): Promise<{
    deleted: number;
    archived: number;
    failed: { id: string; name: string; reason: string }[];
  }> {
    assertCan(this.context, PERMISSIONS.productManage);
    const rapport = {
      deleted: 0,
      archived: 0,
      failed: [] as { id: string; name: string; reason: string }[],
    };

    for (const id of ids) {
      const produit = await this.products.byId(id);
      try {
        const resultat = await this.remove(id);
        if (resultat.definitive) rapport.deleted += 1;
        else rapport.archived += 1;
      } catch (cause) {
        rapport.failed.push({
          id,
          name: produit?.name ?? id,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    return rapport;
  }

  /** Archivage : le produit disparaît des listes, son historique reste lisible. */
  async archive(id: string): Promise<void> {
    assertCan(this.context, PERMISSIONS.productManage);
    const product = await this.products.byId(id);
    if (!product) throw new BusinessError('Produit introuvable.');

    await this.context.db.transaction(async (tx) => {
      await new ProductRepository(tx).softDelete(id);
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.softDelete,
        entity: 'product',
        entityId: id,
        before: { sku: product.sku, nom: product.name },
      });
    });
  }

  /**
   * Détermine la référence d'un produit.
   *
   * Renseignée par l'utilisateur, elle est reprise telle quelle. Absente, elle
   * est dérivée du modèle — désignation, marque et caractéristiques — puis
   * suffixée jusqu'à être libre. C'est la seule façon de rendre le champ
   * facultatif à l'écran tout en gardant une clé unique en base.
   */
  /**
   * Complète les champs dérivés d'un produit.
   *
   * Deux choses s'y jouent :
   *
   *  - la COULEUR et la CAPACITÉ acceptent encore d'arriver dans `attributes`
   *    (c'est le cas des imports anciens et de l'événement de synchronisation
   *    d'une version antérieure) ; elles sont remontées en colonnes, et
   *    retirées des attributs pour qu'il n'existe qu'une seule vérité ;
   *  - la CLÉ DE VARIANTE est toujours recalculée, jamais reprise de
   *    l'appelant : deux écrans qui la calculeraient différemment casseraient
   *    le regroupement sans qu'on s'en aperçoive.
   */
  private normalise(input: ProductInput & { sku: string }): ProductInput & { sku: string } {
    const attributs = { ...(input.attributes ?? {}) };
    const couleur = input.color?.trim() || attributs['couleur'] || null;
    const capacite = input.capacity?.trim() || attributs['capacite'] || null;
    delete attributs['couleur'];
    delete attributs['capacite'];

    return {
      ...input,
      color: couleur,
      capacity: capacite,
      attributes: attributs,
      variantGroup: variantGroupKey({
        brand: input.brand,
        model: input.model,
        name: input.name,
      }),
    };
  }

  private async resolveSku(input: ProductInput, currentId: string | null): Promise<string> {
    const fournie = input.sku?.trim();
    if (fournie) return fournie;

    const base = derivedSku([
      input.name,
      input.brand,
      input.capacity ?? input.attributes?.['capacite'],
      input.color ?? input.attributes?.['couleur'],
    ]);
    return nextFreeSku(base, async (candidat) => {
      const existant = await this.products.bySku(candidat);
      return existant !== null && existant.id !== currentId;
    });
  }

  private async validate(
    input: ProductInput & { sku: string },
    currentId: string | null,
  ): Promise<void> {
    const validator = new Validator();
    validator.required(input.name, 'name', 'Le nom');
    validator.notNegative(input.purchasePrice, 'purchasePrice', "Le prix d'achat");
    validator.notNegative(input.salePrice, 'salePrice', 'Le prix de vente');
    validator.maxLength(input.sku, 64, 'sku', 'Le SKU');
    validator.maxLength(input.name, 200, 'name', 'Le nom');
    if (input.minPrice != null) {
      validator.notNegative(input.minPrice, 'minPrice', 'Le prix plancher');
      validator.check(
        input.minPrice <= input.salePrice,
        'minPrice',
        'Le prix plancher ne peut pas dépasser le prix de vente.',
      );
    }
    validator.throwIfInvalid();

    const existing = await this.products.bySku(input.sku);
    if (existing && existing.id !== currentId) {
      throw new BusinessError(`Le SKU « ${input.sku} » est déjà utilisé.`, 'DUPLICATE_SKU');
    }
  }
}

export class SupplierService {
  private readonly suppliers: SupplierRepository;
  private readonly audit: AuditService;

  constructor(private readonly context: AppContext) {
    this.suppliers = new SupplierRepository(context.db);
    this.audit = new AuditService(context);
  }

  async save(input: SupplierInput, id?: string): Promise<string> {
    assertCan(this.context, PERMISSIONS.supplierManage);

    const validator = new Validator();
    validator.required(input.name, 'name', 'Le nom');
    validator.required(input.code, 'code', 'Le code');
    if (input.email)
      validator.check(isEmail(input.email), 'email', "L'adresse e-mail est invalide.");
    if (input.phone) validator.check(isPhone(input.phone), 'phone', 'Le téléphone est invalide.');
    validator.throwIfInvalid();

    const clash = await this.suppliers.byCode(input.code);
    if (clash && clash.id !== id) {
      throw new BusinessError(`Le code « ${input.code} » est déjà utilisé.`);
    }

    let saved = id ?? '';
    await this.context.db.transaction(async (tx) => {
      const repository = new SupplierRepository(tx);
      if (id) {
        await repository.update(id, input);
      } else {
        saved = await repository.create(input);
      }
      await new OutboxRepository(tx).enqueue({
        type: SYNC_EVENT.supplierUpserted,
        entity: 'supplier',
        entityId: saved,
        shopId: this.context.shopId,
        userId: this.context.session?.id ?? null,
        payload: { ...input, id: saved },
      });
      await this.audit.record(tx, {
        action: id ? AUDIT_ACTIONS.update : AUDIT_ACTIONS.create,
        entity: 'supplier',
        entityId: saved,
        after: { code: input.code, nom: input.name },
      });
    });
    return saved;
  }

  async archive(id: string): Promise<void> {
    assertCan(this.context, PERMISSIONS.supplierManage);
    await this.context.db.transaction(async (tx) => {
      await new SupplierRepository(tx).softDelete(id);
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.softDelete,
        entity: 'supplier',
        entityId: id,
      });
    });
  }
}

export class CategoryService {
  constructor(private readonly context: AppContext) {}

  async create(input: { code: string; name: string; parentId?: string | null }): Promise<string> {
    assertCan(this.context, PERMISSIONS.productManage);
    const repository = new CategoryRepository(this.context.db);
    if (await repository.byCode(input.code)) {
      throw new BusinessError(`La catégorie « ${input.code} » existe déjà.`);
    }
    return repository.create(input);
  }

  async rename(id: string, name: string): Promise<void> {
    assertCan(this.context, PERMISSIONS.productManage);
    await new CategoryRepository(this.context.db).update(id, { name });
  }

  async remove(id: string): Promise<void> {
    assertCan(this.context, PERMISSIONS.productManage);
    await new CategoryRepository(this.context.db).softDelete(id);
  }
}
