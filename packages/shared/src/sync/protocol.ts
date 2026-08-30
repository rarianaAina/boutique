/**
 * Protocole de synchronisation.
 *
 * Décision d'architecture (§18) : on NE synchronise PAS des tables, on
 * synchronise des ÉVÉNEMENTS. Envoyer la base au serveur — ou même comparer des
 * lignes champ par champ — obligerait à décider, pour chaque colonne, qui a
 * raison entre deux boutiques hors ligne. Un événement, lui, décrit une
 * intention datée et signée par une boutique : « cet IMEI est entré chez moi le
 * 12 à 9 h ». Deux boutiques qui rejouent la même suite d'événements arrivent
 * au même état, et un événement rejoué deux fois ne fait rien de plus.
 *
 * Trois propriétés portent toute la fiabilité du système :
 *
 *  1. IDENTITÉ GLOBALE — chaque événement porte un `id` généré localement ; le
 *     serveur refuse d'appliquer deux fois le même. C'est ce qui rend un
 *     `push` rejouable après une coupure sans doubler une vente.
 *  2. ORDRE — le serveur attribue un `seq` monotone ; un pair reprend le flux
 *     depuis le dernier `seq` appliqué, jamais depuis une date (les horloges
 *     des postes ne sont pas fiables).
 *  3. RÉSERVATION — un IMEI ne peut être vendu que par la boutique qui le
 *     DÉTIENT ; le serveur arbitre la détention. Voir `ClaimRequest`.
 */

import type { IsoDate } from '../time';

/** Types d'événements. Un événement publié n'est jamais renommé. */
export const SYNC_EVENT = {
  productCreated: 'PRODUCT_CREATED',
  productUpdated: 'PRODUCT_UPDATED',
  supplierUpserted: 'SUPPLIER_UPSERTED',
  customerUpserted: 'CUSTOMER_UPSERTED',
  stockReceived: 'STOCK_RECEIVED',
  stockSold: 'STOCK_SOLD',
  stockReturned: 'STOCK_RETURNED',
  stockAdjusted: 'STOCK_ADJUSTED',
  unitStatusChanged: 'UNIT_STATUS_CHANGED',
  transferRequested: 'STOCK_TRANSFER_REQUESTED',
  transferApproved: 'STOCK_TRANSFER_APPROVED',
  transferShipped: 'STOCK_TRANSFER_SHIPPED',
  transferReceived: 'STOCK_TRANSFER_RECEIVED',
  transferRejected: 'STOCK_TRANSFER_REJECTED',
  transferCancelled: 'STOCK_TRANSFER_CANCELLED',
  saleRecorded: 'SALE_RECORDED',
  saleCancelled: 'SALE_CANCELLED',
  refundRecorded: 'REFUND_RECORDED',
  exchangeRecorded: 'EXCHANGE_RECORDED',
} as const;

export type SyncEventType = (typeof SYNC_EVENT)[keyof typeof SYNC_EVENT];

/**
 * Enveloppe d'un événement.
 *
 * `payload` n'est pas typé ici : chaque type d'événement a sa forme, décrite
 * par les services qui l'émettent. Le transport, lui, n'a besoin que de ces
 * champs — c'est ce qui permet d'ajouter un type d'événement sans toucher au
 * client de synchronisation.
 */
export interface SyncEvent {
  /** UUID généré par la boutique émettrice. Clé d'idempotence. */
  id: string;
  type: SyncEventType;
  /** Entité principale visée, pour le filtrage et le diagnostic. */
  entity: string;
  entityId: string;
  shopId: string;
  userId: string | null;
  /** Horodatage LOCAL d'émission ; indicatif, jamais utilisé pour ordonner. */
  occurredAt: IsoDate;
  payload: Record<string, unknown>;
}

/** Événement tel que le serveur le restitue : l'ordre en plus. */
export interface SequencedEvent extends SyncEvent {
  /** Rang d'application côté serveur. Strictement croissant. */
  seq: number;
  receivedAt: IsoDate;
}

export interface PushRequest {
  shopId: string;
  deviceId: string;
  events: SyncEvent[];
}

/** Sort d'un événement poussé. */
export const PUSH_OUTCOME = {
  /** Appliqué pour la première fois. */
  applied: 'APPLIED',
  /** Déjà connu du serveur : rien n'a été refait. */
  duplicate: 'DUPLICATE',
  /** Refusé — la raison est portée par `reason`. */
  rejected: 'REJECTED',
} as const;
export type PushOutcome = (typeof PUSH_OUTCOME)[keyof typeof PUSH_OUTCOME];

export interface PushResult {
  eventId: string;
  outcome: PushOutcome;
  seq: number | null;
  reason: string | null;
}

export interface PushResponse {
  results: PushResult[];
  /** Rang le plus élevé attribué par le serveur au moment de la réponse. */
  serverSeq: number;
}

export interface PullRequest {
  shopId: string;
  deviceId: string;
  /** Dernier rang déjà appliqué localement. Le serveur renvoie ce qui suit. */
  since: number;
  limit?: number;
}

export interface PullResponse {
  events: SequencedEvent[];
  /** Vrai si le serveur a d'autres événements au-delà de ce lot. */
  hasMore: boolean;
  serverSeq: number;
}

/* ─── Réservation d'unité (§19) ─────────────────────────────────────────── */

/**
 * Un IMEI est unique au monde ; une unité ne peut donc appartenir qu'à une
 * boutique à la fois. Le serveur tient ce registre de détention et arbitre :
 * la boutique A ne peut vendre que ce qu'il lui attribue.
 *
 * Cet appel n'est PAS sur le chemin de la vente courante — une boutique vend
 * hors ligne ce qu'elle détient. Il sert au transfert et à la détection de
 * conflit : deux boutiques qui se croient détentrices du même IMEI sont
 * départagées à la première synchronisation, et la perdante voit son unité
 * passer en conflit plutôt que de disparaître en silence.
 */
export interface ClaimRequest {
  shopId: string;
  deviceId: string;
  identifiers: { kind: string; value: string; unitId: string }[];
}

export interface ClaimResult {
  value: string;
  granted: boolean;
  /** Boutique actuellement détentrice, quand la revendication est refusée. */
  heldByShopId: string | null;
  reason: string | null;
}

export interface ClaimResponse {
  results: ClaimResult[];
}

/** Erreur de transport : distinguée d'un refus métier, car elle se rejoue. */
export class SyncTransportError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SyncTransportError';
  }
}

/**
 * Délai avant nouvelle tentative, en millisecondes.
 *
 * Croissance exponentielle plafonnée à cinq minutes : une boutique dont la clé
 * 4G est débranchée ne doit pas marteler le réseau, mais elle doit repartir
 * vite dès qu'elle revient.
 */
export function retryDelayMs(attempts: number): number {
  const base = 2_000 * 2 ** Math.max(0, attempts - 1);
  return Math.min(base, 300_000);
}
