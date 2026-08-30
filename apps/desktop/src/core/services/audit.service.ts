import { AuditRepository, diffFields } from '../db/repositories/audit.repository';
import type { AuditAction, AuditInput } from '../db/repositories/audit.repository';
import { actorOf, type AppContext } from './context';
import type { SqlExecutor } from '../db/client';

/**
 * Écriture du journal d'audit.
 *
 * Un service qui journalise appelle TOUJOURS cette classe avec l'exécuteur de
 * sa transaction en cours : l'entrée d'audit doit être écrite ou annulée avec
 * l'opération qu'elle décrit. Un journal qui mentionne une vente qui n'a pas
 * eu lieu est pire que pas de journal du tout.
 */
export class AuditService {
  constructor(private readonly context: AppContext) {}

  async record(
    tx: SqlExecutor,
    input: Omit<AuditInput, 'userId' | 'userLabel' | 'shopId'> &
      Partial<Pick<AuditInput, 'shopId'>>,
  ): Promise<void> {
    const actor = actorOf(this.context);
    await new AuditRepository(tx).write({
      ...input,
      userId: actor.userId,
      userLabel: actor.userLabel,
      shopId: input.shopId ?? this.context.shopId,
    });
  }

  /**
   * Journalise une modification en ne conservant que les champs qui changent.
   * Sans différence, rien n'est écrit : une sauvegarde sans modification ne
   * doit pas polluer le journal.
   */
  async recordChange<T extends Record<string, unknown>>(
    tx: SqlExecutor,
    action: AuditAction,
    entity: string,
    entityId: string,
    before: T,
    after: T,
  ): Promise<void> {
    const changes = diffFields(before, after);
    if (!changes) return;
    await this.record(tx, {
      action,
      entity,
      entityId,
      before: changes.before,
      after: changes.after,
    });
  }
}
