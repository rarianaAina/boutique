import { PERMISSIONS, PUSH_OUTCOME, SyncTransportError, nowIso } from '@boutique/shared';
import type { SyncStatus } from '@boutique/shared';
import { OutboxRepository } from '../db/repositories/outbox.repository';
import { META_KEYS, MetaRepository } from '../db/repositories/meta.repository';
import { AUDIT_ACTIONS, AuditRepository } from '../db/repositories/audit.repository';
import { SyncApplier, type ApplyReport } from './applier';
import type { SyncTransport } from './transport';
import { assertCan, type AppContext } from '../services/context';

/**
 * Moteur de synchronisation.
 *
 * DÉCLENCHEMENT EXPLICITE (§18) : rien ne part tout seul. Une boutique décide
 * quand elle synchronise — avant d'expédier un colis, en fin de journée, ou
 * parce qu'elle attend un transfert. Un envoi automatique consommerait un
 * forfait mobile sans qu'on le lui demande, et surtout donnerait l'illusion que
 * les données sont à jour alors que la connexion est peut-être morte depuis
 * trois jours.
 *
 * DÉROULÉ : on POUSSE d'abord, on TIRE ensuite. Cet ordre compte : une boutique
 * qui vient d'expédier un colis doit que le serveur le sache avant de lui
 * demander des nouvelles, sinon la réponse ne contiendra pas l'accusé qu'elle
 * attend au tour suivant.
 */

export interface SyncOutcome {
  pushed: number;
  duplicates: number;
  rejected: number;
  pulled: number;
  applied: ApplyReport;
  cursor: number;
  finishedAt: string;
  /** Renseigné quand la synchronisation s'est arrêtée sur une panne réseau. */
  transportError: string | null;
}

export interface SyncSnapshot {
  lastSyncAt: string | null;
  cursor: number;
  pending: Record<SyncStatus, number>;
  conflicts: number;
  serverConfigured: boolean;
}

const PUSH_BATCH = 200;
const PULL_BATCH = 200;

export class SyncEngine {
  private readonly outbox: OutboxRepository;
  private readonly meta: MetaRepository;

  constructor(
    private readonly context: AppContext,
    private readonly transport: SyncTransport,
    private readonly deviceId: string,
  ) {
    this.outbox = new OutboxRepository(context.db);
    this.meta = new MetaRepository(context.db);
  }

  /** État affiché dans l'écran de synchronisation, sans toucher au réseau. */
  async snapshot(): Promise<SyncSnapshot> {
    const [lastSyncAt, cursor, pending, conflicts] = await Promise.all([
      this.meta.get(META_KEYS.lastSyncAt),
      this.meta.getNumber(META_KEYS.syncCursor, 0),
      this.outbox.countByStatus(),
      this.outbox.conflicts(500),
    ]);
    return {
      lastSyncAt,
      cursor,
      pending,
      conflicts: conflicts.length,
      serverConfigured: this.context.settings.syncServerUrl.trim() !== '',
    };
  }

  async run(): Promise<SyncOutcome> {
    assertCan(this.context, PERMISSIONS.syncRun);

    const outcome: SyncOutcome = {
      pushed: 0,
      duplicates: 0,
      rejected: 0,
      pulled: 0,
      applied: { applied: 0, skipped: 0, ignored: 0, failed: 0, errors: [] },
      cursor: await this.meta.getNumber(META_KEYS.syncCursor, 0),
      finishedAt: nowIso(),
      transportError: null,
    };

    try {
      await this.pushPending(outcome);
      await this.pullAndApply(outcome);
      await this.meta.set(META_KEYS.lastSyncAt, nowIso());
    } catch (cause) {
      if (!(cause instanceof SyncTransportError)) throw cause;
      // Une panne réseau n'est PAS une erreur du logiciel : ce qui n'est pas
      // parti reste en attente, et repartira au prochain essai. On le dit à
      // l'utilisateur sans transformer la boutique en écran d'erreur.
      outcome.transportError = cause.message;
    }

    outcome.cursor = await this.meta.getNumber(META_KEYS.syncCursor, 0);
    outcome.finishedAt = nowIso();

    await new AuditRepository(this.context.db).write({
      action: AUDIT_ACTIONS.sync,
      entity: 'sync',
      userId: this.context.session?.id ?? null,
      userLabel: this.context.session?.fullName ?? null,
      shopId: this.context.shopId,
      after: {
        envoyes: outcome.pushed,
        doublons: outcome.duplicates,
        refuses: outcome.rejected,
        recus: outcome.pulled,
        appliques: outcome.applied.applied,
        erreur: outcome.transportError,
      },
    });

    return outcome;
  }

  private async pushPending(outcome: SyncOutcome): Promise<void> {
    for (;;) {
      const batch = await this.outbox.pending(PUSH_BATCH);
      if (batch.length === 0) return;

      const response = await this.transport.push({
        shopId: this.context.shopId,
        deviceId: this.deviceId,
        events: batch.map((entry) => OutboxRepository.toEvent(entry)),
      });

      const sent: string[] = [];
      const attemptsById = new Map(batch.map((entry) => [entry.id, entry.attempts]));

      for (const result of response.results) {
        if (result.outcome === PUSH_OUTCOME.applied) {
          sent.push(result.eventId);
          outcome.pushed += 1;
        } else if (result.outcome === PUSH_OUTCOME.duplicate) {
          // Déjà connu du serveur : l'envoi précédent avait abouti, seule la
          // réponse s'était perdue. C'est le cas nominal d'une reprise.
          sent.push(result.eventId);
          outcome.duplicates += 1;
        } else {
          outcome.rejected += 1;
          await this.outbox.markConflict(
            result.eventId,
            result.reason ?? 'Refusé par le serveur, sans motif.',
          );
        }
      }

      if (sent.length > 0) await this.outbox.markSent(sent);

      // Aucun événement n'a avancé : insister ferait une boucle infinie.
      if (sent.length === 0 && outcome.rejected === 0) {
        for (const entry of batch) {
          await this.outbox.markFailed(
            entry.id,
            attemptsById.get(entry.id) ?? 0,
            "Le serveur n'a rendu aucun verdict pour cet événement.",
          );
        }
        return;
      }
      if (batch.length < PUSH_BATCH) return;
    }
  }

  private async pullAndApply(outcome: SyncOutcome): Promise<void> {
    const applier = new SyncApplier(this.context.db, this.context.shopId);

    for (;;) {
      const since = await this.meta.getNumber(META_KEYS.syncCursor, 0);
      const response = await this.transport.pull({
        shopId: this.context.shopId,
        deviceId: this.deviceId,
        since,
        limit: PULL_BATCH,
      });

      /*
       * Un lot VIDE ne veut plus dire « plus rien à lire ».
       *
       * Le serveur filtre ce qu'il envoie : une boutique peut n'avoir rien à
       * recevoir alors que le journal a grossi de cent événements qui ne la
       * concernent pas. Le curseur doit tout de même avancer, sinon on
       * réexaminerait cette portion à chaque synchronisation, indéfiniment.
       */
      if (response.events.length === 0) {
        const jusqua = response.nextSince ?? since;
        if (jusqua > since) await this.meta.set(META_KEYS.syncCursor, String(jusqua));
        if (response.hasMore) continue;
        return;
      }
      outcome.pulled += response.events.length;

      const report = await applier.applyAll(response.events);
      outcome.applied.applied += report.applied;
      outcome.applied.skipped += report.skipped;
      outcome.applied.ignored += report.ignored;
      outcome.applied.failed += report.failed;
      outcome.applied.errors.push(...report.errors);

      // Le curseur avance même si des événements ont échoué : ils sont
      // consignés dans `sync_inbox` avec leur motif et peuvent être rejoués
      // depuis l'écran de synchronisation. Bloquer le curseur sur un événement
      // fautif figerait tout le reste de la file, indéfiniment.
      // On avance jusqu'où le serveur a REGARDÉ, et non jusqu'au dernier
      // événement reçu : entre les deux se trouvent ceux qu'il a écartés.
      const lastSeq = response.nextSince ?? response.events.at(-1)?.seq ?? since;
      await this.meta.set(META_KEYS.syncCursor, String(Math.max(lastSeq, since)));

      if (!response.hasMore) return;
    }
  }

  /**
   * Réessaie les événements refusés, après correction.
   *
   * Un conflit n'est jamais résolu automatiquement : c'est un désaccord entre
   * deux boutiques sur un appareil physique, et seule une personne peut savoir
   * lequel des deux a raison.
   */
  async retryConflicts(): Promise<number> {
    assertCan(this.context, PERMISSIONS.syncRun);
    const conflicts = await this.outbox.conflicts(500);
    for (const entry of conflicts) {
      await this.context.db.execute(
        `UPDATE sync_outbox SET status = 'PENDING', attempts = 0, next_attempt_at = ? WHERE id = ?`,
        [nowIso(), entry.id],
      );
    }
    return conflicts.length;
  }

  /** Événements reçus qui n'ont pas pu être appliqués : à montrer à l'écran. */
  async inboxFailures(
    limit = 100,
  ): Promise<
    { eventId: string; type: string; shopId: string; error: string | null; seq: number }[]
  > {
    const rows = await this.context.db.select<{
      event_id: string;
      type: string;
      shop_id: string;
      error: string | null;
      seq: number;
    }>(
      `SELECT event_id, type, shop_id, error, seq FROM sync_inbox
       WHERE status = 'FAILED' ORDER BY seq DESC LIMIT ?`,
      [limit],
    );
    return rows.map((row) => ({
      eventId: row.event_id,
      type: row.type,
      shopId: row.shop_id,
      error: row.error,
      seq: row.seq,
    }));
  }
}
