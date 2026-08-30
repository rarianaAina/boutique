import { newId, nowIso, retryDelayMs } from '@boutique/shared';
import type { OutboxEntry, SyncEvent, SyncEventType, SyncStatus } from '@boutique/shared';
import { chunk, placeholders } from '../chunk';
import { parseJson, toJson } from '../rows';
import type { SqlExecutor } from '../client';

/**
 * File sortante de synchronisation.
 *
 * Chaque opération synchronisable dépose ici un événement, DANS LA MÊME
 * TRANSACTION que l'écriture métier. C'est l'unique garantie que « vente
 * enregistrée » et « vente à synchroniser » ne peuvent pas diverger : soit les
 * deux sont écrits, soit aucun.
 *
 * L'identifiant de l'événement est sa clé d'idempotence côté serveur : rejouer
 * un envoi après une coupure ne peut donc pas doubler une vente.
 */

interface OutboxRow {
  id: string;
  type: string;
  entity: string;
  entity_id: string;
  shop_id: string;
  user_id: string | null;
  payload: string;
  status: SyncStatus;
  attempts: number;
  last_error: string | null;
  created_at: string;
  next_attempt_at: string | null;
  sent_at: string | null;
}

const toEntry = (row: OutboxRow): OutboxEntry => ({
  id: row.id,
  type: row.type,
  entity: row.entity,
  entityId: row.entity_id,
  shopId: row.shop_id,
  userId: row.user_id,
  payload: parseJson<Record<string, unknown>>(row.payload, {}),
  status: row.status,
  attempts: row.attempts,
  lastError: row.last_error,
  createdAt: row.created_at,
  nextAttemptAt: row.next_attempt_at,
  sentAt: row.sent_at,
});

export interface OutboxInput {
  type: SyncEventType;
  entity: string;
  entityId: string;
  shopId: string;
  userId?: string | null;
  payload: Record<string, unknown>;
}

export class OutboxRepository {
  constructor(private readonly db: SqlExecutor) {}

  async enqueue(input: OutboxInput, id = newId()): Promise<string> {
    await this.db.execute(
      `INSERT INTO sync_outbox (id, type, entity, entity_id, shop_id, user_id, payload,
                                status, attempts, created_at, next_attempt_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?)`,
      [
        id,
        input.type,
        input.entity,
        input.entityId,
        input.shopId,
        input.userId ?? null,
        toJson(input.payload),
        nowIso(),
        nowIso(),
      ],
    );
    return id;
  }

  /**
   * Prochain lot à envoyer.
   *
   * ORDRE : par `rowid`, l'ordre d'insertion physique — PAS par `created_at`.
   * Deux événements écrits dans la même milliseconde (une validation suivie
   * d'une expédition, ce qui arrive dès qu'on enchaîne deux clics) porteraient
   * le même horodatage, et le départage se ferait alors sur un identifiant
   * aléatoire. Le pair d'en face recevrait une expédition portant sur un
   * transfert qu'il ne connaît pas encore, et la rejetterait.
   *
   * Le `rowid` est réattribué par SQLite uniquement après la suppression de la
   * ligne la PLUS HAUTE ; la valeur réutilisée reste donc supérieure à toutes
   * celles qui subsistent, et l'ordre relatif des envois en attente est
   * préservé même après une purge.
   */
  async pending(limit = 100, at: string = nowIso()): Promise<OutboxEntry[]> {
    const rows = await this.db.select<OutboxRow>(
      `SELECT * FROM sync_outbox
       WHERE status IN ('PENDING', 'FAILED')
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY rowid
       LIMIT ?`,
      [at, limit],
    );
    return rows.map(toEntry);
  }

  async countByStatus(): Promise<Record<SyncStatus, number>> {
    const rows = await this.db.select<{ status: SyncStatus; total: number }>(
      'SELECT status, COUNT(*) AS total FROM sync_outbox GROUP BY status',
    );
    const counts = { PENDING: 0, SENDING: 0, SENT: 0, FAILED: 0, CONFLICT: 0 };
    for (const row of rows) counts[row.status] = row.total;
    return counts;
  }

  async markSent(ids: readonly string[]): Promise<void> {
    const at = nowIso();
    for (const batch of chunk(ids)) {
      await this.db.execute(
        `UPDATE sync_outbox SET status = 'SENT', sent_at = ?, last_error = NULL
         WHERE id IN (${placeholders(batch.length)})`,
        [at, ...batch],
      );
    }
  }

  /**
   * Échec d'envoi : on incrémente le compteur et l'on repousse la prochaine
   * tentative selon un recul exponentiel. Une boutique dont la clé 4G est
   * débranchée ne doit pas marteler le réseau, mais elle doit repartir vite dès
   * qu'elle revient.
   */
  async markFailed(id: string, attempts: number, error: string): Promise<void> {
    const nextAttempt = new Date(Date.now() + retryDelayMs(attempts + 1)).toISOString();
    await this.db.execute(
      `UPDATE sync_outbox
       SET status = 'FAILED', attempts = attempts + 1, last_error = ?, next_attempt_at = ?
       WHERE id = ?`,
      [error.slice(0, 500), nextAttempt, id],
    );
  }

  /** Refus définitif du serveur : l'événement demande un arbitrage humain. */
  async markConflict(id: string, reason: string): Promise<void> {
    await this.db.execute(
      `UPDATE sync_outbox SET status = 'CONFLICT', last_error = ?, next_attempt_at = NULL
       WHERE id = ?`,
      [reason.slice(0, 500), id],
    );
  }

  async conflicts(limit = 100): Promise<OutboxEntry[]> {
    const rows = await this.db.select<OutboxRow>(
      `SELECT * FROM sync_outbox WHERE status = 'CONFLICT' ORDER BY created_at DESC LIMIT ?`,
      [limit],
    );
    return rows.map(toEntry);
  }

  /** Purge les envois confirmés antérieurs à une date : la file n'est pas une archive. */
  async purgeSent(before: string): Promise<void> {
    await this.db.execute(`DELETE FROM sync_outbox WHERE status = 'SENT' AND sent_at < ?`, [
      before,
    ]);
  }

  /** Traduit une entrée en événement de transport. */
  static toEvent(entry: OutboxEntry): SyncEvent {
    return {
      id: entry.id,
      type: entry.type as SyncEventType,
      entity: entry.entity,
      entityId: entry.entityId,
      shopId: entry.shopId,
      userId: entry.userId,
      occurredAt: entry.createdAt,
      payload: entry.payload,
    };
  }
}
