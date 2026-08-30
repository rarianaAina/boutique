/**
 * Vocabulaire du domaine.
 *
 * Chaque énumération est déclarée UNE fois ici, puis reprise telle quelle par
 * les contraintes CHECK de SQLite (voir les migrations). Une valeur ajoutée ici
 * sans migration correspondante sera refusée par la base : c'est voulu — mieux
 * vaut une écriture qui échoue qu'un statut que plus personne ne sait lire.
 */

/** Objet -> union de ses valeurs, pour éviter de répéter la liste en type. */
type Values<T> = T[keyof T];

/* ─── Boutiques et utilisateurs ─────────────────────────────────────────── */

export const SHOP_STATUS = {
  active: 'ACTIVE',
  suspended: 'SUSPENDED',
  closed: 'CLOSED',
} as const;
export type ShopStatus = Values<typeof SHOP_STATUS>;

export const USER_STATUS = {
  active: 'ACTIVE',
  suspended: 'SUSPENDED',
  archived: 'ARCHIVED',
} as const;
export type UserStatus = Values<typeof USER_STATUS>;

/* ─── Catalogue ─────────────────────────────────────────────────────────── */

/**
 * Mode de suivi d'un produit. C'est LE discriminant du modèle de stock :
 *
 *  - `IMEI`     : smartphone, une unité physique par appareil, IMEI obligatoire ;
 *  - `SERIAL`   : matériel sérialisé (enceinte, drone), numéro de série ;
 *  - `QUANTITY` : accessoires et consommables, suivis par quantité seulement.
 *
 * Les deux premiers créent des lignes dans `product_unit` ; le troisième
 * alimente `stock_level`. Aucun code ne doit tester la catégorie du produit
 * pour décider : c'est ce champ, et lui seul, qui commande.
 */
export const TRACKING = {
  imei: 'IMEI',
  serial: 'SERIAL',
  quantity: 'QUANTITY',
} as const;
export type Tracking = Values<typeof TRACKING>;

export const PRODUCT_STATUS = {
  active: 'ACTIVE',
  discontinued: 'DISCONTINUED',
  archived: 'ARCHIVED',
} as const;
export type ProductStatus = Values<typeof PRODUCT_STATUS>;

/** État physique d'une unité, indépendant de sa disponibilité commerciale. */
export const UNIT_CONDITION = {
  new: 'NEW',
  openBox: 'OPEN_BOX',
  refurbished: 'REFURBISHED',
  used: 'USED',
  damaged: 'DAMAGED',
} as const;
export type UnitCondition = Values<typeof UNIT_CONDITION>;

/**
 * Statut d'une unité physique (§7 du cahier des charges).
 *
 * `RESERVED` et `IN_TRANSFER` sont les deux statuts de verrouillage : ils
 * empêchent une seconde vente du même appareil, y compris depuis une autre
 * boutique une fois la synchronisation passée.
 */
export const UNIT_STATUS = {
  inStock: 'IN_STOCK',
  reserved: 'RESERVED',
  sold: 'SOLD',
  inTransfer: 'IN_TRANSFER',
  transferred: 'TRANSFERRED',
  returned: 'RETURNED',
  exchanged: 'EXCHANGED',
  refunded: 'REFUNDED',
  defective: 'DEFECTIVE',
  lost: 'LOST',
  blocked: 'BLOCKED',
} as const;
export type UnitStatus = Values<typeof UNIT_STATUS>;

/** Unités qu'on peut encore vendre depuis la boutique qui les détient. */
export const SELLABLE_UNIT_STATUSES: readonly UnitStatus[] = [
  UNIT_STATUS.inStock,
  UNIT_STATUS.returned,
];

/** Identifiants physiques portés par une unité. */
export const IDENTIFIER_KIND = {
  imei: 'IMEI',
  serial: 'SERIAL',
} as const;
export type IdentifierKind = Values<typeof IDENTIFIER_KIND>;

/* ─── Stock ─────────────────────────────────────────────────────────────── */

/**
 * Nature d'un mouvement de stock. Le SIGNE de la quantité n'est pas déduit du
 * type : il est stocké, pour qu'une correction d'inventaire puisse être
 * positive ou négative sans inventer deux types.
 */
export const MOVEMENT_TYPE = {
  purchaseReceipt: 'PURCHASE_RECEIPT',
  sale: 'SALE',
  saleCancelled: 'SALE_CANCELLED',
  customerReturn: 'CUSTOMER_RETURN',
  refund: 'REFUND',
  exchangeOut: 'EXCHANGE_OUT',
  exchangeIn: 'EXCHANGE_IN',
  transferOut: 'TRANSFER_OUT',
  transferIn: 'TRANSFER_IN',
  adjustment: 'ADJUSTMENT',
  inventory: 'INVENTORY',
  loss: 'LOSS',
  breakage: 'BREAKAGE',
  supplierReturn: 'SUPPLIER_RETURN',
} as const;
export type MovementType = Values<typeof MOVEMENT_TYPE>;

/** Libellés français, pour l'affichage — jamais utilisés comme clés. */
export const MOVEMENT_LABELS: Record<MovementType, string> = {
  PURCHASE_RECEIPT: 'Réception fournisseur',
  SALE: 'Vente',
  SALE_CANCELLED: 'Annulation de vente',
  CUSTOMER_RETURN: 'Retour client',
  REFUND: 'Remboursement',
  EXCHANGE_OUT: 'Échange — sortie',
  EXCHANGE_IN: 'Échange — reprise',
  TRANSFER_OUT: 'Transfert sortant',
  TRANSFER_IN: 'Transfert entrant',
  ADJUSTMENT: 'Correction de stock',
  INVENTORY: 'Inventaire',
  LOSS: 'Perte',
  BREAKAGE: 'Casse',
  SUPPLIER_RETURN: 'Retour fournisseur',
};

/** Document à l'origine d'un mouvement, pour remonter la piste. */
export const MOVEMENT_SOURCE = {
  purchase: 'PURCHASE',
  sale: 'SALE',
  refund: 'REFUND',
  exchange: 'EXCHANGE',
  transfer: 'TRANSFER',
  inventory: 'INVENTORY',
  manual: 'MANUAL',
  import: 'IMPORT',
} as const;
export type MovementSource = Values<typeof MOVEMENT_SOURCE>;

/* ─── Achats ────────────────────────────────────────────────────────────── */

export const PURCHASE_STATUS = {
  draft: 'DRAFT',
  ordered: 'ORDERED',
  partiallyReceived: 'PARTIALLY_RECEIVED',
  received: 'RECEIVED',
  closed: 'CLOSED',
  cancelled: 'CANCELLED',
} as const;
export type PurchaseStatus = Values<typeof PURCHASE_STATUS>;

export const PURCHASE_LABELS: Record<PurchaseStatus, string> = {
  DRAFT: 'Brouillon',
  ORDERED: 'Commandé',
  PARTIALLY_RECEIVED: 'Réception partielle',
  RECEIVED: 'Réception complète',
  CLOSED: 'Clôturé',
  CANCELLED: 'Annulé',
};

/** Nature d'un coût logistique rattaché à un achat (§11). */
export const LANDED_COST_KIND = {
  transport: 'TRANSPORT',
  delivery: 'DELIVERY',
  customs: 'CUSTOMS',
  insurance: 'INSURANCE',
  handling: 'HANDLING',
  other: 'OTHER',
} as const;
export type LandedCostKind = Values<typeof LANDED_COST_KIND>;

export const LANDED_COST_LABELS: Record<LandedCostKind, string> = {
  TRANSPORT: 'Transport',
  DELIVERY: 'Livraison',
  CUSTOMS: 'Douane',
  INSURANCE: 'Assurance',
  HANDLING: 'Manutention',
  OTHER: 'Autres frais',
};

/** Clé de ventilation d'un coût logistique sur les lignes d'achat. */
export const COST_ALLOCATION = {
  byValue: 'BY_VALUE',
  byQuantity: 'BY_QUANTITY',
} as const;
export type CostAllocation = Values<typeof COST_ALLOCATION>;

/* ─── Ventes ────────────────────────────────────────────────────────────── */

export const SALE_STATUS = {
  draft: 'DRAFT',
  completed: 'COMPLETED',
  cancelled: 'CANCELLED',
  refunded: 'REFUNDED',
  partiallyRefunded: 'PARTIALLY_REFUNDED',
} as const;
export type SaleStatus = Values<typeof SALE_STATUS>;

export const SALE_LABELS: Record<SaleStatus, string> = {
  DRAFT: 'Brouillon',
  COMPLETED: 'Validée',
  CANCELLED: 'Annulée',
  REFUNDED: 'Remboursée',
  PARTIALLY_REFUNDED: 'Partiellement remboursée',
};

export const INVOICE_STATUS = {
  draft: 'DRAFT',
  issued: 'ISSUED',
  paid: 'PAID',
  partiallyPaid: 'PARTIALLY_PAID',
  cancelled: 'CANCELLED',
  refunded: 'REFUNDED',
} as const;
export type InvoiceStatus = Values<typeof INVOICE_STATUS>;

export const INVOICE_LABELS: Record<InvoiceStatus, string> = {
  DRAFT: 'Brouillon',
  ISSUED: 'Émise',
  PAID: 'Payée',
  PARTIALLY_PAID: 'Partiellement payée',
  CANCELLED: 'Annulée',
  REFUNDED: 'Remboursée',
};

/**
 * Modes de paiement. La liste est PARAMÉTRABLE (table `payment_method`) ; ces
 * codes ne sont que le jeu livré par défaut à l'installation.
 */
export const DEFAULT_PAYMENT_METHODS = [
  { code: 'CASH', label: 'Espèces', changeAllowed: true },
  { code: 'CARD', label: 'Carte bancaire', changeAllowed: false },
  { code: 'TRANSFER', label: 'Virement', changeAllowed: false },
  { code: 'MOBILE_MONEY', label: 'Mobile money', changeAllowed: false },
  { code: 'OTHER', label: 'Autre', changeAllowed: false },
] as const;

export const REFUND_STATUS = {
  draft: 'DRAFT',
  completed: 'COMPLETED',
  cancelled: 'CANCELLED',
} as const;
export type RefundStatus = Values<typeof REFUND_STATUS>;

/* ─── Transferts ────────────────────────────────────────────────────────── */

export const TRANSFER_STATUS = {
  draft: 'DRAFT',
  requested: 'REQUESTED',
  approved: 'APPROVED',
  shipped: 'SHIPPED',
  inTransit: 'IN_TRANSIT',
  received: 'RECEIVED',
  rejected: 'REJECTED',
  cancelled: 'CANCELLED',
} as const;
export type TransferStatus = Values<typeof TRANSFER_STATUS>;

export const TRANSFER_LABELS: Record<TransferStatus, string> = {
  DRAFT: 'Brouillon',
  REQUESTED: 'Demandé',
  APPROVED: 'Validé',
  SHIPPED: 'Expédié',
  IN_TRANSIT: 'En transit',
  RECEIVED: 'Reçu',
  REJECTED: 'Refusé',
  CANCELLED: 'Annulé',
};

/* ─── Synchronisation ───────────────────────────────────────────────────── */

export const SYNC_STATUS = {
  pending: 'PENDING',
  sending: 'SENDING',
  sent: 'SENT',
  failed: 'FAILED',
  conflict: 'CONFLICT',
} as const;
export type SyncStatus = Values<typeof SYNC_STATUS>;

/* ─── Inventaire ────────────────────────────────────────────────────────── */

export const INVENTORY_STATUS = {
  open: 'OPEN',
  counted: 'COUNTED',
  applied: 'APPLIED',
  cancelled: 'CANCELLED',
} as const;
export type InventoryStatus = Values<typeof INVENTORY_STATUS>;

/* ─── Imports ───────────────────────────────────────────────────────────── */

export const IMPORT_STATUS = {
  draft: 'DRAFT',
  applied: 'APPLIED',
  rolledBack: 'ROLLED_BACK',
  failed: 'FAILED',
} as const;
export type ImportStatus = Values<typeof IMPORT_STATUS>;

export const IMPORT_MODE = {
  createOnly: 'CREATE_ONLY',
  createAndUpdate: 'CREATE_AND_UPDATE',
  updateOnly: 'UPDATE_ONLY',
} as const;
export type ImportMode = Values<typeof IMPORT_MODE>;

/** Liste des valeurs d'une énumération, pour les contraintes et les menus. */
export function valuesOf<T extends Record<string, string>>(source: T): T[keyof T][] {
  return Object.values(source) as T[keyof T][];
}
