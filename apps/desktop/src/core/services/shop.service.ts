import { PERMISSIONS, Validator, isEmail, isPhone } from '@boutique/shared';
import type { Shop, ShopStatus } from '@boutique/shared';
import { ShopRepository, type ShopInput } from '../db/repositories/shop.repository';
import { UserRepository } from '../db/repositories/user.repository';
import { AUDIT_ACTIONS } from '../db/repositories/audit.repository';
import { AuditService } from './audit.service';
import { BusinessError, assertCan, assertQuota, type AppContext } from './context';

/**
 * Boutiques de la société.
 *
 * Le réseau ENTIER est décrit dans chaque base locale : sans cela, une boutique
 * hors ligne ne pourrait pas préparer un transfert vers une destination qu'elle
 * ne connaît pas encore. Créer une boutique ici la rend donc immédiatement
 * disponible comme destination, avant même la première synchronisation.
 *
 * Une seule ligne porte `is_local` : celle installée sur CE poste. Un index
 * partiel l'impose, et le service refuse d'en changer sans conséquence — voir
 * `setLocal`.
 */

export interface ShopSummary extends Shop {
  users: number;
  products: number;
  units: number;
  pendingTransfers: number;
}

export class ShopService {
  private readonly shops: ShopRepository;
  private readonly audit: AuditService;

  constructor(private readonly context: AppContext) {
    this.shops = new ShopRepository(context.db);
    this.audit = new AuditService(context);
  }

  /** Toutes les boutiques du réseau, avec ce que chacune détient. */
  async list(): Promise<ShopSummary[]> {
    assertCan(this.context, PERMISSIONS.shopManage);
    const boutiques = await this.shops.list();
    const resume: ShopSummary[] = [];

    for (const boutique of boutiques) {
      const compter = async (sql: string, params: unknown[]): Promise<number> => {
        const rows = await this.context.db.select<{ total: number }>(sql, params);
        return rows[0]?.total ?? 0;
      };
      const id = boutique.id;

      resume.push({
        ...boutique,
        users: await compter(
          'SELECT COUNT(*) AS total FROM app_user WHERE shop_id = ? AND deleted_at IS NULL',
          [id],
        ),
        // Un produit « présent » dans une boutique, c'est un produit dont elle
        // détient au moins un appareil OU une quantité non nulle : les deux
        // modèles de stock coexistent, et n'en compter qu'un donnerait un
        // chiffre faux pour la moitié du catalogue.
        products: await compter(
          `SELECT COUNT(DISTINCT product_id) AS total FROM (
             SELECT product_id FROM product_unit WHERE shop_id = ? AND deleted_at IS NULL
             UNION
             SELECT product_id FROM stock_level WHERE shop_id = ? AND quantity <> 0
           )`,
          [id, id],
        ),
        units: await compter(
          `SELECT COUNT(*) AS total FROM product_unit
           WHERE shop_id = ? AND deleted_at IS NULL
             AND status IN ('IN_STOCK','RESERVED','RETURNED')`,
          [id],
        ),
        pendingTransfers: await compter(
          `SELECT COUNT(*) AS total FROM transfer
           WHERE (from_shop_id = ? OR to_shop_id = ?) AND deleted_at IS NULL
             AND status IN ('REQUESTED','APPROVED','SHIPPED','IN_TRANSIT')`,
          [id, id],
        ),
      });
    }
    return resume;
  }

  async create(input: ShopInput): Promise<string> {
    assertCan(this.context, PERMISSIONS.shopManage);

    // Le plafond de la licence porte sur le NOMBRE de boutiques, pas sur
    // l'accès à l'écran : on modifie la sienne quoi qu'il arrive, on n'en
    // ajoute une seconde que si elle a été vendue.
    const existantes = await new ShopRepository(this.context.db).list();
    assertQuota(this.context, 'boutiques', existantes.length, 'boutique(s)');

    await this.validate(input, null);

    let id = '';
    await this.context.db.transaction(async (tx) => {
      // `isLocal` n'est JAMAIS accordé à la création : une boutique ne devient
      // celle du poste que par un geste explicite, décrit dans `setLocal`.
      id = await new ShopRepository(tx).create({ ...input, isLocal: false });
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.create,
        entity: 'shop',
        entityId: id,
        after: { code: input.code, nom: input.name },
      });
    });
    return id;
  }

  async update(id: string, input: ShopInput): Promise<void> {
    assertCan(this.context, PERMISSIONS.shopManage);
    const avant = await this.shops.byId(id);
    if (!avant) throw new BusinessError('Boutique introuvable.');
    await this.validate(input, id);

    await this.context.db.transaction(async (tx) => {
      await new ShopRepository(tx).update(id, input);
      await this.audit.recordChange(
        tx,
        AUDIT_ACTIONS.update,
        'shop',
        id,
        { code: avant.code, nom: avant.name, statut: avant.status },
        { code: input.code.toUpperCase(), nom: input.name, statut: input.status ?? avant.status },
      );
    });
  }

  /**
   * Désigne la boutique installée sur CE poste.
   *
   * Opération lourde et rare : elle change l'identité du poste. Tout ce qui a
   * été vendu, reçu et transféré reste rattaché à l'ancienne boutique — c'est
   * voulu, l'historique ne se réécrit pas. En revanche, les prochaines ventes
   * partiront sous la nouvelle. Une base contenant déjà des ventes est donc
   * refusée : il faut une base neuve, sans quoi les rapports mélangeraient
   * deux boutiques.
   */
  async setLocal(id: string): Promise<void> {
    assertCan(this.context, PERMISSIONS.shopManage);
    const cible = await this.shops.byId(id);
    if (!cible) throw new BusinessError('Boutique introuvable.');
    if (cible.isLocal) return;
    if (cible.status !== 'ACTIVE') {
      throw new BusinessError('Une boutique suspendue ou fermée ne peut pas être celle du poste.');
    }

    const ventes = await this.context.db.select<{ total: number }>(
      'SELECT COUNT(*) AS total FROM sale WHERE deleted_at IS NULL',
    );
    if ((ventes[0]?.total ?? 0) > 0) {
      throw new BusinessError(
        "Ce poste a déjà enregistré des ventes : changer sa boutique mélangerait deux activités dans les mêmes rapports. Installez l'application sur un poste dédié.",
        'SHOP_IN_USE',
      );
    }

    const precedente = await this.shops.local();
    await this.shops.setLocal(id);
    await this.context.db.transaction(async (tx) => {
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.update,
        entity: 'shop',
        entityId: id,
        before: { boutiqueDuPoste: precedente?.code ?? null },
        after: { boutiqueDuPoste: cible.code },
      });
    });
  }

  /**
   * Ferme une boutique.
   *
   * Suppression LOGIQUE : les ventes, achats et transferts la citent, et
   * l'effacer rendrait illisible tout l'historique du réseau. On refuse tant
   * qu'elle a des comptes actifs ou des transferts en cours — fermer une
   * boutique sous ses utilisateurs les laisserait sans accès sans explication.
   */
  async close(id: string): Promise<void> {
    assertCan(this.context, PERMISSIONS.shopManage);
    const boutique = await this.shops.byId(id);
    if (!boutique) throw new BusinessError('Boutique introuvable.');
    if (boutique.isLocal) {
      throw new BusinessError('La boutique de ce poste ne peut pas être fermée depuis ce poste.');
    }

    const comptes = await new UserRepository(this.context.db).list(id);
    const actifs = comptes.filter((compte) => compte.status === 'ACTIVE');
    if (actifs.length > 0) {
      throw new BusinessError(
        `${actifs.length} compte(s) actif(s) sont rattachés à cette boutique : réaffectez-les d'abord.`,
      );
    }

    const enCours = await this.context.db.select<{ total: number }>(
      `SELECT COUNT(*) AS total FROM transfer
       WHERE (from_shop_id = ? OR to_shop_id = ?)
         AND status IN ('REQUESTED','APPROVED','SHIPPED','IN_TRANSIT')`,
      [id, id],
    );
    if ((enCours[0]?.total ?? 0) > 0) {
      throw new BusinessError(
        'Des transferts sont en cours avec cette boutique : terminez-les ou annulez-les avant de la fermer.',
      );
    }

    await this.context.db.transaction(async (tx) => {
      await new ShopRepository(tx).update(id, { status: 'CLOSED' });
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.softDelete,
        entity: 'shop',
        entityId: id,
        before: { code: boutique.code, nom: boutique.name },
        after: { statut: 'CLOSED' },
      });
    });
  }

  async setStatus(id: string, status: ShopStatus): Promise<void> {
    assertCan(this.context, PERMISSIONS.shopManage);
    if (status === 'CLOSED') return this.close(id);
    await this.context.db.transaction(async (tx) => {
      await new ShopRepository(tx).update(id, { status });
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.update,
        entity: 'shop',
        entityId: id,
        after: { statut: status },
      });
    });
  }

  private async validate(input: ShopInput, currentId: string | null): Promise<void> {
    const code = input.code.trim().toUpperCase();
    const validator = new Validator();
    validator.required(input.name, 'name', 'Le nom');
    validator.check(
      /^[A-Z0-9]{2,8}$/.test(code),
      'code',
      'Le code doit compter de 2 à 8 lettres ou chiffres : il apparaît dans les numéros de documents.',
    );
    if (input.email)
      validator.check(isEmail(input.email), 'email', "L'adresse e-mail est invalide.");
    if (input.phone) validator.check(isPhone(input.phone), 'phone', 'Le téléphone est invalide.');
    validator.throwIfInvalid();

    const existante = await this.shops.byCode(code);
    if (existante && existante.id !== currentId) {
      throw new BusinessError(
        `Le code « ${code} » est déjà pris par « ${existante.name} ». Deux boutiques partageant un code produiraient des numéros de documents identiques.`,
        'DUPLICATE_CODE',
      );
    }
  }
}
