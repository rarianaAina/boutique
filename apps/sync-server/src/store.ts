import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PUSH_OUTCOME, nowIso } from '@boutique/shared';
import type {
  ClaimRequest,
  ClaimResponse,
  ClaimResult,
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
  PushResult,
  SequencedEvent,
  SyncEvent,
} from '@boutique/shared';

/**
 * Cœur du serveur de synchronisation.
 *
 * Isolé du transport HTTP à dessein : l'application de bureau peut le brancher
 * directement dans ses tests, et vérifier le comportement RÉEL de la
 * synchronisation entre deux boutiques — pas celui d'une imitation qui finirait
 * par diverger du serveur.
 *
 * TROIS RÈGLES, ET RIEN D'AUTRE :
 *
 *  1. Un événement déjà connu (même `id`) n'est jamais appliqué deux fois.
 *  2. L'ordre est celui du serveur (`seq`), jamais celui des horloges locales.
 *  3. Un identifiant physique n'a qu'un détenteur ; le serveur tranche.
 */

const SCHEMA = fileURLToPath(new URL('./schema.sql', import.meta.url));

export interface JournalEntry {
  seq: number;
  id: string;
  type: string;
  entity: string;
  entityId: string;
  shopId: string;
  shopLabel: string;
  occurredAt: string;
  receivedAt: string;
}

interface JournalRow {
  seq: number;
  id: string;
  type: string;
  entity: string;
  entity_id: string;
  shop_id: string;
  occurred_at: string;
  received_at: string;
}

export interface DeviceCursor {
  deviceId: string;
  shopId: string;
  shopLabel: string;
  lastSeq: number;
  updatedAt: string;
}

export interface ShopRecord {
  id: string;
  code: string;
  name: string;
  token: string;
}

export class SyncStore {
  private readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(readFileSync(SCHEMA, 'utf8'));
  }

  close(): void {
    this.db.close();
  }

  /* ─── Enrôlement ──────────────────────────────────────────────────────── */

  registerShop(shop: ShopRecord): void {
    this.db
      .prepare(
        `INSERT INTO shop (id, code, name, token, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET code = excluded.code, name = excluded.name,
                                        token = excluded.token`,
      )
      .run(shop.id, shop.code, shop.name, shop.token, nowIso());
  }

  /** Vrai si le jeton correspond bien à cette boutique. */
  authenticate(shopId: string, token: string): boolean {
    const row = this.db.prepare('SELECT token FROM shop WHERE id = ?').get(shopId) as
      { token: string } | undefined;
    if (!row) return false;
    // Comparaison en temps constant : le jeton est un secret partagé.
    return timingSafeEqual(row.token, token);
  }

  shops(): ShopRecord[] {
    return this.db
      .prepare('SELECT id, code, name, token FROM shop ORDER BY code')
      .all() as unknown as ShopRecord[];
  }

  /* ─── Réception d'événements ──────────────────────────────────────────── */

  /**
   * Applique un lot d'événements.
   *
   * Chaque événement est traité séparément : un refus n'empêche pas les autres
   * de passer. C'est délibéré — si un IMEI en conflit bloquait tout le lot, une
   * boutique ne pourrait plus rien synchroniser tant que le litige n'est pas
   * réglé, et un désaccord sur un téléphone gèlerait toute une journée de vente.
   */
  push(request: PushRequest): PushResponse {
    const results: PushResult[] = [];
    for (const event of request.events) {
      results.push(this.applyEvent(request.shopId, event));
    }
    this.touchDevice(request.deviceId, request.shopId);
    return { results, serverSeq: this.serverSeq() };
  }

  private applyEvent(shopId: string, event: SyncEvent): PushResult {
    const known = this.db.prepare('SELECT seq FROM event WHERE id = ?').get(event.id) as
      { seq: number } | undefined;
    if (known) {
      return {
        eventId: event.id,
        outcome: PUSH_OUTCOME.duplicate,
        seq: known.seq,
        reason: null,
      };
    }

    if (event.shopId !== shopId) {
      return {
        eventId: event.id,
        outcome: PUSH_OUTCOME.rejected,
        seq: null,
        reason: "L'événement ne provient pas de la boutique authentifiée.",
      };
    }

    // Les identifiants qu'un événement d'entrée en stock revendique doivent
    // être libres, ou déjà détenus par cette boutique.
    const conflict = this.checkIdentifiers(event);
    if (conflict) {
      return { eventId: event.id, outcome: PUSH_OUTCOME.rejected, seq: null, reason: conflict };
    }

    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO event (id, type, entity, entity_id, shop_id, user_id, occurred_at,
                              received_at, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.id,
          event.type,
          event.entity,
          event.entityId,
          event.shopId,
          event.userId ?? null,
          event.occurredAt,
          nowIso(),
          JSON.stringify(event.payload),
        );
      this.updateRegistry(event);
      this.noterParties(event);
      this.db.exec('COMMIT');
    } catch (cause) {
      this.db.exec('ROLLBACK');
      // La contrainte d'unicité sur `id` est le filet de dernier recours contre
      // deux envois simultanés du même événement : on la traite comme un
      // doublon, pas comme une panne.
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.includes('UNIQUE') && message.includes('event.id')) {
        const row = this.db.prepare('SELECT seq FROM event WHERE id = ?').get(event.id) as
          { seq: number } | undefined;
        return {
          eventId: event.id,
          outcome: PUSH_OUTCOME.duplicate,
          seq: row?.seq ?? null,
          reason: null,
        };
      }
      return { eventId: event.id, outcome: PUSH_OUTCOME.rejected, seq: null, reason: message };
    }

    const row = this.db.prepare('SELECT seq FROM event WHERE id = ?').get(event.id) as {
      seq: number;
    };
    return { eventId: event.id, outcome: PUSH_OUTCOME.applied, seq: row.seq, reason: null };
  }

  /**
   * Retient les deux boutiques d'un colis, dès qu'un événement les nomme.
   *
   * Les événements de fin de course — réception, refus, annulation — ne les
   * répètent pas : sans cette trace, le serveur ne saurait plus à qui les
   * distribuer, et l'expéditeur manquerait l'accusé de réception de sa propre
   * marchandise.
   */
  private noterParties(event: SyncEvent): void {
    if (event.entity !== 'transfer') return;
    const transferId = String(event.payload['transferId'] ?? event.entityId ?? '');
    const to = String(event.payload['toShopId'] ?? '');
    if (transferId === '' || to === '') return;
    const from = String(event.payload['fromShopId'] ?? event.shopId);

    this.db
      .prepare(
        `INSERT INTO transfer_party (transfer_id, from_shop_id, to_shop_id, noted_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (transfer_id) DO NOTHING`,
      )
      .run(transferId, from, to, nowIso());
  }

  /* ─── Distribution ────────────────────────────────────────────────────── */

  /**
   * Types partagés par tout le réseau.
   *
   * Le catalogue circule partout : sans lui, un colis arriverait avec des
   * articles inconnus et un prix vide. Tout le reste — entrées, sorties,
   * ventes, états d'appareils — n'appartient qu'à la boutique qui l'a vécu.
   */
  private static readonly PARTAGES = [
    'PRODUCT_CREATED',
    'PRODUCT_UPDATED',
    'SUPPLIER_UPSERTED',
    'CUSTOMER_UPSERTED',
  ];

  /**
   * Événements postérieurs à `since` que cette boutique doit recevoir.
   *
   * LE FILTRAGE EST FAIT ICI, et non chez le pair. Tant que le serveur vivait
   * sur le réseau local de l'éditeur, lui faire tout envoyer était acceptable :
   * la boutique écartait ce qui ne la regardait pas. Sur Internet, autant
   * qu'elle ne le reçoive jamais.
   *
   * Ses propres événements sont exclus : les lui renvoyer la ferait travailler
   * à réappliquer ce qu'elle vient d'écrire.
   */
  pull(request: PullRequest): PullResponse {
    const limit = Math.min(request.limit ?? 200, 1000);
    // Lu AVANT la requête : un événement inséré entre les deux porterait un
    // rang supérieur, et ne serait donc pas sauté par le curseur.
    const serverSeq = this.serverSeq();

    const partages = SyncStore.PARTAGES.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT e.* FROM event e
         LEFT JOIN transfer_party p ON p.transfer_id = e.entity_id
          WHERE e.seq > ? AND e.seq <= ? AND e.shop_id <> ?
            AND (
              e.type IN (${partages})
              OR (e.entity = 'transfer' AND (p.from_shop_id = ? OR p.to_shop_id = ?))
            )
          ORDER BY e.seq LIMIT ?`,
      )
      .all(
        request.since,
        serverSeq,
        request.shopId,
        ...SyncStore.PARTAGES,
        request.shopId,
        request.shopId,
        limit + 1,
      ) as unknown as EventRow[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    this.touchDevice(request.deviceId, request.shopId, page.at(-1)?.seq);

    return {
      events: page.map(toSequencedEvent),
      hasMore,
      serverSeq,
      // Jusqu'où le journal a été EXAMINÉ. Quand la page est pleine, on s'arrête
      // au dernier événement rendu ; sinon, tout a été vu jusqu'au bout.
      nextSince: hasMore ? (page.at(-1)?.seq ?? request.since) : serverSeq,
    };
  }

  serverSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM event').get() as {
      seq: number;
    };
    return row.seq;
  }

  eventCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS total FROM event').get() as { total: number };
    return row.total;
  }

  /* ─── Diagnostic ──────────────────────────────────────────────────────── */

  /**
   * Derniers événements du journal, pour la page de consultation.
   *
   * ELLE EXISTE POUR UN SAMEDI SOIR : un colis n'est pas arrivé, le gérant
   * attend au téléphone, et il faut savoir si l'expédition est bien au journal
   * ou si elle dort encore dans la file d'une boutique. Sans cette page, il
   * faudrait aller chercher un fichier sur une machine distante.
   *
   * En lecture seule, et protégée : le journal porte le nom des clients.
   */
  journal(options: { shopId?: string; limit?: number } = {}): JournalEntry[] {
    const limit = Math.min(options.limit ?? 100, 500);
    const rows = options.shopId
      ? (this.db
          .prepare(
            `SELECT seq, id, type, entity, entity_id, shop_id, occurred_at, received_at
               FROM event WHERE shop_id = ? ORDER BY seq DESC LIMIT ?`,
          )
          .all(options.shopId, limit) as unknown as JournalRow[])
      : (this.db
          .prepare(
            `SELECT seq, id, type, entity, entity_id, shop_id, occurred_at, received_at
               FROM event ORDER BY seq DESC LIMIT ?`,
          )
          .all(limit) as unknown as JournalRow[]);

    const noms = new Map(this.shops().map((shop) => [shop.id, `${shop.name} (${shop.code})`]));
    return rows.map((row) => ({
      seq: row.seq,
      id: row.id,
      type: row.type,
      entity: row.entity,
      entityId: row.entity_id,
      shopId: row.shop_id,
      shopLabel: noms.get(row.shop_id) ?? row.shop_id,
      occurredAt: row.occurred_at,
      receivedAt: row.received_at,
    }));
  }

  /** Position de lecture de chaque poste : qui est à jour, qui a décroché. */
  cursors(): DeviceCursor[] {
    const rows = this.db
      .prepare(
        'SELECT device_id, shop_id, last_seq, updated_at FROM device_cursor ORDER BY shop_id',
      )
      .all() as unknown as {
      device_id: string;
      shop_id: string;
      last_seq: number;
      updated_at: string;
    }[];
    const noms = new Map(this.shops().map((shop) => [shop.id, `${shop.name} (${shop.code})`]));
    return rows.map((row) => ({
      deviceId: row.device_id,
      shopId: row.shop_id,
      shopLabel: noms.get(row.shop_id) ?? row.shop_id,
      lastSeq: row.last_seq,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Copie cohérente du journal, pour la sauvegarde.
   *
   * `VACUUM INTO` écrit une base complète et non un instantané d'un fichier en
   * cours d'écriture : recopier `sync.db` pendant qu'une boutique pousse un lot
   * donnerait un fichier tronqué, qu'on ne découvrirait qu'en tentant de le
   * restaurer.
   */
  backupTo(path: string): void {
    this.db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  }

  /* ─── Détention des identifiants ──────────────────────────────────────── */

  /**
   * Revendication explicite, utilisée avant un transfert.
   *
   * Une revendication refusée n'est PAS une erreur : elle indique quelle
   * boutique détient l'appareil, ce qui est exactement l'information dont on a
   * besoin pour trancher un litige.
   */
  claim(request: ClaimRequest): ClaimResponse {
    const results: ClaimResult[] = [];
    for (const identifier of request.identifiers) {
      const holder = this.holderOf(identifier.kind, identifier.value);
      if (!holder) {
        this.setHolder(identifier.kind, identifier.value, identifier.unitId, request.shopId);
        results.push({ value: identifier.value, granted: true, heldByShopId: null, reason: null });
        continue;
      }
      if (holder.shop_id === request.shopId) {
        results.push({
          value: identifier.value,
          granted: true,
          heldByShopId: request.shopId,
          reason: null,
        });
        continue;
      }
      results.push({
        value: identifier.value,
        granted: false,
        heldByShopId: holder.shop_id,
        reason: `Détenu par la boutique ${holder.shop_id}.`,
      });
    }
    return { results };
  }

  holderOf(kind: string, value: string): { unit_id: string; shop_id: string } | null {
    return (
      (this.db
        .prepare('SELECT unit_id, shop_id FROM identifier_registry WHERE kind = ? AND value = ?')
        .get(kind, value) as { unit_id: string; shop_id: string } | undefined) ?? null
    );
  }

  private setHolder(kind: string, value: string, unitId: string, shopId: string): void {
    this.db
      .prepare(
        `INSERT INTO identifier_registry (kind, value, unit_id, shop_id, claimed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (kind, value) DO UPDATE SET unit_id = excluded.unit_id,
                                                 shop_id = excluded.shop_id,
                                                 claimed_at = excluded.claimed_at`,
      )
      .run(kind, value, unitId, shopId, nowIso());
  }

  /**
   * Refuse une entrée en stock portant un identifiant déjà détenu ailleurs.
   *
   * C'est LE garde-fou contre le même téléphone vendu dans deux boutiques : la
   * seconde à le déclarer voit son événement refusé, et le conflit remonte à
   * l'écran de synchronisation au lieu de se perdre.
   */
  private checkIdentifiers(event: SyncEvent): string | null {
    const identifiers = readIdentifiers(event);
    for (const identifier of identifiers) {
      const holder = this.holderOf(identifier.kind, identifier.value);
      if (holder && holder.shop_id !== event.shopId && holder.unit_id !== identifier.unitId) {
        return `${identifier.kind} ${identifier.value} est déjà détenu par la boutique ${holder.shop_id}.`;
      }
    }
    return null;
  }

  /** Met à jour la détention en fonction du type d'événement. */
  private updateRegistry(event: SyncEvent): void {
    for (const identifier of readIdentifiers(event)) {
      this.setHolder(identifier.kind, identifier.value, identifier.unitId, event.shopId);
    }

    // Une réception de transfert fait passer la détention à la destination.
    if (event.type === 'STOCK_TRANSFER_RECEIVED') {
      const toShopId = String(event.payload['toShopId'] ?? event.shopId);
      const unitIds = readUnitIds(event.payload);
      for (const unitId of unitIds) {
        this.db
          .prepare('UPDATE identifier_registry SET shop_id = ?, claimed_at = ? WHERE unit_id = ?')
          .run(toShopId, nowIso(), unitId);
      }
    }
  }

  private touchDevice(deviceId: string, shopId: string, lastSeq?: number): void {
    this.db
      .prepare(
        `INSERT INTO device_cursor (device_id, shop_id, last_seq, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (device_id) DO UPDATE SET shop_id = excluded.shop_id,
           last_seq = MAX(device_cursor.last_seq, excluded.last_seq),
           updated_at = excluded.updated_at`,
      )
      .run(deviceId, shopId, lastSeq ?? 0, nowIso());
  }
}

interface EventRow {
  seq: number;
  id: string;
  type: string;
  entity: string;
  entity_id: string;
  shop_id: string;
  user_id: string | null;
  occurred_at: string;
  received_at: string;
  payload: string;
}

function toSequencedEvent(row: EventRow): SequencedEvent {
  return {
    seq: row.seq,
    id: row.id,
    type: row.type as SequencedEvent['type'],
    entity: row.entity,
    entityId: row.entity_id,
    shopId: row.shop_id,
    userId: row.user_id,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  };
}

/** Identifiants physiques revendiqués par un événement d'entrée en stock. */
function readIdentifiers(event: SyncEvent): { kind: string; value: string; unitId: string }[] {
  if (event.type !== 'STOCK_RECEIVED') return [];
  const unitId = String(event.payload['unitId'] ?? event.entityId);
  const raw = event.payload['identifiers'];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is { kind: string; value: string } => {
      return (
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { value?: unknown }).value === 'string'
      );
    })
    .map((entry) => ({ kind: entry.kind, value: entry.value, unitId }));
}

function readUnitIds(payload: Record<string, unknown>): string[] {
  const lines = payload['lines'];
  if (!Array.isArray(lines)) return [];
  return lines
    .map((line) =>
      typeof line === 'object' && line !== null ? (line as { unitId?: unknown }).unitId : null,
    )
    .filter((value): value is string => typeof value === 'string');
}

/** Comparaison de jetons en temps constant. */
function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
