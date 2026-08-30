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
  shopManage: 'shop.manage',
  reportView: 'report.view',
  userManage: 'user.manage',
  importRun: 'import.run',
  settingsManage: 'settings.manage',
  syncRun: 'sync.run',
  auditView: 'audit.view',
  backupManage: 'backup.manage',
} as const;

/**
 * Accès aux ÉCRANS, distinct des permissions d'action.
 *
 * Deux questions différentes, et les confondre finit toujours mal :
 *
 *  - « ce rôle peut-il OUVRIR la page des achats ? »  -> `page.*`
 *  - « ce rôle peut-il VALIDER une réception ? »      -> `purchase.receive`
 *
 * Un comptable doit pouvoir consulter les achats sans jamais en réceptionner ;
 * un responsable stock doit réceptionner sans voir la page des utilisateurs.
 * Avec une seule permission par domaine, l'un des deux cas est impossible.
 *
 * Une page par entrée de menu, sans exception : c'est ce qui permet de régler
 * l'accès page par page, comme le demande le cahier des charges (§4).
 */
export const PAGE_PERMISSIONS = {
  tableau: 'page.tableau',
  caisse: 'page.caisse',
  tickets: 'page.tickets',
  factures: 'page.factures',
  remboursements: 'page.remboursements',
  echanges: 'page.echanges',
  produits: 'page.produits',
  appareils: 'page.appareils',
  mouvements: 'page.mouvements',
  inventaire: 'page.inventaire',
  'stock-faible': 'page.stock-faible',
  fournisseurs: 'page.fournisseurs',
  achats: 'page.achats',
  transferts: 'page.transferts',
  synchronisation: 'page.synchronisation',
  clients: 'page.clients',
  rapports: 'page.rapports',
  prix: 'page.prix',
  import: 'page.import',
  journal: 'page.journal',
  boutiques: 'page.boutiques',
  utilisateurs: 'page.utilisateurs',
  parametres: 'page.parametres',
} as const;

export type PagePermission = (typeof PAGE_PERMISSIONS)[keyof typeof PAGE_PERMISSIONS];

export const ALL_PAGE_PERMISSIONS: readonly PagePermission[] = Object.values(PAGE_PERMISSIONS);

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS] | PagePermission;

export const ACTION_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS);

export const ALL_PERMISSIONS: readonly Permission[] = [
  ...ACTION_PERMISSIONS,
  ...ALL_PAGE_PERMISSIONS,
];

/** Libellé d'une page, pour l'écran d'édition d'un rôle. */
export const PAGE_LABELS: Record<PagePermission, string> = {
  'page.tableau': 'Tableau de bord',
  'page.caisse': 'Nouvelle vente',
  'page.tickets': 'Tickets',
  'page.factures': 'Factures',
  'page.remboursements': 'Remboursements',
  'page.echanges': 'Échanges',
  'page.produits': 'Produits',
  'page.appareils': 'IMEI / Séries',
  'page.mouvements': 'Mouvements de stock',
  'page.inventaire': 'Inventaire',
  'page.stock-faible': 'Stock faible',
  'page.fournisseurs': 'Fournisseurs',
  'page.achats': 'Commandes et réceptions',
  'page.transferts': 'Transferts',
  'page.synchronisation': 'Synchronisation',
  'page.clients': 'Clients',
  'page.rapports': 'Rapports',
  'page.prix': 'Évolution des prix',
  'page.import': 'Import Excel',
  'page.journal': "Journal d'audit",
  'page.boutiques': 'Boutiques',
  'page.utilisateurs': 'Utilisateurs et rôles',
  'page.parametres': 'Paramètres',
};

/** Regroupement des pages, dans l'ordre du menu. */
export const PAGE_GROUPS: { title: string; pages: PagePermission[] }[] = [
  { title: 'Accueil', pages: [PAGE_PERMISSIONS.tableau] },
  {
    title: 'Ventes',
    pages: [
      PAGE_PERMISSIONS.caisse,
      PAGE_PERMISSIONS.tickets,
      PAGE_PERMISSIONS.factures,
      PAGE_PERMISSIONS.remboursements,
      PAGE_PERMISSIONS.echanges,
    ],
  },
  {
    title: 'Stock',
    pages: [
      PAGE_PERMISSIONS.produits,
      PAGE_PERMISSIONS.appareils,
      PAGE_PERMISSIONS.mouvements,
      PAGE_PERMISSIONS.inventaire,
      PAGE_PERMISSIONS['stock-faible'],
    ],
  },
  { title: 'Achats', pages: [PAGE_PERMISSIONS.fournisseurs, PAGE_PERMISSIONS.achats] },
  {
    title: 'Réseau',
    pages: [PAGE_PERMISSIONS.transferts, PAGE_PERMISSIONS.synchronisation],
  },
  {
    title: 'Gestion',
    pages: [
      PAGE_PERMISSIONS.clients,
      PAGE_PERMISSIONS.rapports,
      PAGE_PERMISSIONS.prix,
      PAGE_PERMISSIONS.import,
      PAGE_PERMISSIONS.journal,
      PAGE_PERMISSIONS.boutiques,
      PAGE_PERMISSIONS.utilisateurs,
      PAGE_PERMISSIONS.parametres,
    ],
  },
];

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
      PERMISSIONS.shopManage,
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
  'shop.manage': 'Créer et modifier les boutiques',
  ...PAGE_LABELS,
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

/**
 * Pages livrées avec chaque rôle.
 *
 * Un point de départ, pas une contrainte : l'administrateur peut ensuite
 * ouvrir ou fermer chaque page rôle par rôle, ce que l'écran des rôles
 * propose page par page.
 */
const PAGES_VENDEUR: Permission[] = [
  PAGE_PERMISSIONS.tableau,
  PAGE_PERMISSIONS.caisse,
  PAGE_PERMISSIONS.tickets,
  PAGE_PERMISSIONS.produits,
  PAGE_PERMISSIONS.appareils,
  PAGE_PERMISSIONS.clients,
];

const PAGES_STOCK: Permission[] = [
  PAGE_PERMISSIONS.tableau,
  PAGE_PERMISSIONS.produits,
  PAGE_PERMISSIONS.appareils,
  PAGE_PERMISSIONS.mouvements,
  PAGE_PERMISSIONS.inventaire,
  PAGE_PERMISSIONS['stock-faible'],
  PAGE_PERMISSIONS.achats,
  PAGE_PERMISSIONS.transferts,
  PAGE_PERMISSIONS.rapports,
  PAGE_PERMISSIONS.import,
];

const PAGES_ACHATS: Permission[] = [
  PAGE_PERMISSIONS.tableau,
  PAGE_PERMISSIONS.produits,
  PAGE_PERMISSIONS.appareils,
  PAGE_PERMISSIONS['stock-faible'],
  PAGE_PERMISSIONS.fournisseurs,
  PAGE_PERMISSIONS.achats,
  PAGE_PERMISSIONS.rapports,
  PAGE_PERMISSIONS.prix,
  PAGE_PERMISSIONS.import,
];

const PAGES_COMPTA: Permission[] = [
  PAGE_PERMISSIONS.tableau,
  PAGE_PERMISSIONS.tickets,
  PAGE_PERMISSIONS.factures,
  PAGE_PERMISSIONS.remboursements,
  PAGE_PERMISSIONS.echanges,
  PAGE_PERMISSIONS.achats,
  PAGE_PERMISSIONS.clients,
  PAGE_PERMISSIONS.rapports,
  PAGE_PERMISSIONS.prix,
  PAGE_PERMISSIONS.journal,
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
    // Tout sauf l'administration du réseau et des comptes : un gérant pilote
    // SA boutique, il ne crée ni utilisateurs ni boutiques.
    permissions: ALL_PERMISSIONS.filter(
      (permission) =>
        ![
          P.userManage,
          P.settingsManage,
          P.shopManage,
          PAGE_PERMISSIONS.utilisateurs,
          PAGE_PERMISSIONS.parametres,
          PAGE_PERMISSIONS.boutiques,
        ].includes(permission as never),
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
      ...PAGES_STOCK,
    ],
  },
  {
    code: 'SELLER',
    name: 'Vendeur',
    description: 'Encaisse. Ne voit ni les coûts ni les marges.',
    permissions: [...SELLER, ...PAGES_VENDEUR],
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
      ...PAGES_VENDEUR,
      PAGE_PERMISSIONS.factures,
      PAGE_PERMISSIONS.remboursements,
      PAGE_PERMISSIONS.echanges,
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
      ...PAGES_COMPTA,
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
      ...PAGES_ACHATS,
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

/**
 * Déduit les pages accessibles d'une liste de permissions d'action.
 *
 * Sert UNIQUEMENT à rattraper les rôles créés avant l'existence des
 * permissions de page : sans cela, une base existante afficherait un menu vide
 * après mise à jour, et l'application paraîtrait cassée.
 *
 * Ce n'est pas une règle permanente : une fois les pages inscrites sur le rôle,
 * l'administrateur les ouvre et les ferme à sa guise, indépendamment des
 * actions.
 */
export function derivePagesFromActions(actions: readonly Permission[]): PagePermission[] {
  const detient = (permission: Permission) => actions.includes(permission);
  const pages = new Set<PagePermission>([PAGE_PERMISSIONS.tableau]);

  const ajouter = (condition: boolean, ...cibles: PagePermission[]) => {
    if (condition) for (const cible of cibles) pages.add(cible);
  };

  ajouter(detient(PERMISSIONS.saleCreate), PAGE_PERMISSIONS.caisse, PAGE_PERMISSIONS.tickets);
  ajouter(detient(PERMISSIONS.saleViewAll), PAGE_PERMISSIONS.tickets);
  ajouter(detient(PERMISSIONS.invoiceManage), PAGE_PERMISSIONS.factures);
  ajouter(detient(PERMISSIONS.refundCreate), PAGE_PERMISSIONS.remboursements);
  ajouter(detient(PERMISSIONS.exchangeCreate), PAGE_PERMISSIONS.echanges);
  ajouter(detient(PERMISSIONS.productView), PAGE_PERMISSIONS.produits);
  ajouter(
    detient(PERMISSIONS.stockView),
    PAGE_PERMISSIONS.appareils,
    PAGE_PERMISSIONS.mouvements,
    PAGE_PERMISSIONS['stock-faible'],
  );
  ajouter(detient(PERMISSIONS.inventoryManage), PAGE_PERMISSIONS.inventaire);
  ajouter(detient(PERMISSIONS.supplierManage), PAGE_PERMISSIONS.fournisseurs);
  ajouter(
    detient(PERMISSIONS.purchaseView),
    PAGE_PERMISSIONS.achats,
    PAGE_PERMISSIONS.fournisseurs,
  );
  ajouter(
    detient(PERMISSIONS.transferCreate) || detient(PERMISSIONS.transferReceive),
    PAGE_PERMISSIONS.transferts,
  );
  ajouter(detient(PERMISSIONS.syncRun), PAGE_PERMISSIONS.synchronisation);
  ajouter(detient(PERMISSIONS.customerView), PAGE_PERMISSIONS.clients);
  ajouter(detient(PERMISSIONS.reportView), PAGE_PERMISSIONS.rapports);
  ajouter(detient(PERMISSIONS.costView), PAGE_PERMISSIONS.prix);
  ajouter(detient(PERMISSIONS.importRun), PAGE_PERMISSIONS.import);
  ajouter(detient(PERMISSIONS.auditView), PAGE_PERMISSIONS.journal);
  ajouter(detient(PERMISSIONS.userManage), PAGE_PERMISSIONS.utilisateurs);
  ajouter(detient(PERMISSIONS.settingsManage), PAGE_PERMISSIONS.parametres);
  ajouter(detient(PERMISSIONS.shopManage), PAGE_PERMISSIONS.boutiques);

  return [...pages];
}

export function isPagePermission(permission: Permission): permission is PagePermission {
  return permission.startsWith('page.');
}
