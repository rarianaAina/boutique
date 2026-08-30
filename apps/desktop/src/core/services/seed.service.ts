import { PERMISSIONS, ROLE_PRESETS, completeImei, newId, nowIso } from '@boutique/shared';
import type { Tracking } from '@boutique/shared';
import { ShopRepository } from '../db/repositories/shop.repository';
import { RoleRepository } from '../db/repositories/role.repository';
import { UserRepository } from '../db/repositories/user.repository';
import { CategoryRepository } from '../db/repositories/category.repository';
import { SupplierRepository } from '../db/repositories/supplier.repository';
import { CustomerRepository } from '../db/repositories/customer.repository';
import { ProductRepository } from '../db/repositories/product.repository';
import { PurchaseRepository } from '../db/repositories/purchase.repository';
import { META_KEYS, MetaRepository } from '../db/repositories/meta.repository';
import { hashPassword } from '../auth/password';
import { StockService } from './stock.service';
import { SaleService } from './sale.service';
import { PurchaseService } from './purchase.service';
import { TransferService } from './transfer.service';
import { RefundService } from './refund.service';
import { ExchangeService } from './exchange.service';
import { ensurePaymentMethods } from './setup.service';
import { BusinessError, assertCan, type AppContext } from './context';
import { SaleRepository } from '../db/repositories/sale.repository';

/**
 * Jeu de démonstration (§29).
 *
 * Il sert à ESSAYER le logiciel avec des données qui ressemblent à la réalité :
 * deux boutiques, sept rôles, des téléphones avec de vrais IMEI (clé de Luhn
 * correcte), des accessoires suivis par quantité, des achats réceptionnés avec
 * frais de douane, des ventes, un transfert, un remboursement et un échange.
 *
 * IL N'EST PAS UN DÉCOR. Tout passe par les MÊMES services que l'utilisation
 * normale : les mouvements de stock, les événements de synchronisation et le
 * journal d'audit sont écrits comme en production. Une démonstration qui
 * insérerait directement des lignes en base montrerait des écrans qui
 * fonctionnent au-dessus de données incohérentes — exactement ce que le §35
 * interdit.
 */

const DEMO_PASSWORD = 'boutique2026';

export interface SeedReport {
  shops: number;
  users: number;
  products: number;
  units: number;
  sales: number;
  password: string;
}

export class SeedService {
  constructor(private readonly context: AppContext) {}

  async alreadyApplied(): Promise<boolean> {
    return (await new MetaRepository(this.context.db).get(META_KEYS.seedApplied)) === '1';
  }

  /**
   * Remplit une base neuve.
   *
   * Refuse de s'exécuter sur une base qui contient déjà des ventes : mélanger
   * des données de démonstration à des données réelles rendrait les rapports
   * faux sans qu'on puisse les démêler ensuite.
   */
  async run(): Promise<SeedReport> {
    assertCan(this.context, PERMISSIONS.settingsManage);

    const sales = await this.context.db.select<{ total: number }>(
      'SELECT COUNT(*) AS total FROM sale',
    );
    if ((sales[0]?.total ?? 0) > 0) {
      throw new BusinessError(
        'Cette base contient déjà des ventes : le jeu de démonstration ne peut plus être appliqué.',
      );
    }

    const db = this.context.db;
    const report: SeedReport = {
      shops: 0,
      users: 0,
      products: 0,
      units: 0,
      sales: 0,
      password: DEMO_PASSWORD,
    };

    /* ─── Boutiques ─────────────────────────────────────────────────────── */
    const shops = new ShopRepository(db);
    let nord = await shops.byCode('NORD');
    if (!nord) {
      await shops.create({
        code: 'NORD',
        name: 'Boutique Nord — Analakely',
        address: 'Lot II M 32 bis, Analakely, Antananarivo',
        phone: '+261 34 12 345 67',
      });
      nord = await shops.byCode('NORD');
    }
    report.shops = (await shops.list()).length;

    /* ─── Rôles et utilisateurs ─────────────────────────────────────────── */
    await new RoleRepository(db).ensurePresets();
    const roles = new RoleRepository(db);
    const users = new UserRepository(db);
    const hash = await hashPassword(DEMO_PASSWORD);

    const staff = [
      { login: 'gerant', name: 'Hery Rakotoson', role: 'MANAGER', shop: this.context.shopId },
      { login: 'vendeur', name: 'Naina Andria', role: 'SELLER', shop: this.context.shopId },
      { login: 'caissier', name: 'Miora Ravelo', role: 'CASHIER', shop: this.context.shopId },
      { login: 'stock', name: 'Tojo Rabe', role: 'STOCK_MANAGER', shop: this.context.shopId },
      { login: 'compta', name: 'Fara Randria', role: 'ACCOUNTANT', shop: this.context.shopId },
      { login: 'achats', name: 'Lova Rasoa', role: 'BUYER', shop: this.context.shopId },
      { login: 'nord', name: 'Sitraka Be', role: 'MANAGER', shop: nord?.id ?? this.context.shopId },
    ];
    for (const member of staff) {
      if (await users.byLogin(member.login)) continue;
      const role = await roles.byCode(member.role);
      if (!role) continue;
      await users.create(
        { shopId: member.shop, fullName: member.name, login: member.login, roleId: role.id },
        hash,
      );
    }
    report.users = (await users.list()).length;

    /* ─── Catégories et fournisseurs ────────────────────────────────────── */
    const categories = new CategoryRepository(db);
    const categoryIds = new Map<string, string>();
    for (const [code, name] of [
      ['TEL', 'Smartphones'],
      ['ACC', 'Accessoires'],
      ['AUD', 'Audio'],
      ['INF', 'Informatique'],
    ] as const) {
      const existing = await categories.byCode(code);
      categoryIds.set(code, existing?.id ?? (await categories.create({ code, name })));
    }

    const suppliers = new SupplierRepository(db);
    const supplierIds = new Map<string, string>();
    for (const supplier of [
      {
        code: 'SHZ',
        name: 'Shenzhen Digital Trading',
        country: 'Chine',
        terms: '30 % à la commande, solde avant expédition',
      },
      {
        code: 'DXB',
        name: 'Dubai Mobile Wholesale',
        country: 'Émirats arabes unis',
        terms: 'Paiement comptant',
      },
      {
        code: 'LOC',
        name: 'Distributeur local Tana',
        country: 'Madagascar',
        terms: '30 jours fin de mois',
      },
    ]) {
      const existing = await suppliers.byCode(supplier.code);
      supplierIds.set(supplier.code, existing?.id ?? (await suppliers.create(supplier)));
    }

    /* ─── Catalogue ─────────────────────────────────────────────────────── */
    const products = new ProductRepository(db);
    const productIds = new Map<string, string>();
    for (const product of CATALOGUE) {
      const existing = await products.bySku(product.sku);
      if (existing) {
        productIds.set(product.sku, existing.id);
        continue;
      }
      const { category, supplier, ...fields } = product;
      productIds.set(
        product.sku,
        await products.create({
          ...fields,
          categoryId: categoryIds.get(category) ?? null,
          defaultSupplierId: supplierIds.get(supplier) ?? null,
        }),
      );
    }
    report.products = productIds.size;

    /* ─── Clients ───────────────────────────────────────────────────────── */
    const customers = new CustomerRepository(db);
    const customerIds: string[] = [];
    for (const customer of [
      { firstName: 'Hanta', lastName: 'Rakotomalala', phone: '0341122334' },
      { firstName: 'Jean', lastName: 'Ratsimba', phone: '0328899776' },
      { firstName: 'Voahangy', lastName: 'Andrianina', phone: '0339988771' },
      { firstName: 'Serge', lastName: 'Rabarison', phone: '0345566778' },
    ]) {
      customerIds.push(await customers.create({ ...customer, shopId: this.context.shopId }));
    }

    /* ─── Achat réceptionné, avec frais de douane ───────────────────────── */
    const purchaseService = new PurchaseService(this.context);
    const purchaseId = await purchaseService.create({
      supplierId: supplierIds.get('SHZ') ?? '',
      supplierReference: 'PI-2026-0431',
      lines: [
        {
          productId: productIds.get('IPH15-128-NOIR') ?? '',
          label: 'iPhone 15 128 Go Noir',
          quantity: 4,
          unitPrice: 2_400_000,
        },
        {
          productId: productIds.get('SAM-S24-256') ?? '',
          label: 'Samsung Galaxy S24 256 Go',
          quantity: 3,
          unitPrice: 1_950_000,
        },
        {
          productId: productIds.get('CAB-USBC-1M') ?? '',
          label: 'Câble USB-C 1 m',
          quantity: 200,
          unitPrice: 4_000,
        },
      ],
    });
    await purchaseService.addLandedCost(purchaseId, { kind: 'TRANSPORT', amount: 480_000 });
    await purchaseService.addLandedCost(purchaseId, { kind: 'CUSTOMS', amount: 1_250_000 });
    await purchaseService.markOrdered(purchaseId);

    const purchaseLines = await new PurchaseRepository(db).lines(purchaseId);
    let imeiCounter = 1;
    const nextImei = () => completeImei(`35692005${String(imeiCounter++).padStart(6, '0')}`);

    await purchaseService.receive(purchaseId, [
      {
        purchaseLineId: purchaseLines[0]?.id ?? '',
        quantity: 4,
        units: Array.from({ length: 4 }, () => ({
          imei1: nextImei(),
          color: 'Noir',
          capacity: '128 Go',
        })),
      },
      {
        purchaseLineId: purchaseLines[1]?.id ?? '',
        quantity: 3,
        units: Array.from({ length: 3 }, () => ({
          imei1: nextImei(),
          color: 'Gris',
          capacity: '256 Go',
        })),
      },
      { purchaseLineId: purchaseLines[2]?.id ?? '', quantity: 200 },
    ]);

    /* ─── Stock complémentaire ──────────────────────────────────────────── */
    const stock = new StockService(this.context);
    await stock.receiveUnits({
      productId: productIds.get('XIA-RN13-256') ?? '',
      supplierId: supplierIds.get('DXB') ?? null,
      units: Array.from({ length: 5 }, () => ({
        imei1: nextImei(),
        capacity: '256 Go',
        costPrice: 780_000,
      })),
    });
    await stock.receiveUnits({
      productId: productIds.get('JBL-BOOMBOX-3') ?? '',
      supplierId: supplierIds.get('DXB') ?? null,
      units: ['BB3-4417-A', 'BB3-4417-B'].map((serial) => ({ serial, costPrice: 1_100_000 })),
    });
    await stock.receiveUnits({
      productId: productIds.get('DJI-OSMO-6') ?? '',
      units: [{ serial: 'OSM6-90113', costPrice: 620_000 }],
    });
    for (const [sku, quantity] of [
      ['HOU-SIL-UNI', 120],
      ['VIT-TREMP-UNI', 300],
      ['CHG-20W-USBC', 80],
      ['ECO-BT-TWS', 45],
      ['MIC-CRAV-3M', 25],
      ['CLE-USB-64', 60],
      ['SOU-SF-BT', 30],
    ] as const) {
      await stock.receiveQuantity({ productId: productIds.get(sku) ?? '', quantity });
    }
    report.units =
      (await db.select<{ total: number }>('SELECT COUNT(*) AS total FROM product_unit'))[0]
        ?.total ?? 0;

    /* ─── Ventes ────────────────────────────────────────────────────────── */
    const saleService = new SaleService(this.context);
    const available = await db.select<{ id: string; product_id: string }>(
      `SELECT id, product_id FROM product_unit
       WHERE shop_id = ? AND status = 'IN_STOCK' ORDER BY created_at LIMIT 6`,
      [this.context.shopId],
    );

    const firstSale = available[0]
      ? await saleService.checkout({
          lines: [
            { productId: available[0].product_id, unitId: available[0].id, quantity: 1 },
            { productId: productIds.get('VIT-TREMP-UNI') ?? '', quantity: 1 },
          ],
          payments: [{ method: 'CASH', amount: 3_000_000 }],
          customerId: customerIds[0] ?? null,
        })
      : null;

    const secondSale = available[1]
      ? await saleService.checkout({
          lines: [{ productId: available[1].product_id, unitId: available[1].id, quantity: 1 }],
          payments: [{ method: 'MOBILE_MONEY', amount: 2_950_000, reference: 'MVOLA-77120' }],
          customerId: customerIds[1] ?? null,
        })
      : null;

    await saleService.checkout({
      lines: [
        { productId: productIds.get('CHG-20W-USBC') ?? '', quantity: 2 },
        { productId: productIds.get('CAB-USBC-1M') ?? '', quantity: 3 },
      ],
      payments: [{ method: 'CASH', amount: 200_000 }],
      customerId: customerIds[2] ?? null,
    });

    /* ─── Remboursement et échange ──────────────────────────────────────── */
    if (firstSale) {
      const lines = await new SaleRepository(db).lines(firstSale.saleId);
      const accessory = lines.find((line) => !line.unitId);
      if (accessory) {
        await new RefundService(this.context).refund({
          saleId: firstSale.saleId,
          method: 'CASH',
          reason: 'Vitre non adaptée au modèle',
          lines: [{ saleLineId: accessory.id, quantity: 1 }],
        });
      }
    }

    if (secondSale && available[1] && available[2]) {
      await new ExchangeService(this.context).exchange({
        originalSaleId: secondSale.saleId,
        returnedUnitId: available[1].id,
        newUnitId: available[2].id,
        reason: "Écran défectueux à l'ouverture",
      });
    }

    /* ─── Transfert vers la boutique Nord ───────────────────────────────── */
    if (nord && available[3]) {
      const transfers = new TransferService(this.context);
      const { transferId } = await transfers.request({
        toShopId: nord.id,
        lines: [
          { productId: available[3].product_id, unitId: available[3].id, label: '', quantity: 1 },
          { productId: productIds.get('HOU-SIL-UNI') ?? '', label: '', quantity: 20 },
        ],
        note: 'Réassort demandé par la boutique Nord',
      });
      await transfers.approve(transferId);
      await transfers.ship(transferId);
    }

    report.sales =
      (await db.select<{ total: number }>('SELECT COUNT(*) AS total FROM sale'))[0]?.total ?? 0;
    await new MetaRepository(db).set(META_KEYS.seedApplied, '1');
    await ensurePaymentMethods(db);

    return report;
  }
}

/** Catalogue de démonstration : ce que vend réellement ce type de boutique. */
interface CatalogueEntry {
  sku: string;
  name: string;
  brand: string;
  model?: string;
  tracking: Tracking;
  purchasePrice: number;
  salePrice: number;
  minPrice?: number;
  minStock?: number;
  /** Code de catégorie, résolu à l'insertion. */
  category: string;
  /** Code de fournisseur, résolu à l'insertion. */
  supplier: string;
  attributes: Record<string, string>;
}

const CATALOGUE: CatalogueEntry[] = [
  {
    sku: 'IPH15-128-NOIR',
    name: 'iPhone 15 128 Go Noir',
    brand: 'Apple',
    model: 'iPhone 15',
    tracking: 'IMEI',
    purchasePrice: 2_400_000,
    salePrice: 2_950_000,
    minPrice: 2_800_000,
    category: 'TEL',
    supplier: 'SHZ',
    attributes: { capacite: '128 Go', couleur: 'Noir' },
  },
  {
    sku: 'IPH15-256-BLEU',
    name: 'iPhone 15 256 Go Bleu',
    brand: 'Apple',
    model: 'iPhone 15',
    tracking: 'IMEI',
    purchasePrice: 2_800_000,
    salePrice: 3_450_000,
    minPrice: 3_300_000,
    category: 'TEL',
    supplier: 'SHZ',
    attributes: { capacite: '256 Go', couleur: 'Bleu' },
  },
  {
    sku: 'SAM-S24-256',
    name: 'Samsung Galaxy S24 256 Go',
    brand: 'Samsung',
    model: 'Galaxy S24',
    tracking: 'IMEI',
    purchasePrice: 1_950_000,
    salePrice: 2_490_000,
    category: 'TEL',
    supplier: 'SHZ',
    attributes: { capacite: '256 Go' },
  },
  {
    sku: 'SAM-A54-128',
    name: 'Samsung Galaxy A54 128 Go',
    brand: 'Samsung',
    model: 'Galaxy A54',
    tracking: 'IMEI',
    purchasePrice: 890_000,
    salePrice: 1_150_000,
    category: 'TEL',
    supplier: 'SHZ',
    attributes: { capacite: '128 Go' },
  },
  {
    sku: 'XIA-RN13-256',
    name: 'Xiaomi Redmi Note 13 256 Go',
    brand: 'Xiaomi',
    model: 'Redmi Note 13',
    tracking: 'IMEI',
    purchasePrice: 780_000,
    salePrice: 990_000,
    category: 'TEL',
    supplier: 'DXB',
    attributes: { capacite: '256 Go' },
  },
  {
    sku: 'OPP-A78-128',
    name: 'Oppo A78 128 Go',
    brand: 'Oppo',
    model: 'A78',
    tracking: 'IMEI',
    purchasePrice: 620_000,
    salePrice: 820_000,
    category: 'TEL',
    supplier: 'DXB',
    attributes: { capacite: '128 Go' },
  },
  {
    sku: 'JBL-BOOMBOX-3',
    name: 'JBL Boombox 3',
    brand: 'JBL',
    tracking: 'SERIAL',
    purchasePrice: 1_100_000,
    salePrice: 1_450_000,
    category: 'AUD',
    supplier: 'DXB',
    attributes: {},
  },
  {
    sku: 'DJI-OSMO-6',
    name: 'DJI Osmo Mobile 6',
    brand: 'DJI',
    tracking: 'SERIAL',
    purchasePrice: 620_000,
    salePrice: 830_000,
    category: 'AUD',
    supplier: 'DXB',
    attributes: {},
  },
  {
    sku: 'ECO-BT-TWS',
    name: 'Écouteurs Bluetooth TWS',
    brand: 'Generic',
    tracking: 'QUANTITY',
    purchasePrice: 35_000,
    salePrice: 79_000,
    minStock: 15,
    category: 'AUD',
    supplier: 'LOC',
    attributes: {},
  },
  {
    sku: 'MIC-CRAV-3M',
    name: 'Micro-cravate sans fil 3 m',
    brand: 'Generic',
    tracking: 'QUANTITY',
    purchasePrice: 42_000,
    salePrice: 95_000,
    minStock: 10,
    category: 'AUD',
    supplier: 'LOC',
    attributes: {},
  },
  {
    sku: 'HOU-SIL-UNI',
    name: 'Housse silicone universelle',
    brand: 'Generic',
    tracking: 'QUANTITY',
    purchasePrice: 3_500,
    salePrice: 12_000,
    minStock: 40,
    category: 'ACC',
    supplier: 'LOC',
    attributes: {},
  },
  {
    sku: 'VIT-TREMP-UNI',
    name: 'Vitre de protection verre trempé',
    brand: 'Generic',
    tracking: 'QUANTITY',
    purchasePrice: 2_000,
    salePrice: 8_000,
    minStock: 100,
    category: 'ACC',
    supplier: 'LOC',
    attributes: {},
  },
  {
    sku: 'CHG-20W-USBC',
    name: 'Chargeur rapide 20 W USB-C',
    brand: 'Generic',
    tracking: 'QUANTITY',
    purchasePrice: 18_000,
    salePrice: 45_000,
    minStock: 25,
    category: 'ACC',
    supplier: 'LOC',
    attributes: {},
  },
  {
    sku: 'CAB-USBC-1M',
    name: 'Câble USB-C 1 m',
    brand: 'Generic',
    tracking: 'QUANTITY',
    purchasePrice: 4_000,
    salePrice: 12_000,
    minStock: 50,
    category: 'ACC',
    supplier: 'SHZ',
    attributes: {},
  },
  {
    sku: 'CLE-USB-64',
    name: 'Clé USB 64 Go',
    brand: 'Generic',
    tracking: 'QUANTITY',
    purchasePrice: 22_000,
    salePrice: 48_000,
    minStock: 20,
    category: 'INF',
    supplier: 'LOC',
    attributes: {},
  },
  {
    sku: 'SOU-SF-BT',
    name: 'Souris sans fil Bluetooth',
    brand: 'Generic',
    tracking: 'QUANTITY',
    purchasePrice: 15_000,
    salePrice: 38_000,
    minStock: 15,
    category: 'INF',
    supplier: 'LOC',
    attributes: {},
  },
];

export { newId, nowIso, ROLE_PRESETS };
