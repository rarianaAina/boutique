import { CHARGE_LABELS, PERMISSIONS, nowIso, periodRange } from '@boutique/shared';
import type { ChargeCategory, Money } from '@boutique/shared';
import type { DocumentResultat } from '@boutique/documents';
import { ShopRepository } from '../db/repositories/shop.repository';
import { ChargeRepository, type ChargeInput } from '../db/repositories/charge.repository';
import { AUDIT_ACTIONS } from '../db/repositories/audit.repository';
import { AuditService } from './audit.service';
import { BusinessError, assertCan, type AppContext } from './context';

/**
 * Compte de résultat entre deux dates.
 *
 * CE QUE CE DOCUMENT EST, ET CE QU'IL N'EST PAS. Il donne le résultat de
 * l'EXPLOITATION : ce que le commerce a gagné en vendant, moins ce que les
 * marchandises vendues ont coûté, moins ce qu'il en a coûté de tenir la
 * boutique ouverte. Il ne connaît ni amortissements, ni emprunts, ni capital —
 * le logiciel ne les enregistre pas — et ne remplace donc pas les comptes
 * annuels d'un expert-comptable. Il répond à la question qu'un commerçant se
 * pose chaque mois : est-ce que j'ai gagné de l'argent, et où est-il passé ?
 *
 * CHAQUE PÉRIODE PORTE SES PROPRES ÉVÉNEMENTS. Un retour de janvier sur une
 * vente de décembre diminue janvier, pas décembre : décembre est arrêté, et le
 * rouvrir ferait mentir un document déjà imprimé. C'est aussi la seule
 * convention qui rende la somme des mois égale à l'année.
 */

export interface LigneCharge {
  categorie: ChargeCategory;
  libelle: string;
  montant: Money;
  nombre: number;
}

export interface CompteDeResultat {
  /** Bornes de la période, en JOURS du calendrier : « 2026-09-01 ». */
  du: string;
  au: string;

  /** Ventes de la période, au prix affiché, avant toute remise. */
  ventes: Money;
  /** Remises accordées, tous articles confondus. */
  remises: Money;
  /** Remboursements de la période, quelle que soit la date de la vente. */
  retours: Money;
  /** Ce qui reste : le chiffre d'affaires réel de la période. */
  chiffreAffairesNet: Money;

  /** Prix de revient des marchandises effectivement sorties. */
  coutMarchandises: Money;
  /** Chiffre d'affaires net moins le coût des marchandises. */
  margeBrute: Money;
  /** Marge brute rapportée au chiffre d'affaires, en centièmes de point. */
  tauxMarge: number;

  charges: LigneCharge[];
  totalCharges: Money;

  /** Marge brute moins les charges. Le bénéfice, ou la perte. */
  resultat: Money;

  /** Nombre de ventes retenues, pour situer les montants. */
  nombreVentes: number;
}

export class ResultatService {
  constructor(private readonly context: AppContext) {}

  /* ─── Saisie des charges ──────────────────────────────────────────────── */

  async creerCharge(input: Omit<ChargeInput, 'shopId'>): Promise<string> {
    assertCan(this.context, PERMISSIONS.chargeManage);
    this.verifier(input);

    let id = '';
    await this.context.db.transaction(async (tx) => {
      id = await new ChargeRepository(tx).create({ ...input, shopId: this.context.shopId });
      await new AuditService(this.context).record(tx, {
        action: AUDIT_ACTIONS.create,
        entity: 'charge',
        entityId: id,
        after: { categorie: input.category, libelle: input.label, montant: input.amount },
      });
    });
    return id;
  }

  async modifierCharge(id: string, input: Omit<ChargeInput, 'shopId'>): Promise<void> {
    assertCan(this.context, PERMISSIONS.chargeManage);
    this.verifier(input);

    const avant = await new ChargeRepository(this.context.db).byId(id);
    if (!avant) throw new BusinessError('Charge introuvable.');

    await this.context.db.transaction(async (tx) => {
      await new ChargeRepository(tx).update(id, input);
      await new AuditService(this.context).record(tx, {
        action: AUDIT_ACTIONS.update,
        entity: 'charge',
        entityId: id,
        before: { montant: avant.amount, libelle: avant.label },
        after: { montant: input.amount, libelle: input.label },
      });
    });
  }

  async supprimerCharge(id: string): Promise<void> {
    assertCan(this.context, PERMISSIONS.chargeManage);
    const avant = await new ChargeRepository(this.context.db).byId(id);
    if (!avant) throw new BusinessError('Charge introuvable.');

    await this.context.db.transaction(async (tx) => {
      await new ChargeRepository(tx).softDelete(id);
      await new AuditService(this.context).record(tx, {
        action: AUDIT_ACTIONS.softDelete,
        entity: 'charge',
        entityId: id,
        before: { montant: avant.amount, libelle: avant.label },
      });
    });
  }

  private verifier(input: Omit<ChargeInput, 'shopId'>): void {
    if (input.label.trim() === '') throw new BusinessError('Le libellé est obligatoire.');
    if (input.amount <= 0) throw new BusinessError('Le montant doit être positif.');
    if (!input.occurredAt) throw new BusinessError('La date est obligatoire.');
  }

  /* ─── Le compte de résultat ───────────────────────────────────────────── */

  /**
   * Établit le compte de résultat entre deux JOURS, bornes incluses.
   *
   * Les jours sont ceux du CALENDRIER LOCAL — « 2026-09-01 » — et les deux
   * journées entières sont couvertes. C'est le service qui les convertit en
   * instants, et non l'appelant : à Madagascar, trois heures en avance sur
   * UTC, une borne mal convertie fait entrer les ventes du soir du dernier
   * jour dans le mois suivant, ou les en fait sortir. Personne ne s'en
   * apercevrait — les chiffres resteraient plausibles.
   */
  async etablir(du: string, au: string): Promise<CompteDeResultat> {
    assertCan(this.context, PERMISSIONS.reportView);

    // La LISIBILITÉ d'abord, l'ordre ensuite : comparées telles quelles, deux
    // chaînes qui ne sont pas des dates se rangent quand même, et le message
    // d'erreur parlerait d'un intervalle à l'envers là où la saisie est
    // simplement fausse.
    verifierJour(du);
    verifierJour(au);

    // `periodRange` du paquet partagé, et surtout pas un bornage de plus : les
    // écrans de rapports s'en servent déjà, et deux façons de fermer une
    // journée donneraient deux chiffres d'affaires différents pour le même
    // mois selon l'endroit où on le regarde. La borne haute est EXCLUE.
    const { from: debut, to: apres } = periodRange(du, au);
    if (debut >= apres)
      throw new BusinessError('La date de début est postérieure à la date de fin.');

    const boutique = this.context.shopId;

    // Une vente ANNULÉE n'a jamais eu lieu : ni son produit ni son coût
    // n'entrent dans le résultat. Une vente remboursée, elle, a eu lieu — son
    // remboursement est compté à part, à sa propre date.
    const ventes = await this.context.db.select<{
      ventes: number | null;
      remises: number | null;
      cout: number | null;
      nombre: number;
    }>(
      `SELECT
         -- Le montant BRUT, et non line_total : celui-ci est déjà net de la
         -- remise de ligne, que sale.discount porte également. Les additionner
         -- reviendrait à déduire deux fois la même remise.
         (SELECT COALESCE(SUM(l.quantity * l.unit_price), 0)
            FROM sale_line l JOIN sale s ON s.id = l.sale_id
           WHERE s.shop_id = ? AND s.deleted_at IS NULL AND s.status <> 'CANCELLED'
             AND s.sold_at >= ? AND s.sold_at < ?)                          AS ventes,
         (SELECT COALESCE(SUM(s.discount), 0)
            FROM sale s
           WHERE s.shop_id = ? AND s.deleted_at IS NULL AND s.status <> 'CANCELLED'
             AND s.sold_at >= ? AND s.sold_at < ?)                          AS remises,
         (SELECT COALESCE(SUM(l.unit_cost * l.quantity), 0)
            FROM sale_line l JOIN sale s ON s.id = l.sale_id
           WHERE s.shop_id = ? AND s.deleted_at IS NULL AND s.status <> 'CANCELLED'
             AND s.sold_at >= ? AND s.sold_at < ?)                          AS cout,
         (SELECT COUNT(*)
            FROM sale s
           WHERE s.shop_id = ? AND s.deleted_at IS NULL AND s.status <> 'CANCELLED'
             AND s.sold_at >= ? AND s.sold_at < ?)                          AS nombre`,
      [
        boutique,
        debut,
        apres,
        boutique,
        debut,
        apres,
        boutique,
        debut,
        apres,
        boutique,
        debut,
        apres,
      ],
    );

    // Les retours de la période, et le coût des marchandises REVENUES EN
    // STOCK. Un article rendu cassé n'y revient pas : son coût reste une
    // charge, ce qui est exactement ce qu'il est devenu.
    const retours = await this.context.db.select<{
      rembourse: number | null;
      coutRepris: number | null;
    }>(
      `SELECT
         (SELECT COALESCE(SUM(rl.amount), 0)
            FROM refund_line rl JOIN refund r ON r.id = rl.refund_id
           WHERE r.shop_id = ? AND r.deleted_at IS NULL AND r.status = 'COMPLETED'
             AND r.refunded_at >= ? AND r.refunded_at < ?)                  AS rembourse,
         (SELECT COALESCE(SUM(rl.quantity * sl.unit_cost), 0)
            FROM refund_line rl
            JOIN refund r ON r.id = rl.refund_id
            JOIN sale_line sl ON sl.id = rl.sale_line_id
           WHERE r.shop_id = ? AND r.deleted_at IS NULL AND r.status = 'COMPLETED'
             AND rl.restock = 1
             AND r.refunded_at >= ? AND r.refunded_at < ?)                  AS coutRepris`,
      [boutique, du, au, boutique, du, au],
    );

    const brut = ventes[0]?.ventes ?? 0;
    const remises = ventes[0]?.remises ?? 0;
    const rembourse = retours[0]?.rembourse ?? 0;
    const chiffreAffairesNet = brut - remises - rembourse;
    const coutMarchandises = (ventes[0]?.cout ?? 0) - (retours[0]?.coutRepris ?? 0);
    const margeBrute = chiffreAffairesNet - coutMarchandises;

    const parCategorie = await new ChargeRepository(this.context.db).parCategorie(
      debut,
      apres,
      boutique,
    );
    const charges: LigneCharge[] = parCategorie.map((ligne) => ({
      categorie: ligne.category,
      libelle: CHARGE_LABELS[ligne.category],
      montant: ligne.total,
      nombre: ligne.nombre,
    }));
    const totalCharges = charges.reduce((somme, ligne) => somme + ligne.montant, 0);

    return {
      du,
      au,
      ventes: brut,
      remises,
      retours: rembourse,
      chiffreAffairesNet,
      coutMarchandises,
      margeBrute,
      // En centièmes de point, comme les taux de TVA — et zéro plutôt qu'une
      // division par zéro sur une période sans vente.
      tauxMarge:
        chiffreAffairesNet === 0 ? 0 : Math.round((margeBrute / chiffreAffairesNet) * 10_000),
      charges,
      totalCharges,
      resultat: margeBrute - totalCharges,
      nombreVentes: ventes[0]?.nombre ?? 0,
    };
  }

  /* ─── Le document imprimable ──────────────────────────────────────────── */

  /** Le compte de résultat mis en forme, prêt à être rendu. */
  async document(du: string, au: string): Promise<DocumentResultat> {
    const compte = await this.etablir(du, au);
    const boutique = await new ShopRepository(this.context.db).byId(this.context.shopId);

    const pieces = (nombre: number) => `${nombre} pièce${nombre > 1 ? 's' : ''}`;

    return {
      emetteur: {
        nom: boutique?.name ?? this.context.shopCode,
        adresse: boutique?.address ?? null,
        telephone: boutique?.phone ?? null,
        nif: boutique?.nif ?? null,
        stat: boutique?.stat ?? null,
      },
      du: compte.du,
      au: compte.au,
      etabliLe: nowIso(),

      produits: [
        {
          libelle: 'Ventes',
          montant: compte.ventes,
          detail: `${compte.nombreVentes} vente${compte.nombreVentes > 1 ? 's' : ''}`,
        },
        { libelle: 'Remises accordées', montant: compte.remises },
        { libelle: 'Retours et remboursements', montant: compte.retours },
      ],
      chiffreAffairesNet: compte.chiffreAffairesNet,

      coutMarchandises: compte.coutMarchandises,
      margeBrute: compte.margeBrute,
      tauxMarge: compte.tauxMarge,

      charges: compte.charges.map((ligne) => ({
        libelle: ligne.libelle,
        montant: ligne.montant,
        detail: pieces(ligne.nombre),
      })),
      totalCharges: compte.totalCharges,
      resultat: compte.resultat,

      devise: this.context.settings.currency,
      avertissement: AVERTISSEMENT_RESULTAT,
    };
  }

  /**
   * Le PDF du compte de résultat.
   *
   * La bibliothèque PDF est chargée à la demande, comme pour la facture : on
   * consulte le résultat à l'écran bien plus souvent qu'on ne l'exporte.
   */
  async pdf(du: string, au: string): Promise<Uint8Array> {
    const { pdfResultat } = await import('@boutique/documents');
    return pdfResultat(await this.document(du, au));
  }
}

/**
 * Un jour du calendrier, « aaaa-mm-jj », et rien d'autre.
 *
 * Vérifié plutôt que deviné : une chaîne qui n'est pas une date produirait des
 * bornes silencieusement fausses, et le compte de résultat serait plausible.
 */
function verifierJour(jour: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(jour)) {
    throw new BusinessError(`Date illisible : « ${jour} ». Attendu : aaaa-mm-jj.`);
  }
}

/**
 * Ce que ce document n'est pas — imprimé SUR la pièce.
 *
 * Elle circulera sans le logiciel, chez un comptable ou à la banque, et celui
 * qui la lira doit savoir ce qu'elle ne contient pas. Un chiffre présenté sans
 * ses limites finit toujours par être lu comme s'il n'en avait pas.
 */
export const AVERTISSEMENT_RESULTAT =
  "Ce document donne le résultat de l'exploitation : ventes de la période, coût des marchandises " +
  'effectivement sorties et charges saisies. Il ne porte ni amortissements, ni emprunts, ni ' +
  'capital, et ne remplace pas les comptes annuels établis par un expert-comptable.';
