import { beforeEach, describe, expect, it } from 'vitest';
import { SessionGardee } from '@/core/services/session-gardee';
import { UserRepository } from '@/core/db/repositories/user.repository';
import { META_KEYS, MetaRepository } from '@/core/db/repositories/meta.repository';
import { hashPassword } from '@/core/auth/password';
import { seedFixture, type Fixture } from './helpers/fixtures';

/**
 * La session gardée d'un lancement à l'autre.
 *
 * C'EST UNE PORTE D'ENTRÉE, et les épreuves portent d'abord sur ce qu'elle
 * REFUSE. Une session reprise à tort ouvre une caisse à qui ne devrait pas y
 * accéder, et attribue au propriétaire du compte des ventes qu'il n'a pas
 * faites — le journal d'audit, qui ne sert qu'à cela, deviendrait faux.
 */
describe('session gardée', () => {
  let fixture: Fixture;
  let gardee: SessionGardee;

  beforeEach(async () => {
    fixture = await seedFixture();
    gardee = new SessionGardee(fixture.db);
  });

  const session = async () => {
    const trouvee = await new UserRepository(fixture.db).sessionFor(fixture.adminId);
    if (!trouvee) throw new Error('session introuvable');
    return trouvee;
  };

  it('reprend une session encore valable', async () => {
    await gardee.retenir(await session(), 7);

    const reprise = await gardee.reprendre();
    expect(reprise?.id).toBe(fixture.adminId);
  });

  it('ne reprend rien quand rien n’a été gardé', async () => {
    expect(await gardee.reprendre()).toBeNull();
  });

  it('n’enregistre rien quand la durée est nulle', async () => {
    await gardee.retenir(await session(), 0);
    expect(await new MetaRepository(fixture.db).get(META_KEYS.session)).toBeNull();
    expect(await gardee.reprendre()).toBeNull();
  });

  it('efface une session déjà gardée quand la durée passe à zéro', async () => {
    // Le réglage « redemander à chaque ouverture » doit prendre effet tout de
    // suite, pas au prochain redémarrage.
    await gardee.retenir(await session(), 7);
    await gardee.retenir(await session(), 0);
    expect(await gardee.reprendre()).toBeNull();
  });

  it('refuse une session échue', async () => {
    const utilisateur = await new UserRepository(fixture.db).byId(fixture.adminId);
    await new MetaRepository(fixture.db).set(
      META_KEYS.session,
      JSON.stringify({
        userId: fixture.adminId,
        ouverteLe: '2026-01-01T00:00:00.000Z',
        expireLe: '2026-01-08T00:00:00.000Z',
        empreinte: utilisateur?.updatedAt ?? '',
      }),
    );
    expect(await gardee.reprendre()).toBeNull();
    // Et elle est effacée : une session échue n'a pas à rester en base.
    expect(await new MetaRepository(fixture.db).get(META_KEYS.session)).toBeNull();
  });

  it('refuse une session dont le contenu est illisible', async () => {
    await new MetaRepository(fixture.db).set(META_KEYS.session, 'ceci n’est pas du JSON');
    expect(await gardee.reprendre()).toBeNull();
  });

  it('refuse après un changement de mot de passe', async () => {
    // C'est le point le plus important : changer un mot de passe doit fermer
    // les sessions ouvertes, sinon l'opération ne protège de rien.
    await gardee.retenir(await session(), 7);
    await new UserRepository(fixture.db).setPassword(
      fixture.adminId,
      await hashPassword('UnAutreMotDePasse!2026'),
    );
    expect(await gardee.reprendre()).toBeNull();
  });

  it('refuse un compte suspendu', async () => {
    await gardee.retenir(await session(), 7);
    await fixture.db.execute('UPDATE app_user SET status = ? WHERE id = ?', [
      'SUSPENDED',
      fixture.adminId,
    ]);
    expect(await gardee.reprendre()).toBeNull();
  });

  it('refuse un compte supprimé', async () => {
    await gardee.retenir(await session(), 7);
    await new UserRepository(fixture.db).softDelete(fixture.adminId);
    expect(await gardee.reprendre()).toBeNull();
  });

  it('ne garde jamais le mot de passe, ni son empreinte', async () => {
    await gardee.retenir(await session(), 7);
    const brut = (await new MetaRepository(fixture.db).get(META_KEYS.session)) ?? '';

    expect(brut).not.toMatch(/pbkdf2/);
    expect(brut).not.toMatch(/password/i);
    // Ce qui est gardé se limite à un identifiant, deux dates et une empreinte
    // d'état du compte.
    expect(Object.keys(JSON.parse(brut) as object).sort()).toEqual([
      'empreinte',
      'expireLe',
      'ouverteLe',
      'userId',
    ]);
  });

  it('s’efface à la déconnexion', async () => {
    await gardee.retenir(await session(), 7);
    await gardee.oublier();
    expect(await gardee.reprendre()).toBeNull();
  });

  it('ne voyage pas avec l’archive de portabilité', async () => {
    // `app_meta` est exclu de l'export : une session emportée sur une autre
    // machine y ouvrirait une caisse sans mot de passe.
    const { TABLES_EXPORTEES } = await import('@/core/services/portabilite.service');
    expect(TABLES_EXPORTEES as readonly string[]).not.toContain('app_meta');
  });
});

describe('réduction du logo', () => {
  it('garde les proportions et n’agrandit jamais', async () => {
    const { dimensionsReduites } = await import('@/features/gestion/telechargement');

    // Une image large est ramenée à la borne, sa hauteur suit.
    expect(dimensionsReduites(3000, 1000, 900)).toEqual({ largeur: 900, hauteur: 300 });
    // Une image haute, de même, par sa hauteur.
    expect(dimensionsReduites(1000, 3000, 900)).toEqual({ largeur: 300, hauteur: 900 });
    // Déjà petite : on n'agrandit pas. L'agrandir ne lui rendrait aucune
    // définition et ne ferait que peser davantage.
    expect(dimensionsReduites(200, 80, 900)).toEqual({ largeur: 200, hauteur: 80 });
  });

  it('ne rend jamais une dimension nulle', async () => {
    const { dimensionsReduites } = await import('@/features/gestion/telechargement');
    expect(dimensionsReduites(4000, 3, 900)).toEqual({ largeur: 900, hauteur: 1 });
  });
});
