import { DEFAULT_CURRENCY, DEFAULT_NUMBERING, nowIso } from '@boutique/shared';
import type { CurrencyFormat, NumberingRule } from '@boutique/shared';
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
  lowStockThreshold: 'stock.low_threshold',
  allowNegativeStock: 'stock.allow_negative',
  strictImeiChecksum: 'stock.strict_imei',
  backupKeep: 'backup.keep',
  backupDaily: 'backup.daily',
  syncServerUrl: 'sync.server_url',
  syncShopToken: 'sync.shop_token',
} as const;

export interface ShopSettings {
  currency: CurrencyFormat;
  taxEnabled: boolean;
  /** TVA par défaut, en centièmes de point (20 % -> 2000). */
  defaultTaxRate: number;
  numbering: Record<string, NumberingRule>;
  receiptHeader: string;
  receiptFooter: string;
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
  backupKeep: number;
  backupDaily: boolean;
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
  lowStockThreshold: 3,
  allowNegativeStock: false,
  strictImeiChecksum: true,
  backupKeep: 14,
  backupDaily: true,
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
   * Un paramètre défini pour la boutique l'emporte sur celui du poste
   * (`shop_id` NULL) : c'est ce qui permet de partager un serveur de
   * synchronisation entre plusieurs boutiques d'un même poste tout en laissant
   * chacune fixer sa propre devise.
   */
  async load(shopId: string): Promise<ShopSettings> {
    const rows = await this.db.select<SettingRow>(
      `SELECT key, value FROM setting
       WHERE shop_id IS NULL OR shop_id = ?
       ORDER BY (shop_id IS NULL) DESC`,
      [shopId],
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
      lowStockThreshold: read(SETTING_KEYS.lowStockThreshold, DEFAULT_SETTINGS.lowStockThreshold),
      allowNegativeStock: read(
        SETTING_KEYS.allowNegativeStock,
        DEFAULT_SETTINGS.allowNegativeStock,
      ),
      strictImeiChecksum: read(
        SETTING_KEYS.strictImeiChecksum,
        DEFAULT_SETTINGS.strictImeiChecksum,
      ),
      backupKeep: read(SETTING_KEYS.backupKeep, DEFAULT_SETTINGS.backupKeep),
      backupDaily: read(SETTING_KEYS.backupDaily, DEFAULT_SETTINGS.backupDaily),
      syncServerUrl: read(SETTING_KEYS.syncServerUrl, DEFAULT_SETTINGS.syncServerUrl),
      syncShopToken: read(SETTING_KEYS.syncShopToken, DEFAULT_SETTINGS.syncShopToken),
    };
  }

  async set(key: string, value: unknown, shopId: string | null): Promise<void> {
    await this.db.execute(
      `INSERT INTO setting (key, shop_id, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (key, shop_id)
       DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, shopId, toJson(value), nowIso()],
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
