import { DEFAULT_NUMBERING, counterPeriod, formatDocumentNumber } from '@boutique/shared';
import type { NumberingRule } from '@boutique/shared';
import type { SqlExecutor } from '../client';

/**
 * Attribution des numéros de documents.
 *
 * L'incrément et la lecture se font en UNE seule instruction, grâce à
 * `RETURNING` : deux fenêtres ouvertes sur la même base ne peuvent donc pas
 * obtenir le même numéro. Sans cela, un `SELECT` suivi d'un `UPDATE` laisserait
 * une fenêtre entre les deux — étroite, mais un ticket en double est un
 * incident comptable, pas un désagrément.
 *
 * IMPORTANT : le numéro est réservé AVANT l'écriture du document, et hors de sa
 * transaction. Si l'enregistrement échoue ensuite, le numéro est perdu et la
 * série présente un trou. C'est assumé : une série trouée se justifie devant un
 * contrôle, deux documents portant le même numéro, non.
 */
export class CounterRepository {
  constructor(private readonly db: SqlExecutor) {}

  /** Rang suivant pour une portée, réservé de façon atomique. */
  async nextSequence(scope: string, shopId: string, period: string): Promise<number> {
    const rows = await this.db.select<{ next_value: number }>(
      `INSERT INTO document_counter (scope, shop_id, period, next_value)
       VALUES (?, ?, ?, 2)
       ON CONFLICT (scope, shop_id, period)
       DO UPDATE SET next_value = next_value + 1
       RETURNING next_value`,
      [scope, shopId, period],
    );
    const nextValue = rows[0]?.next_value;
    if (nextValue === undefined) {
      throw new Error(`Compteur « ${scope} » indisponible pour la boutique ${shopId}.`);
    }
    // `next_value` est la valeur APRÈS incrément : le rang attribué est le
    // précédent. À la première insertion, on écrit 2 et l'on attribue 1.
    return nextValue - 1;
  }

  /** Numéro complet, mis en forme selon la règle de la portée. */
  async nextNumber(
    scope: keyof typeof DEFAULT_NUMBERING | string,
    shopId: string,
    shopCode: string,
    rule?: NumberingRule,
    at: Date = new Date(),
  ): Promise<string> {
    const effective = rule ?? DEFAULT_NUMBERING[scope];
    if (!effective) throw new Error(`Aucune règle de numérotation pour « ${scope} ».`);
    const period = counterPeriod(effective, at);
    const sequence = await this.nextSequence(scope, shopId, period);
    return formatDocumentNumber(effective, { shopCode, sequence, at });
  }

  /** Dernier rang attribué, pour l'écran des paramètres. */
  async peek(scope: string, shopId: string, period: string): Promise<number> {
    const rows = await this.db.select<{ next_value: number }>(
      'SELECT next_value FROM document_counter WHERE scope = ? AND shop_id = ? AND period = ?',
      [scope, shopId, period],
    );
    return (rows[0]?.next_value ?? 1) - 1;
  }
}
