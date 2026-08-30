/**
 * Permissions.
 *
 * Un rôle n'est qu'un NOM porteur d'une liste de permissions ; c'est la
 * permission, jamais le rôle, qui est testée dans le code. Sans cette
 * indirection, ajouter un rôle « Responsable achats » obligerait à relire tous
 * les écrans à la recherche des `role === 'MANAGER'` — exactement ce que le
 * cahier des charges interdit (§4).
 *
 * Les rôles livrés à l'installation sont modifiables par un administrateur :
 * les listes ci-dessous ne sont qu'un point de départ, stocké en base.
 */

export const PERMISSIONS = {
  /* Catalogue et stock */
  productView: 'product.view',
  productManage: 'product.manage',
  costView: 'cost.view',
  stockView: 'stock.view',
  stockAdjust: 'stock.adjust',
  inventoryManage: 'inventory.manage',

  /* Ventes */
  saleCreate: 'sale.create',
  saleEdit: 'sale.edit',
  saleCancel: 'sale.cancel',
  saleDiscount: 'sale.discount',
  saleViewAll: 'sale.view_all',
  refundCreate: 'refund.create',
  exchangeCreate: 'exchange.create',
  invoiceManage: 'invoice.manage',

  /* Achats */
  purchaseView: 'purchase.view',
  purchaseCreate: 'purchase.create',
  purchaseReceive: 'purchase.receive',
  supplierManage: 'supplier.manage',
  landedCostManage: 'landed_cost.manage',

  /* Transferts */
  transferCreate: 'transfer.create',
  transferApprove: 'transfer.approve',
  transferReceive: 'transfer.receive',

  /* Clients */
  customerView: 'customer.view',
  customerManage: 'customer.manage',

  /* Transverse */
  reportView: 'report.view',
  userManage: 'user.manage',
  importRun: 'import.run',
  settingsManage: 'settings.manage',
  syncRun: 'sync.run',
  auditView: 'audit.view',
  backupManage: 'backup.manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS);

/** Regroupement pour l'écran d'édition d'un rôle. */
export const PERMISSION_GROUPS: { title: string; permissions: Permission[] }[] = [
  {
    title: 'Catalogue et stock',
    permissions: [
      PERMISSIONS.productView,
      PERMISSIONS.productManage,
      PERMISSIONS.costView,
      PERMISSIONS.stockView,
      PERMISSIONS.stockAdjust,
      PERMISSIONS.inventoryManage,
    ],
  },
  {
    title: 'Ventes',
    permissions: [
      PERMISSIONS.saleCreate,
      PERMISSIONS.saleEdit,
      PERMISSIONS.saleCancel,
      PERMISSIONS.saleDiscount,
      PERMISSIONS.saleViewAll,
      PERMISSIONS.refundCreate,
      PERMISSIONS.exchangeCreate,
      PERMISSIONS.invoiceManage,
    ],
  },
  {
    title: 'Achats',
    permissions: [
      PERMISSIONS.purchaseView,
      PERMISSIONS.purchaseCreate,
      PERMISSIONS.purchaseReceive,
      PERMISSIONS.supplierManage,
      PERMISSIONS.landedCostManage,
    ],
  },
  {
    title: 'Transferts',
    permissions: [
      PERMISSIONS.transferCreate,
      PERMISSIONS.transferApprove,
      PERMISSIONS.transferReceive,
    ],
  },
  { title: 'Clients', permissions: [PERMISSIONS.customerView, PERMISSIONS.customerManage] },
  {
    title: 'Administration',
    permissions: [
      PERMISSIONS.reportView,
      PERMISSIONS.userManage,
      PERMISSIONS.importRun,
      PERMISSIONS.settingsManage,
      PERMISSIONS.syncRun,
      PERMISSIONS.auditView,
      PERMISSIONS.backupManage,
    ],
  },
];

export const PERMISSION_LABELS: Record<Permission, string> = {
  'product.view': 'Consulter les produits',
  'product.manage': 'Créer et modifier les produits',
  'cost.view': "Voir les prix d'achat et les marges",
  'stock.view': 'Consulter le stock',
  'stock.adjust': 'Corriger le stock',
  'inventory.manage': 'Réaliser un inventaire',
  'sale.create': 'Encaisser une vente',
  'sale.edit': 'Modifier une vente',
  'sale.cancel': 'Annuler une vente',
  'sale.discount': 'Accorder une remise',
  'sale.view_all': 'Voir les ventes de tous les vendeurs',
  'refund.create': 'Effectuer un remboursement',
  'exchange.create': 'Effectuer un échange',
  'invoice.manage': 'Gérer les factures',
  'purchase.view': 'Consulter les achats',
  'purchase.create': 'Créer un achat',
  'purchase.receive': 'Valider une réception',
  'supplier.manage': 'Gérer les fournisseurs',
  'landed_cost.manage': 'Saisir les coûts logistiques',
  'transfer.create': 'Demander un transfert',
  'transfer.approve': 'Valider et expédier un transfert',
  'transfer.receive': 'Réceptionner un transfert',
  'customer.view': 'Consulter les clients',
  'customer.manage': 'Gérer les clients',
  'report.view': 'Consulter les rapports',
  'user.manage': 'Gérer les utilisateurs et les rôles',
  'import.run': 'Importer des fichiers',
  'settings.manage': 'Modifier les paramètres',
  'sync.run': 'Lancer une synchronisation',
  'audit.view': "Consulter le journal d'audit",
  'backup.manage': 'Gérer les sauvegardes',
};

/** Rôles créés au premier démarrage. Le code sert de clé stable. */
export interface RolePreset {
  code: string;
  name: string;
  description: string;
  permissions: Permission[];
}

const P = PERMISSIONS;

const SELLER: Permission[] = [
  P.productView,
  P.stockView,
  P.saleCreate,
  P.customerView,
  P.customerManage,
];

export const ROLE_PRESETS: readonly RolePreset[] = [
  {
    code: 'ADMIN',
    name: 'Administrateur',
    description: 'Accès complet, y compris utilisateurs, paramètres et synchronisation.',
    permissions: [...ALL_PERMISSIONS],
  },
  {
    code: 'MANAGER',
    name: 'Gérant',
    description: 'Pilote une boutique : ventes, stock, achats, transferts et rapports.',
    permissions: ALL_PERMISSIONS.filter(
      (permission) => permission !== P.userManage && permission !== P.settingsManage,
    ),
  },
  {
    code: 'STOCK_MANAGER',
    name: 'Responsable stock',
    description: 'Entrées, sorties, inventaires et transferts. Ne vend pas.',
    permissions: [
      P.productView,
      P.productManage,
      P.costView,
      P.stockView,
      P.stockAdjust,
      P.inventoryManage,
      P.purchaseView,
      P.purchaseReceive,
      P.transferCreate,
      P.transferReceive,
      P.reportView,
      P.importRun,
    ],
  },
  {
    code: 'SELLER',
    name: 'Vendeur',
    description: 'Encaisse. Ne voit ni les coûts ni les marges.',
    permissions: SELLER,
  },
  {
    code: 'CASHIER',
    name: 'Caissier',
    description: 'Encaisse, rembourse et échange, avec remise autorisée.',
    permissions: [
      ...SELLER,
      P.saleDiscount,
      P.refundCreate,
      P.exchangeCreate,
      P.invoiceManage,
      P.saleViewAll,
    ],
  },
  {
    code: 'ACCOUNTANT',
    name: 'Comptable',
    description: 'Lecture seule sur les documents commerciaux et les marges.',
    permissions: [
      P.productView,
      P.costView,
      P.stockView,
      P.saleViewAll,
      P.purchaseView,
      P.customerView,
      P.reportView,
      P.auditView,
      P.invoiceManage,
    ],
  },
  {
    code: 'BUYER',
    name: 'Responsable achats',
    description: 'Fournisseurs, commandes, réceptions et coûts logistiques.',
    permissions: [
      P.productView,
      P.productManage,
      P.costView,
      P.stockView,
      P.purchaseView,
      P.purchaseCreate,
      P.purchaseReceive,
      P.supplierManage,
      P.landedCostManage,
      P.reportView,
      P.importRun,
    ],
  },
];

/** Porteur de permissions, tel que le voit la couche métier. */
export interface Principal {
  userId: string;
  shopId: string;
  roleCode: string;
  permissions: readonly Permission[];
}

export function can(principal: Principal | null, permission: Permission): boolean {
  return principal?.permissions.includes(permission) ?? false;
}

export function canAll(principal: Principal | null, ...permissions: Permission[]): boolean {
  return permissions.every((permission) => can(principal, permission));
}

export function canAny(principal: Principal | null, ...permissions: Permission[]): boolean {
  return permissions.some((permission) => can(principal, permission));
}

/**
 * Erreur levée par la couche métier quand une permission manque.
 *
 * Elle existe pour que l'interface puisse afficher un message précis SANS que
 * les services aient à connaître React : masquer un bouton ne suffit pas, la
 * vérification doit aussi exister côté service (§28).
 */
export class PermissionDeniedError extends Error {
  constructor(readonly permission: Permission) {
    super(`Permission requise : ${PERMISSION_LABELS[permission] ?? permission}`);
    this.name = 'PermissionDeniedError';
  }
}

export function requirePermission(principal: Principal | null, permission: Permission): void {
  if (!can(principal, permission)) throw new PermissionDeniedError(permission);
}
