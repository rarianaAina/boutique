import { beforeEach, describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@boutique/shared';
import {
  cleSecoursPlausible,
  formaterCleSecours,
  genererCleSecours,
  normaliserCleSecours,
} from '@/core/auth/cle-secours';
import { AuthService, UserService } from '@/core/services/auth.service';
import { SetupService } from '@/core/services/setup.service';
import { RoleRepository } from '@/core/db/repositories/role.repository';
import { UserRepository } from '@/core/db/repositories/user.repository';
import { POSTE_KEYS, SettingRepository } from '@/core/db/repositories/setting.repository';
import { createTestDb, type TestExecutor } from './helpers/sqlite-executor';
import { contextFor } from './helpers/context';
import { seedFixture, type Fixture } from './helpers/fixtures';

/**
 * Clé de secours de l'administrateur.
 *
 * LE CAS QU'ELLE COUVRE : le dernier administrateur oublie son mot de passe.
 * Personne ne peut plus le débloquer, et ses données vivent dans une base
 * locale qu'aucun serveur ne connaît. Sans cette clé, le commerce est enfermé
 * dehors définitivement.
 *
 * Ces épreuves comptent plus que la moyenne : une clé de secours qui ne
 * fonctionne pas ne se découvre qu'au pire moment, et il n'y a alors plus de
 * seconde chance.
 */

const MOT_DE_PASSE = 'Nouveau-MotDePasse-2026';

describe('forme de la clé', () => {
  it('se lit sans confusion possible', () => {
    // Cette clé se recopie à la main, depuis un carnet, parfois des mois plus
    // tard. Un I lu comme un 1 transformerait un dépannage en perte de données.
    const cle = normaliserCleSecours(genererCleSecours());
    for (const interdit of ['I', 'O', '0', '1', '8', 'B']) {
      expect(cle, `${interdit} est confondable`).not.toContain(interdit);
    }
  });

  it('porte assez de hasard pour n’être jamais devinée', () => {
    const cles = new Set(Array.from({ length: 500 }, () => genererCleSecours()));
    expect(cles.size).toBe(500);
    expect(normaliserCleSecours(genererCleSecours())).toHaveLength(25);
  });

  it('se présente en groupes de cinq', () => {
    expect(formaterCleSecours('ABCDEFGHIJ')).toBe('ABCDE-FGHIJ');
    expect(genererCleSecours()).toMatch(/^[A-Z0-9]{5}(-[A-Z0-9]{5}){4}$/);
  });

  it('accepte une saisie approximative', () => {
    // La personne qui saisit cette clé vient de perdre l'accès à son logiciel :
    // ce n'est pas le moment de lui reprocher une majuscule.
    const cle = genererCleSecours();
    const bruite = ` ${cle.toLowerCase().replace(/-/g, ' ')} `;
    expect(normaliserCleSecours(bruite)).toBe(normaliserCleSecours(cle));
  });

  it('reconnaît ce qui n’a pas la forme d’une clé', () => {
    expect(cleSecoursPlausible(genererCleSecours())).toBe(true);
    expect(cleSecoursPlausible('trop-court')).toBe(false);
    expect(cleSecoursPlausible('IIIII-IIIII-IIIII-IIIII-IIIII')).toBe(false);
  });
});

describe('remise à l’installation', () => {
  let db: TestExecutor;

  beforeEach(() => {
    db = createTestDb();
  });

  const installer = () =>
    new SetupService(db).run({
      shopCode: 'CENT',
      shopName: 'Boutique Centre',
      adminFullName: 'Rakoto Admin',
      adminLogin: 'admin',
      adminPassword: 'MotDePasse-2026',
    });

  it('produit une clé et la rend à l’appelant', async () => {
    const { cleSecours } = await installer();
    expect(cleSecoursPlausible(cleSecours)).toBe(true);
  });

  it('n’en conserve QUE l’empreinte', async () => {
    // Qui lirait la base ne doit pas pouvoir s'en servir pour reprendre le
    // compte administrateur.
    const { cleSecours } = await installer();
    const empreinte = await new SettingRepository(db).raw(POSTE_KEYS.recoveryHash);

    expect(empreinte).not.toBeNull();
    expect(empreinte).not.toContain(normaliserCleSecours(cleSecours));
    expect(empreinte).toMatch(/^pbkdf2/);
  });

  it('la range au POSTE, pas à une boutique', async () => {
    await installer();
    const rattachees = await db.select<{ total: number }>(
      `SELECT COUNT(*) AS total FROM setting WHERE key = ? AND shop_id IS NOT NULL`,
      [POSTE_KEYS.recoveryHash],
    );
    expect(rattachees[0]?.total).toBe(0);
  });
});

describe('déblocage', () => {
  let db: TestExecutor;
  let cleSecours: string;

  beforeEach(async () => {
    db = createTestDb();
    const resultat = await new SetupService(db).run({
      shopCode: 'CENT',
      shopName: 'Boutique Centre',
      adminFullName: 'Rakoto Admin',
      adminLogin: 'admin',
      adminPassword: 'MotDePasse-2026',
    });
    cleSecours = resultat.cleSecours;
  });

  const auth = () => new AuthService(db);

  it('rouvre le compte administrateur, SANS session', async () => {
    // C'est tout son objet : on l'appelle parce que personne ne peut plus se
    // connecter.
    await auth().resetWithRecoveryKey(cleSecours, 'admin', MOT_DE_PASSE);
    const { session } = await auth().login('admin', MOT_DE_PASSE);
    expect(session.login).toBe('admin');
  });

  it('accepte la clé écrite n’importe comment', async () => {
    const bruitee = cleSecours.toLowerCase().replace(/-/g, ' ');
    await expect(auth().resetWithRecoveryKey(bruitee, 'admin', MOT_DE_PASSE)).resolves.toBeTruthy();
  });

  it('refuse une clé fausse, sans dire pourquoi', async () => {
    // Le même message pour une clé mal formée et pour une clé fausse : dire
    // laquelle des deux renseignerait qui essaie au hasard.
    await expect(
      auth().resetWithRecoveryKey(genererCleSecours(), 'admin', MOT_DE_PASSE),
    ).rejects.toThrow(/Clé de secours refusée/);
    await expect(
      auth().resetWithRecoveryKey('n’importe quoi', 'admin', MOT_DE_PASSE),
    ).rejects.toThrow(/Clé de secours refusée/);
  });

  it('laisse l’ancien mot de passe intact quand la clé est refusée', async () => {
    await expect(
      auth().resetWithRecoveryKey(genererCleSecours(), 'admin', MOT_DE_PASSE),
    ).rejects.toThrow();
    await expect(auth().login('admin', 'MotDePasse-2026')).resolves.toBeTruthy();
  });

  it('REMPLACE la clé à chaque usage', async () => {
    // Une clé recopiée sur un carnet, photographiée ou dictée au téléphone ne
    // doit pas rester valable indéfiniment.
    const { nouvelleCle } = await auth().resetWithRecoveryKey(cleSecours, 'admin', MOT_DE_PASSE);
    expect(nouvelleCle).not.toBe(cleSecours);

    await expect(
      auth().resetWithRecoveryKey(cleSecours, 'admin', 'Encore-Un-Autre-2026'),
    ).rejects.toThrow(/refusée/);
    await expect(
      auth().resetWithRecoveryKey(nouvelleCle, 'admin', 'Encore-Un-Autre-2026'),
    ).resolves.toBeTruthy();
  });

  it('refuse un mot de passe trop faible', async () => {
    await expect(auth().resetWithRecoveryKey(cleSecours, 'admin', '1234')).rejects.toThrow();
    // Et la clé n'a PAS été consommée par cet échec.
    await expect(
      auth().resetWithRecoveryKey(cleSecours, 'admin', MOT_DE_PASSE),
    ).resolves.toBeTruthy();
  });

  it('refuse un identifiant inconnu', async () => {
    await expect(auth().resetWithRecoveryKey(cleSecours, 'fantome', MOT_DE_PASSE)).rejects.toThrow(
      /Aucun compte/,
    );
  });

  it('inscrit l’opération au journal, sans auteur', async () => {
    // C'est exactement ce qu'elle est : personne n'était connecté. Le
    // dissimuler serait pire.
    await auth().resetWithRecoveryKey(cleSecours, 'admin', MOT_DE_PASSE);
    const traces = await db.select<{ user_label: string; user_id: string | null }>(
      `SELECT user_label, user_id FROM audit_log WHERE entity = 'app_user' ORDER BY at DESC LIMIT 1`,
    );
    expect(traces[0]?.user_label).toBe('clé de secours');
    expect(traces[0]?.user_id).toBeNull();
  });
});

describe('ce que la clé ne fait PAS', () => {
  let fixture: Fixture;
  let cleSecours: string;

  beforeEach(async () => {
    fixture = await seedFixture();
    const contexte = await contextFor(fixture.db, fixture.adminId);
    cleSecours = await new AuthService(fixture.db).renewRecoveryKey(contexte);
  });

  it('ne débloque pas un compte qui n’est pas administrateur', async () => {
    // Elle sert à récupérer l'administration, pas à changer discrètement le
    // mot de passe d'un caissier — un administrateur sait déjà le faire, et il
    // laisse une trace à son nom.
    await expect(
      new AuthService(fixture.db).resetWithRecoveryKey(cleSecours, 'naina', MOT_DE_PASSE),
    ).rejects.toThrow(/qu’un compte administrateur/);
  });

  it('ne rouvre pas un compte désactivé', async () => {
    const contexte = await contextFor(fixture.db, fixture.adminId);
    const second = await new UserService(contexte).create(
      {
        shopId: fixture.shopA,
        fullName: 'Second Admin',
        login: 'admin2',
        roleId: (await new RoleRepository(fixture.db).byCode('ADMIN'))!.id,
      },
      'MotDePasse-2026',
    );
    await new UserService(contexte).setStatus(second, 'SUSPENDED');

    await expect(
      new AuthService(fixture.db).resetWithRecoveryKey(cleSecours, 'admin2', MOT_DE_PASSE),
    ).rejects.toThrow(/désactivé/);
  });

  it('débloque un rôle non nommé « admin » mais qui administre les comptes', async () => {
    // On compte par la PERMISSION et non par le code du rôle : un gérant à qui
    // l'on a donné la gestion des comptes administre tout autant.
    const roles = new RoleRepository(fixture.db);
    const gerant = await roles.byCode('MANAGER');
    expect(gerant?.permissions.includes(PERMISSIONS.userManage)).toBe(false);

    const contexte = await contextFor(fixture.db, fixture.adminId);
    await new UserService(contexte).update(fixture.sellerId, { roleId: gerant!.id });
    await expect(
      new AuthService(fixture.db).resetWithRecoveryKey(cleSecours, 'naina', MOT_DE_PASSE),
    ).rejects.toThrow(/administrateur/);
  });
});

describe('renouvellement par un administrateur', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it('produit une clé neuve, qui remplace la précédente', async () => {
    const contexte = await contextFor(fixture.db, fixture.adminId);
    const auth = new AuthService(fixture.db);

    const premiere = await auth.renewRecoveryKey(contexte);
    const seconde = await auth.renewRecoveryKey(contexte);
    expect(premiere).not.toBe(seconde);

    await expect(auth.resetWithRecoveryKey(premiere, 'admin', MOT_DE_PASSE)).rejects.toThrow();
    await expect(auth.resetWithRecoveryKey(seconde, 'admin', MOT_DE_PASSE)).resolves.toBeTruthy();
  });

  it('exige le droit d’administrer les comptes', async () => {
    const vendeur = await contextFor(fixture.db, fixture.sellerId, { permissions: [] });
    await expect(new AuthService(fixture.db).renewRecoveryKey(vendeur)).rejects.toThrow();
  });
});

describe('poste installé par une version antérieure', () => {
  it('le dit clairement au lieu de refuser sans expliquer', async () => {
    // Aucune empreinte en base : ces postes existent, et leur propriétaire
    // doit savoir quoi faire plutôt que de croire sa clé fausse.
    const fixture = await seedFixture();
    expect(await new SettingRepository(fixture.db).raw(POSTE_KEYS.recoveryHash)).toBeNull();

    await expect(
      new AuthService(fixture.db).resetWithRecoveryKey(genererCleSecours(), 'admin', MOT_DE_PASSE),
    ).rejects.toThrow(/version antérieure/);
  });
});

describe('un compte administrateur reste joignable', () => {
  it('empêche un administrateur de se désactiver lui-même', async () => {
    // Le garde existait déjà, et il compte double maintenant : c'est la
    // première ligne de défense avant la clé de secours.
    const fixture = await seedFixture();
    const contexte = await contextFor(fixture.db, fixture.adminId);
    await expect(new UserService(contexte).setStatus(fixture.adminId, 'SUSPENDED')).rejects.toThrow(
      /votre propre compte/,
    );
  });
});

/** Le dépôt des utilisateurs, pour les épreuves qui vérifient l'état final. */
export const _utilise = UserRepository;
