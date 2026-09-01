import { nowIso } from '@boutique/shared';
import type { SessionUser } from '@boutique/shared';
import { META_KEYS, MetaRepository } from '../db/repositories/meta.repository';
import { UserRepository } from '../db/repositories/user.repository';
import type { SqlExecutor } from '../db/client';

/**
 * Garder la session d'un lancement à l'autre.
 *
 * POURQUOI. Une boutique ouvre et ferme le logiciel plusieurs fois par jour —
 * on éteint le poste à midi, on le rallume, Windows redémarre pour une mise à
 * jour. Ressaisir un mot de passe à chaque fois devant un client qui attend
 * est une friction qui finit par se régler d'une mauvaise façon : un mot de
 * passe court, ou noté sur l'écran.
 *
 * POURQUOI PAS INDÉFINIMENT. Le poste est partagé. Une session éternelle
 * signifie que la première personne qui ouvre l'application le lendemain agit
 * sous l'identité de la dernière : ses ventes, ses remises et ses annulations
 * porteraient un nom qui n'est pas le sien, et le journal d'audit — qui ne
 * sert qu'à cela — deviendrait faux. La durée se règle donc, et la boutique
 * décide de son propre compromis.
 *
 * CE QUI EST GARDÉ : un identifiant d'utilisateur, deux dates, et l'empreinte
 * du compte à l'instant de la connexion. JAMAIS le mot de passe, ni son
 * empreinte : ce fichier n'a pas de quoi rejouer une authentification, il n'a
 * de quoi que reconnaître une session que le poste a lui-même ouverte.
 */

interface SessionEnregistree {
  userId: string;
  ouverteLe: string;
  expireLe: string;
  /**
   * État du compte au moment de la connexion.
   *
   * `app_user.updated_at` bouge dès que le compte change — mot de passe
   * modifié, compte suspendu ou archivé, tentative d'entrée manquée. Une
   * session gardée cesse alors de valoir, ce qui est exactement ce qu'on veut :
   * changer un mot de passe doit fermer les sessions ouvertes, sinon
   * l'opération ne protège de rien.
   */
  empreinte: string;
}

export class SessionGardee {
  private readonly meta: MetaRepository;

  constructor(private readonly db: SqlExecutor) {
    this.meta = new MetaRepository(db);
  }

  /**
   * Retient la session pour `jours` jours.
   *
   * `jours` à zéro n'enregistre rien et efface ce qui l'était : c'est le
   * réglage « redemander à chaque ouverture », et il doit prendre effet tout
   * de suite, pas au prochain redémarrage.
   */
  async retenir(session: SessionUser, jours: number): Promise<void> {
    if (jours <= 0) {
      await this.oublier();
      return;
    }

    const utilisateur = await new UserRepository(this.db).byId(session.id);
    const enregistree: SessionEnregistree = {
      userId: session.id,
      ouverteLe: nowIso(),
      expireLe: new Date(Date.now() + jours * 86_400_000).toISOString(),
      empreinte: utilisateur?.updatedAt ?? '',
    };
    await this.meta.set(META_KEYS.session, JSON.stringify(enregistree));
  }

  /**
   * Reprend la session gardée, si elle vaut encore.
   *
   * Rend `null` dans TOUS les cas douteux — rien d'enregistré, contenu
   * illisible, échéance passée, compte disparu, suspendu, ou modifié depuis.
   * Le doute conduit à l'écran de connexion, qui n'est jamais qu'une gêne ;
   * l'inverse ouvrirait une caisse à qui ne devrait pas y accéder.
   */
  async reprendre(): Promise<SessionUser | null> {
    const brut = await this.meta.get(META_KEYS.session);
    if (!brut) return null;

    let gardee: SessionEnregistree;
    try {
      gardee = JSON.parse(brut) as SessionEnregistree;
    } catch {
      await this.oublier();
      return null;
    }

    if (!gardee?.userId || !gardee.expireLe || gardee.expireLe <= nowIso()) {
      await this.oublier();
      return null;
    }

    const users = new UserRepository(this.db);
    const utilisateur = await users.byId(gardee.userId);
    if (!utilisateur || utilisateur.status !== 'ACTIVE' || utilisateur.deletedAt !== null) {
      await this.oublier();
      return null;
    }
    if (utilisateur.updatedAt !== gardee.empreinte) {
      // Le compte a changé depuis : mot de passe modifié, droits revus,
      // tentative d'entrée manquée. On repasse par la connexion.
      await this.oublier();
      return null;
    }

    return users.sessionFor(gardee.userId);
  }

  async oublier(): Promise<void> {
    await this.meta.remove(META_KEYS.session);
  }
}
