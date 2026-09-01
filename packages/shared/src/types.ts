/**
 * Entités du domaine.
 *
 * Ces types décrivent les objets tels que la couche métier les manipule — pas
 * tels que SQLite les stocke. La traduction (colonnes `snake_case`, booléens en
 * 0/1, JSON en texte) est le travail des dépôts, et d'eux seuls : aucun écran
 * ne doit jamais voir un `is_active: 1`.
 */

import type { Money } from './money';
import type { IsoDate } from './time';
import type {
  CostAllocation,
  IdentifierKind,
  ImportMode,
  ImportStatus,
  InventoryStatus,
  InvoiceStatus,
  LandedCostKind,
  MovementSource,
  MovementType,
  ProductStatus,
  PurchaseStatus,
  RefundStatus,
  SaleStatus,
  ShopStatus,
  SyncStatus,
  Tracking,
  TransferStatus,
  UnitCondition,
  UnitStatus,
  UserStatus,
} from './enums';
import type { Permission } from './permissions';

/** Champs communs à toute entité synchronisable et effaçable logiquement. */
export interface Traceable {
  createdAt: IsoDate;
  updatedAt: IsoDate;
  /** Suppression LOGIQUE (§27) : les données comptables ne disparaissent pas. */
  deletedAt: IsoDate | null;
}

export interface Shop extends Traceable {
  id: string;
  /** Code court, repris dans les numéros de documents. Unique. */
  code: string;
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  /** Numéro d'identification fiscale, imprimé sur les factures. */
  nif: string | null;
  /** Numéro statistique, imprimé sur les factures. */
  stat: string | null;
  status: ShopStatus;
  /** Vrai pour la boutique installée sur CE poste. Une seule à la fois. */
  isLocal: boolean;
}

export interface Role extends Traceable {
  id: string;
  code: string;
  name: string;
  description: string | null;
  permissions: Permission[];
  /** Un rôle système ne peut pas être supprimé, seulement modifié. */
  isSystem: boolean;
}

export interface User extends Traceable {
  id: string;
  shopId: string;
  fullName: string;
  login: string;
  email: string | null;
  roleId: string;
  status: UserStatus;
  lastLoginAt: IsoDate | null;
  /** Tentatives infructueuses consécutives, pour le verrouillage temporaire. */
  failedAttempts: number;
  lockedUntil: IsoDate | null;
}

/** Utilisateur tel qu'il circule dans l'application : sans empreinte. */
export interface SessionUser {
  id: string;
  shopId: string;
  shopCode: string;
  shopName: string;
  fullName: string;
  login: string;
  roleId: string;
  roleCode: string;
  roleName: string;
  permissions: Permission[];
}

export interface Category extends Traceable {
  id: string;
  parentId: string | null;
  code: string;
  name: string;
  position: number;
}

export interface Supplier extends Traceable {
  id: string;
  code: string;
  name: string;
  company: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  country: string | null;
  /** Conditions commerciales, en clair (délai, acompte, incoterm...). */
  terms: string | null;
  notes: string | null;
  isActive: boolean;
}

/**
 * Produit : le MODÈLE, jamais l'exemplaire (§5).
 *
 * « iPhone 15 128 Go noir » est un produit ; l'appareil dont l'IMEI finit par
 * 47 est une `ProductUnit`. Confondre les deux rend impossible de savoir lequel
 * des deux téléphones identiques a été vendu à quel client.
 */
export interface Product extends Traceable {
  id: string;
  sku: string;
  reference: string | null;
  barcode: string | null;
  name: string;
  brand: string | null;
  model: string | null;
  categoryId: string | null;
  description: string | null;
  tracking: Tracking;
  purchasePrice: Money;
  salePrice: Money;
  /** Plancher de négociation ; une remise ne peut pas descendre en dessous. */
  minPrice: Money | null;
  /** TVA en centièmes de point (20 % -> 2000). Null = régime non assujetti. */
  taxRate: number | null;
  defaultSupplierId: string | null;
  unit: string;
  minStock: number;
  photoPath: string | null;
  status: ProductStatus;
  /** Caractéristiques libres : RAM, connectique, tout ce qui ne varie pas. */
  attributes: Record<string, string>;
  /**
   * Axes de variation d'un modèle.
   *
   * Promus en colonnes depuis `attributes` : ce sont eux qu'un vendeur choisit
   * au comptoir, et l'on ne filtre pas efficacement sur du JSON.
   */
  color: string | null;
  capacity: string | null;
  /** Réunit les déclinaisons d'un même modèle. Voir `variantGroupKey`. */
  variantGroup: string | null;
}

/** Identifiant physique d'une unité : IMEI 1, IMEI 2 ou numéro de série. */
export interface UnitIdentifier {
  id: string;
  unitId: string;
  kind: IdentifierKind;
  /** 1 ou 2 pour l'IMEI d'un bi-SIM ; 1 pour un numéro de série. */
  slot: number;
  value: string;
}

/**
 * Unité physique : UN appareil, avec son propre historique.
 *
 * `shopId` désigne la boutique qui la DÉTIENT à cet instant ; il change lors
 * d'un transfert reçu, jamais lors d'une simple expédition (tant que le colis
 * n'est pas arrivé, l'unité reste rattachée à l'expéditeur, en `IN_TRANSFER`).
 */
export interface ProductUnit extends Traceable {
  id: string;
  productId: string;
  shopId: string;
  status: UnitStatus;
  condition: UnitCondition;
  imei1: string | null;
  imei2: string | null;
  serial: string | null;
  color: string | null;
  capacity: string | null;
  /** Coût d'acquisition réel de CETTE unité, frais logistiques inclus (§11). */
  costPrice: Money;
  supplierId: string | null;
  purchaseId: string | null;
  receivedAt: IsoDate | null;
  soldAt: IsoDate | null;
  saleId: string | null;
  transferId: string | null;
  notes: string | null;
}

/** Stock des produits NON sérialisés, par boutique. */
export interface StockLevel {
  productId: string;
  shopId: string;
  quantity: number;
  /** Quantité engagée (panier en attente, transfert demandé). */
  reserved: number;
  updatedAt: IsoDate;
}

/**
 * Mouvement de stock : la mémoire du logiciel.
 *
 * Aucune quantité ne bouge sans une ligne ici (§6). C'est ce qui permet de
 * répondre à « d'où vient cet appareil » un an plus tard, et de recalculer un
 * stock si une valeur agrégée venait à diverger.
 */
export interface StockMovement {
  id: string;
  shopId: string;
  productId: string;
  unitId: string | null;
  type: MovementType;
  /** Signée : positive pour une entrée, négative pour une sortie. */
  quantity: number;
  unitCost: Money | null;
  source: MovementSource;
  sourceId: string | null;
  /** Numéro du document d'origine, recopié pour rester lisible sans jointure. */
  sourceLabel: string | null;
  userId: string | null;
  occurredAt: IsoDate;
  note: string | null;
  createdAt: IsoDate;
}

export interface Customer extends Traceable {
  id: string;
  shopId: string | null;
  firstName: string | null;
  lastName: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  /**
   * NIF et STAT du client, quand c'en est un professionnel.
   *
   * Sans eux, la comptabilité d'une entreprise cliente refuse la facture. Un
   * particulier n'en a pas : les deux restent facultatifs.
   */
  nif: string | null;
  stat: string | null;
  notes: string | null;
}

export interface PurchaseLine {
  id: string;
  purchaseId: string;
  productId: string;
  label: string;
  quantity: number;
  receivedQuantity: number;
  unitPrice: Money;
  discount: Money;
  taxRate: number | null;
  lineTotal: Money;
  /** Part des frais logistiques imputée à cette ligne, une fois ventilés. */
  allocatedCost: Money;
}

export interface LandedCost {
  id: string;
  purchaseId: string;
  kind: LandedCostKind;
  label: string | null;
  amount: Money;
  allocation: CostAllocation;
  createdAt: IsoDate;
}

export interface Purchase extends Traceable {
  id: string;
  shopId: string;
  number: string;
  supplierId: string;
  supplierReference: string | null;
  status: PurchaseStatus;
  orderedAt: IsoDate | null;
  expectedAt: IsoDate | null;
  subtotal: Money;
  discount: Money;
  tax: Money;
  /** Somme des `LandedCost`, recopiée pour l'affichage des listes. */
  landedCostTotal: Money;
  total: Money;
  notes: string | null;
  createdBy: string;
}

export interface PurchaseReceipt {
  id: string;
  purchaseId: string;
  shopId: string;
  receivedAt: IsoDate;
  userId: string;
  note: string | null;
  createdAt: IsoDate;
}

export interface SaleLine {
  id: string;
  saleId: string;
  productId: string;
  unitId: string | null;
  label: string;
  /** Identifiant recopié sur la ligne : un ticket doit rester lisible seul. */
  identifier: string | null;
  quantity: number;
  unitPrice: Money;
  discount: Money;
  taxRate: number | null;
  lineTotal: Money;
  /** Coût au moment de la vente : fige la marge, même si le prix change après. */
  unitCost: Money;
  refundedQuantity: number;
}

export interface SalePayment {
  id: string;
  saleId: string;
  method: string;
  amount: Money;
  /** Référence externe : n° d'autorisation carte, référence mobile money... */
  reference: string | null;
  paidAt: IsoDate;
}

export interface Sale extends Traceable {
  id: string;
  shopId: string;
  number: string;
  status: SaleStatus;
  customerId: string | null;
  userId: string;
  soldAt: IsoDate;
  subtotal: Money;
  discount: Money;
  tax: Money;
  total: Money;
  paid: Money;
  /** Monnaie rendue, pour reproduire le ticket à l'identique. */
  changeGiven: Money;
  note: string | null;
  cancelledAt: IsoDate | null;
  cancelledBy: string | null;
}

export interface Invoice extends Traceable {
  id: string;
  shopId: string;
  number: string;
  saleId: string | null;
  customerId: string | null;
  status: InvoiceStatus;
  issuedAt: IsoDate;
  dueAt: IsoDate | null;
  subtotal: Money;
  discount: Money;
  tax: Money;
  total: Money;
  paid: Money;
  notes: string | null;
}

export interface RefundLine {
  id: string;
  refundId: string;
  saleLineId: string;
  productId: string;
  unitId: string | null;
  quantity: number;
  amount: Money;
  /** L'article revient-il en stock ? Faux pour un appareil cassé. */
  restock: boolean;
}

export interface Refund extends Traceable {
  id: string;
  shopId: string;
  number: string;
  saleId: string;
  status: RefundStatus;
  reason: string | null;
  method: string;
  total: Money;
  userId: string;
  refundedAt: IsoDate;
}

export interface Exchange extends Traceable {
  id: string;
  shopId: string;
  number: string;
  originalSaleId: string;
  /** Vente créée pour l'appareil remis au client. Jamais l'ancienne modifiée. */
  newSaleId: string | null;
  returnedUnitId: string;
  newUnitId: string | null;
  newProductId: string | null;
  /** Positive : le client complète. Négative : la boutique rembourse. */
  priceDifference: Money;
  settledMethod: string | null;
  reason: string | null;
  userId: string;
  exchangedAt: IsoDate;
}

export interface TransferLine {
  id: string;
  transferId: string;
  productId: string;
  unitId: string | null;
  label: string;
  identifier: string | null;
  quantity: number;
  receivedQuantity: number;
}

export interface Transfer extends Traceable {
  id: string;
  number: string;
  fromShopId: string;
  toShopId: string;
  status: TransferStatus;
  requestedBy: string;
  requestedAt: IsoDate;
  approvedAt: IsoDate | null;
  shippedAt: IsoDate | null;
  receivedAt: IsoDate | null;
  receivedBy: string | null;
  note: string | null;
  rejectionReason: string | null;
}

export interface InventorySession extends Traceable {
  id: string;
  shopId: string;
  number: string;
  status: InventoryStatus;
  startedBy: string;
  startedAt: IsoDate;
  appliedAt: IsoDate | null;
  note: string | null;
}

export interface InventoryLine {
  id: string;
  sessionId: string;
  productId: string;
  unitId: string | null;
  expectedQuantity: number;
  countedQuantity: number | null;
  note: string | null;
}

export interface AuditEntry {
  id: string;
  at: IsoDate;
  userId: string | null;
  userLabel: string | null;
  shopId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
}

export interface OutboxEntry {
  id: string;
  type: string;
  entity: string;
  entityId: string;
  shopId: string;
  userId: string | null;
  payload: Record<string, unknown>;
  status: SyncStatus;
  attempts: number;
  lastError: string | null;
  createdAt: IsoDate;
  /** Prochaine tentative autorisée ; porte le recul exponentiel. */
  nextAttemptAt: IsoDate | null;
  sentAt: IsoDate | null;
}

export interface ImportBatch {
  id: string;
  shopId: string;
  fileName: string;
  sheetName: string | null;
  mode: ImportMode;
  status: ImportStatus;
  /** Correspondance colonne Excel -> champ, telle qu'elle a été validée. */
  mapping: Record<string, string>;
  totalRows: number;
  createdRows: number;
  updatedRows: number;
  skippedRows: number;
  errorRows: number;
  startedAt: IsoDate;
  finishedAt: IsoDate | null;
  userId: string;
  note: string | null;
}

export interface PaymentMethod {
  code: string;
  label: string;
  isActive: boolean;
  changeAllowed: boolean;
  position: number;
}
