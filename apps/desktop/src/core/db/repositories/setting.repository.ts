import { DEFAULT_CURRENCY, DEFAULT_NUMBERING, nowIso } from '@boutique/shared';
import type { CurrencyFormat, NumberingRule } from '@boutique/shared';
import type { Mention } from '@boutique/documents';
import type { CostMethod } from '../../services/cost.service';
import { parseJson, toJson } from '../rows';
import type { SqlExecutor } from '../client';

/**
 * Paramètres commerciaux (§33).
 *
 * Rien de ce qui varie d'une boutique à l'autre — devise, TVA, numérotation,
 * mentions du ticket — n'est écrit en dur dans le code. Ces valeurs sont lues
 * ici, avec un repli explicite : une base neuve doit démarrer sans qu'un
 * administrateur ait à remplir un formulaire avant la première vente.
 */
export const SETTING_KEYS = {
  currency: 'commerce.currency',
  taxEnabled: 'commerce.tax_enabled',
  defaultTaxRate: 'commerce.default_tax_rate',
  numbering: 'commerce.numbering',
  receiptHeader: 'print.receipt_header',
  receiptFooter: 'print.receipt_footer',
  invoiceMentions: 'facture.mentions',
  invoiceFooter: 'facture.pied',
  invoiceLogo: 'facture.logo',
  invoiceShowLogo: 'facture.afficher_logo',
  invoiceShowIdentifiers: 'facture.afficher_identifiants',
  invoiceConditions: 'facture.conditions',
  invoiceShowSignatures: 'facture.afficher_signatures',
  invoiceSignatures: 'facture.signatures',
  lowStockThreshold: 'stock.low_threshold',
  allowNegativeStock: 'stock.allow_negative',
  strictImeiChecksum: 'stock.strict_imei',
  costMethod: 'stock.cost_method',
  backupKeep: 'backup.keep',
  backupDaily: 'backup.daily',
  sessionDays: 'session.duree_jours',
  syncServerUrl: 'sync.server_url',
  syncShopToken: 'sync.shop_token',
} as const;

/**
 * Réglages qui appartiennent au POSTE et non à une boutique.
 *
 * La licence active un poste : la rattacher à une boutique la ferait
 * disparaître le jour où l'on change de boutique locale, et réapparaître
 * ailleurs. Ils sont donc écrits avec `shop_id` vide, et lus tels quels.
 *
 * Ils ne figurent pas dans `ShopSettings` : ce ne sont pas des préférences de
 * commerce, et les mélanger exposerait la clé à l'écran des paramètres généraux.
 */
export const POSTE_KEYS = {
  /** Identifiant d'installation, tiré au premier démarrage puis immuable. */
  installation: 'licence.installation',
  /** Clé d'activation saisie par le commerçant. */
  licenceKey: 'licence.key',
  /**
   * Code d'installation ADOPTÉ, quand ce poste est rattaché à un autre.
   *
   * Une licence est vendue à une entreprise et non à une machine : le produit
   * déclare un quota « postes rattachés ». Ce poste-ci retient alors le code
   * de celui qui porte la licence, et se présente sous ce code. Vide quand il
   * vit sur sa propre licence, ce qui est le cas ordinaire.
   */
  licenceAdoptee: 'licence.rattachement',
  /** Cliquet d'horloge : la date la plus avancée jamais constatée. */
  dateRatchet: 'licence.ratchet',
  /**
   * EMPREINTE de la clé de secours de l'administrateur. Jamais la clé.
   *
   * Hachée comme un mot de passe : qui lirait la base ne pourrait pas s'en
   * servir pour reprendre le compte administrateur.
   */
  recoveryHash: 'securite.cle_secours',
} as const;

/**
 * `shop_id` d'un réglage qui n'appartient à aucune boutique.
 *
 * Une chaîne vide, pas un NULL, et la migration 0004 dit pourquoi : SQLite
 * tient deux NULL pour distincts, si bien que la clé primaire `(key, shop_id)`
 * ne s'opposait à rien et que chaque écriture ajoutait une ligne au lieu d'en
 * remplacer une. Postgres, de son côté, refuse un NULL dans une clé primaire.
 */
export const POSTE = '';

export interface ShopSettings {
  currency: CurrencyFormat;
  taxEnabled: boolean;
  /** TVA par défaut, en centièmes de point (20 % -> 2000). */
  defaultTaxRate: number;
  numbering: Record<string, NumberingRule>;
  receiptHeader: string;
  receiptFooter: string;
  /**
   * Mentions libres imprimées en tête de facture, sous les coordonnées.
   *
   * Registre du commerce, capital, coordonnées bancaires, numéro Mvola : ce
   * que chaque société doit ou veut faire figurer varie, et une colonne par
   * mention imposerait une migration à chaque nouveau besoin.
   */
  invoiceMentions: Mention[];
  /**
   * Mentions légales de bas de facture.
   *
   * Distinctes du pied de ticket : un ticket de caisse dit « merci de votre
   * visite », une facture dit le régime de TVA et les pénalités de retard.
   */
  invoiceFooter: string;
  /**
   * Logo, en URI de données. Chaîne vide quand la boutique n'en a pas.
   *
   * Stocké dans la base et non sur le disque : il part alors avec l'archive de
   * portabilité, et la boutique retrouve sa facture à l'identique sur une autre
   * machine ou en ligne. Un chemin de fichier ne survivrait ni à l'un ni à
   * l'autre.
   */
  invoiceLogo: string;
  invoiceShowLogo: boolean;
  /** Imprimer les NIF et STAT des deux parties. */
  invoiceShowIdentifiers: boolean;
  /** Conditions de vente, imprimées au-dessus des signatures. */
  invoiceConditions: string;
  invoiceShowSignatures: boolean;
  invoiceSignatures: { gauche: string; droite: string };
  /** Seuil d'alerte quand un produit n'en définit pas lui-même. */
  lowStockThreshold: number;
  /**
   * Autoriser une sortie qui rendrait le stock négatif.
   *
   * Faux par défaut : sur un stock d'appareils identifiés, un stock négatif
   * signale presque toujours une erreur de saisie qu'il vaut mieux corriger
   * tout de suite que découvrir à l'inventaire.
   */
  allowNegativeStock: boolean;
  /**
   * Refuser un IMEI dont la clé de contrôle est fausse.
   *
   * Activé par défaut : la clé attrape les fautes de frappe, et un IMEI faux
   * suit l'appareil jusqu'à sa revente. À désactiver seulement si le parc
   * comporte des appareils dont l'IMEI ne la respecte pas — la longueur et
   * l'unicité, elles, restent contrôlées dans tous les cas.
   */
  strictImeiChecksum: boolean;
  /**
   * Valorisation des sorties de stock des produits suivis par QUANTITÉ.
   *
   * Les produits suivis à l'unité ne sont pas concernés : chaque appareil
   * porte son propre coût, ce qui est plus exact que toute convention.
   *
   * `CATALOGUE` par défaut — basculer une base existante en FIFO changerait la
   * lecture des marges à venir, et cela ne doit pas arriver sans décision.
   */
  costMethod: CostMethod;
  backupKeep: number;
  backupDaily: boolean;
  /**
   * Jours pendant lesquels la session reste ouverte après fermeture.
   *
   * Zéro redemande le mot de passe à chaque ouverture. Au-delà, la première
   * personne qui ouvre l'application agit sous l'identité de la dernière : sur
   * un poste partagé, c'est le journal d'audit qui devient faux. Sept jours
   * par défaut — la friction quotidienne est réelle, et la ressaisie devant un
   * client qui attend finit par se régler d'une mauvaise façon.
   */
  sessionDays: number;
  syncServerUrl: string;
  syncShopToken: string;
}

export const DEFAULT_SETTINGS: ShopSettings = {
  currency: DEFAULT_CURRENCY,
  taxEnabled: false,
  defaultTaxRate: 0,
  numbering: DEFAULT_NUMBERING,
  receiptHeader: '',
  receiptFooter: 'Merci de votre visite.',
  invoiceMentions: [],
  invoiceFooter: '',
  invoiceLogo: '',
  invoiceShowLogo: false,
  // Vrai par défaut : une boutique qui a renseigné son NIF veut qu'il
  // s'imprime. Si elle ne l'a pas renseigné, rien ne s'imprime de toute façon.
  invoiceShowIdentifiers: true,
  invoiceConditions: '',
  invoiceShowSignatures: false,
  invoiceSignatures: { gauche: 'Le vendeur', droite: 'Le client' },
  lowStockThreshold: 3,
  allowNegativeStock: false,
  strictImeiChecksum: true,
  costMethod: 'CATALOGUE',
  backupKeep: 14,
  backupDaily: true,
  sessionDays: 7,
  syncServerUrl: '',
  syncShopToken: '',
};

interface SettingRow {
  key: string;
  value: string;
}

export class SettingRepository {
  constructor(private readonly db: SqlExecutor) {}

  /**
   * Lit tous les paramètres d'une boutique, complétés par les valeurs de repli.
   *
   * Un paramètre défini pour la boutique l'emporte sur celui du poste : c'est
   * ce qui permet de partager un serveur de synchronisation entre plusieurs
   * boutiques d'un même poste tout en laissant chacune fixer sa propre devise.
   */
  async load(shopId: string): Promise<ShopSettings> {
    const rows = await this.db.select<SettingRow>(
      // Le poste d'abord, la boutique ensuite : la seconde écrase le premier
      // dans la table de correspondance construite plus bas.
      `SELECT key, value FROM setting
       WHERE shop_id = ? OR shop_id = ?
       ORDER BY CASE shop_id WHEN ? THEN 0 ELSE 1 END`,
      [POSTE, shopId, POSTE],
    );

    const map = new Map<string, string>();
    for (const row of rows) map.set(row.key, row.value);

    const read = <T>(key: string, fallback: T): T =>
      map.has(key) ? parseJson<T>(map.get(key), fallback) : fallback;

    return {
      currency: read(SETTING_KEYS.currency, DEFAULT_SETTINGS.currency),
      taxEnabled: read(SETTING_KEYS.taxEnabled, DEFAULT_SETTINGS.taxEnabled),
      defaultTaxRate: read(SETTING_KEYS.defaultTaxRate, DEFAULT_SETTINGS.defaultTaxRate),
      numbering: { ...DEFAULT_NUMBERING, ...read(SETTING_KEYS.numbering, {}) },
      receiptHeader: read(SETTING_KEYS.receiptHeader, DEFAULT_SETTINGS.receiptHeader),
      receiptFooter: read(SETTING_KEYS.receiptFooter, DEFAULT_SETTINGS.receiptFooter),
      invoiceMentions: read(SETTING_KEYS.invoiceMentions, DEFAULT_SETTINGS.invoiceMentions),
      invoiceFooter: read(SETTING_KEYS.invoiceFooter, DEFAULT_SETTINGS.invoiceFooter),
      invoiceLogo: read(SETTING_KEYS.invoiceLogo, DEFAULT_SETTINGS.invoiceLogo),
      invoiceShowLogo: read(SETTING_KEYS.invoiceShowLogo, DEFAULT_SETTINGS.invoiceShowLogo),
      invoiceShowIdentifiers: read(
        SETTING_KEYS.invoiceShowIdentifiers,
        DEFAULT_SETTINGS.invoiceShowIdentifiers,
      ),
      invoiceConditions: read(SETTING_KEYS.invoiceConditions, DEFAULT_SETTINGS.invoiceConditions),
      invoiceShowSignatures: read(
        SETTING_KEYS.invoiceShowSignatures,
        DEFAULT_SETTINGS.invoiceShowSignatures,
      ),
      invoiceSignatures: read(SETTING_KEYS.invoiceSignatures, DEFAULT_SETTINGS.invoiceSignatures),
      lowStockThreshold: read(SETTING_KEYS.lowStockThreshold, DEFAULT_SETTINGS.lowStockThreshold),
      allowNegativeStock: read(
        SETTING_KEYS.allowNegativeStock,
        DEFAULT_SETTINGS.allowNegativeStock,
      ),
      strictImeiChecksum: read(
        SETTING_KEYS.strictImeiChecksum,
        DEFAULT_SETTINGS.strictImeiChecksum,
      ),
      costMethod: read(SETTING_KEYS.costMethod, DEFAULT_SETTINGS.costMethod),
      backupKeep: read(SETTING_KEYS.backupKeep, DEFAULT_SETTINGS.backupKeep),
      backupDaily: read(SETTING_KEYS.backupDaily, DEFAULT_SETTINGS.backupDaily),
      sessionDays: read(SETTING_KEYS.sessionDays, DEFAULT_SETTINGS.sessionDays),
      syncServerUrl: read(SETTING_KEYS.syncServerUrl, DEFAULT_SETTINGS.syncServerUrl),
      syncShopToken: read(SETTING_KEYS.syncShopToken, DEFAULT_SETTINGS.syncShopToken),
    };
  }

  /**
   * Lit un réglage du POSTE, sans repli ni interprétation.
   *
   * `load` ne convient pas : il fusionne les réglages de la boutique et ceux du
   * poste, et applique des valeurs par défaut. Une clé de licence absente doit
   * rester absente — pas devenir une chaîne vide indiscernable d'une clé effacée.
   */
  async raw(key: string): Promise<string | null> {
    const rows = await this.db.select<SettingRow>(
      `SELECT key, value FROM setting WHERE key = ? AND shop_id = ?`,
      [key, POSTE],
    );
    const brut = rows[0]?.value;
    if (brut === undefined) return null;
    return parseJson<string>(brut, '');
  }

  /**
   * Écrit un réglage.
   *
   * `shopId` à `null` désigne le POSTE, et se traduit par une chaîne vide : la
   * migration 0004 explique pourquoi la colonne ne porte plus de NULL. Tant
   * qu'elle en portait, `ON CONFLICT` ne se déclenchait jamais pour un réglage
   * du poste — SQLite tient deux NULL pour distincts — et chaque écriture
   * ajoutait une ligne au lieu d'en remplacer une.
   */
  async set(key: string, value: unknown, shopId: string | null): Promise<void> {
    await this.db.execute(
      `INSERT INTO setting (key, shop_id, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (key, shop_id)
       DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, shopId ?? POSTE, toJson(value), nowIso()],
    );
  }

  /** Enregistre plusieurs paramètres d'un coup, dans une seule transaction. */
  async saveAll(values: Partial<ShopSettings>, shopId: string): Promise<void> {
    const entries = Object.entries(values) as [keyof ShopSettings, unknown][];
    await this.db.transaction(async (tx) => {
      const repository = new SettingRepository(tx);
      for (const [field, value] of entries) {
        const key = SETTING_KEYS[field];
        if (!key) continue;
        await repository.set(key, value, shopId);
      }
    });
  }
}
