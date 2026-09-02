import { beforeEach, describe, expect, it } from 'vitest';
import {
  BOUTIQUE,
  CAISSE,
  LICENCE_PUBLIC_KEY,
  emitLicence,
  fonctionsDe,
  installationCode,
  licenceAllows,
  licenceBlocks,
  verifyLicence,
  type Fonction,
  type Produit,
} from '@boutique/shared';
import { NAVIGATION } from '@/app/routes';
import { ShopService } from '@/core/services/shop.service';
import { UserService } from '@/core/services/auth.service';
import { RoleRepository } from '@/core/db/repositories/role.repository';
import { LicenceService } from '@/core/licence/licence.service';
import { POSTE, POSTE_KEYS, SettingRepository } from '@/core/db/repositories/setting.repository';
import { contextFor } from './helpers/context';
import { seedFixture, type Fixture } from './helpers/fixtures';

/**
 * Activation du poste (§35).
 *
 * Les règles des licences sont éprouvées CHEZ ELLES, dans le dépôt
 * `@licence/noyau` : le format, l'émission, le trousseau et le cliquet
 * d'horloge y ont leurs propres épreuves. Les recopier ici donnerait deux
 * endroits à corriger, dont un qu'on oublierait.
 *
 * Ce qui se vérifie ICI est ce que l'autre dépôt ne peut pas savoir : que la
 * boutique conserve son identifiant d'installation, qu'elle refuse la clé d'un
 * autre logiciel, et que chaque écran vendable est rattaché à un module.
 */

/** Paire de clés jetable : la vraie privée n'est dans aucun dépôt. */
async function editeurDeTest(): Promise<{ privee: CryptoKey; publique: string }> {
  const paire = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', paire.publicKey));
  let binaire = '';
  for (const octet of spki) binaire += String.fromCharCode(octet);
  return { privee: paire.privateKey, publique: btoa(binaire) };
}

describe('identifiant d’installation', () => {
  let fixture: Fixture;
  let licences: LicenceService;

  beforeEach(async () => {
    fixture = await seedFixture();
    licences = new LicenceService(fixture.db);
  });

  it('se tire au premier appel et ne change plus jamais', async () => {
    // Chaque clé émise porte le code qui en dérive : le régénérer invaliderait
    // la licence d'un client parfaitement en règle.
    const premier = await licences.installation();
    expect(premier).not.toBe('');
    expect(await licences.installation()).toBe(premier);
    expect(await new LicenceService(fixture.db).installation()).toBe(premier);
  });

  it('donne un code dictable au téléphone', async () => {
    const code = installationCode(await licences.installation());
    expect(code).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  });

  it('appartient au POSTE et non à une boutique', async () => {
    // Une boutique se supprime, se renomme, cède sa place quand le commerce
    // déménage ; le poste reste le poste.
    await licences.installation();
    const brut = await new SettingRepository(fixture.db).raw(POSTE_KEYS.installation);
    expect(brut).not.toBeNull();

    const rattaches = await fixture.db.select<{ total: number }>(
      `SELECT COUNT(*) AS total FROM setting WHERE key = ? AND shop_id <> ?`,
      [POSTE_KEYS.installation, POSTE],
    );
    expect(rattaches[0]?.total).toBe(0);
  });
});

describe('état du poste', () => {
  let fixture: Fixture;
  let licences: LicenceService;

  beforeEach(async () => {
    fixture = await seedFixture();
    licences = new LicenceService(fixture.db);
  });

  it('ouvre tout pendant la période d’essai', async () => {
    const aujourdhui = new Date().toISOString();
    const statut = await licences.status(aujourdhui);
    expect(statut.state).toBe('valide');
    expect(statut.payload?.f).toEqual(fonctionsDe(BOUTIQUE));
    expect(licenceBlocks(statut)).toBe(false);
  });

  it('bloque un essai terminé', async () => {
    const vieux = new Date(Date.now() - (BOUTIQUE.essaiJours + 5) * 86_400_000).toISOString();
    const statut = await licences.status(vieux);
    expect(statut.state).toBe('expiree');
    expect(licenceBlocks(statut)).toBe(true);
  });

  it('ne prétend rien tant que le poste n’est pas installé', async () => {
    const statut = await licences.status(null);
    expect(statut.state).toBe('absente');
    expect(statut.payload).toBeNull();
  });
});

describe('activation', () => {
  let fixture: Fixture;
  let licences: LicenceService;

  beforeEach(async () => {
    fixture = await seedFixture();
    licences = new LicenceService(fixture.db);
  });

  const emettre = async (
    privee: CryptoKey,
    installation: string,
    formule = 'standard',
    // Typé large : ces épreuves émettent aussi des clés de CAISSE, pour
    // vérifier qu'elles n'ouvrent pas la boutique.
    produit: Produit = BOUTIQUE,
  ) => {
    const emission = await emitLicence(
      produit,
      { code: installationCode(installation), nom: 'ARINA', formule, mois: 12 },
      privee,
      new Date(),
    );
    return emission.cle;
  };

  it('refuse une clé illisible sans la conserver', async () => {
    const statut = await licences.activate('n’importe quoi');
    expect(statut.state).toBe('invalide');
    // Garder une clé refusée ferait afficher son motif à chaque démarrage,
    // sans que personne puisse s'en défaire.
    expect(await new SettingRepository(fixture.db).raw(POSTE_KEYS.licenceKey)).toBeNull();
  });

  it('accepte et conserve une clé authentique', async () => {
    const { privee, publique } = await editeurDeTest();
    const service = new LicenceService(fixture.db, publique);
    const cle = await emettre(privee, await service.installation());

    const statut = await service.activate(cle);
    expect(statut.state).toBe('valide');
    expect(await new SettingRepository(fixture.db).raw(POSTE_KEYS.licenceKey)).toBe(cle);
  });

  it('refuse une clé émise pour un autre logiciel de l’éditeur', async () => {
    // C'est LE point que la version 2 du format vient corriger : sans champ
    // produit, une clé de caisse aurait ouvert la boutique.
    const { privee, publique } = await editeurDeTest();
    const service = new LicenceService(fixture.db, publique);
    const cleCaisse = await emettre(privee, await service.installation(), 'quincaillerie', CAISSE);

    const statut = await service.activate(cleCaisse);
    expect(statut.state).toBe('autre-produit');
    expect(statut.reason).toContain(BOUTIQUE.nom);
    expect(await new SettingRepository(fixture.db).raw(POSTE_KEYS.licenceKey)).toBeNull();
  });

  it('refuse une clé émise pour une autre installation', async () => {
    const { privee, publique } = await editeurDeTest();
    const service = new LicenceService(fixture.db, publique);
    const emission = await emitLicence(
      BOUTIQUE,
      { code: 'A1B2-C3D4-E5F6', nom: 'AUTRE', formule: 'standard', mois: 12 },
      privee,
      new Date(),
    );

    const statut = await service.activate(emission.cle);
    expect(statut.state).toBe('autre-entreprise');
    expect(await new SettingRepository(fixture.db).raw(POSTE_KEYS.licenceKey)).toBeNull();
  });

  it('conserve une clé ÉCHUE, contrairement à une clé refusée', async () => {
    // C'est une vraie licence : son échéance doit rester lisible pour la
    // renouveler, et le poste doit dire pourquoi il se ferme.
    const { privee, publique } = await editeurDeTest();
    const service = new LicenceService(fixture.db, publique);
    const vieille = new Date(Date.now() - 400 * 86_400_000);
    const emission = await emitLicence(
      BOUTIQUE,
      {
        code: installationCode(await service.installation()),
        nom: 'ARINA',
        formule: 'standard',
        mois: 1,
      },
      privee,
      vieille,
    );

    const statut = await service.activate(emission.cle);
    expect(statut.state).toBe('expiree');
    expect(await new SettingRepository(fixture.db).raw(POSTE_KEYS.licenceKey)).toBe(emission.cle);
  });

  it('refuse une clé qui n’est pas signée par l’éditeur', async () => {
    // Le service emploie la VRAIE clé publique ; un faussaire signe avec la
    // sienne, et la vérification tombe. C'est l'épreuve qui protège le
    // dispositif entier.
    const faussaire = await editeurDeTest();
    const cle = await emettre(faussaire.privee, await licences.installation());
    const statut = await licences.activate(cle);
    expect(statut.state).toBe('invalide');
    expect(await new SettingRepository(fixture.db).raw(POSTE_KEYS.licenceKey)).toBeNull();
  });

  it('efface la clé enregistrée sur demande', async () => {
    await licences.clear();
    expect(await new SettingRepository(fixture.db).raw(POSTE_KEYS.licenceKey)).toBe('');
  });
});

describe('ce qu’une licence ouvre', () => {
  it('n’ouvre que les modules de la formule vendue', async () => {
    const { privee, publique } = await editeurDeTest();
    const emission = await emitLicence(
      BOUTIQUE,
      { code: installationCode('poste-1'), nom: 'ARINA', formule: 'solo', mois: 12 },
      privee,
      new Date(),
    );
    const statut = await verifyLicence(emission.cle, {
      publicKeySpki: publique,
      produit: BOUTIQUE,
      companyId: 'poste-1',
    });

    expect(statut.state).toBe('valide');
    expect(licenceAllows(statut, 'vente')).toBe(true);
    expect(licenceAllows(statut, 'clients')).toBe(true);
    // La formule « solo » ne comprend ni les achats ni le réseau.
    expect(licenceAllows(statut, 'achats')).toBe(false);
    expect(licenceAllows(statut, 'multiboutique')).toBe(false);
    expect(licenceAllows(statut, 'synchronisation')).toBe(false);
  });

  it('inclut toujours la vente, quelle que soit la formule', async () => {
    // Un logiciel vendu fermé n'est pas une offre, c'est une réclamation.
    const { privee, publique } = await editeurDeTest();
    for (const formule of Object.keys(BOUTIQUE.formules)) {
      const emission = await emitLicence(
        BOUTIQUE,
        { code: installationCode('poste-1'), nom: 'ARINA', formule, mois: 12 },
        privee,
        new Date(),
      );
      const statut = await verifyLicence(emission.cle, {
        publicKeySpki: publique,
        produit: BOUTIQUE,
        companyId: 'poste-1',
      });
      expect(licenceAllows(statut, 'vente'), formule).toBe(true);
    }
  });
});

describe('écrans et modules vendus', () => {
  const ecrans = NAVIGATION.flatMap((groupe) => groupe.ecrans);

  it('ne rattache aucun écran à un module qui n’existe pas', () => {
    // Une faute de frappe ici fermerait un écran que le client a payé, sans
    // que rien ne le signale.
    const connues = fonctionsDe(BOUTIQUE);
    for (const ecran of ecrans) {
      if (!ecran.fonction) continue;
      expect(connues, ecran.cle).toContain(ecran.fonction);
    }
  });

  it('laisse le comptoir et le stock hors de toute option', () => {
    // Ce sont le noyau : les fermer reviendrait à vendre un logiciel qui ne
    // fait rien.
    for (const cle of ['tableau', 'caisse', 'tickets', 'factures', 'produits', 'appareils']) {
      expect(ecrans.find((ecran) => ecran.cle === cle)?.fonction, cle).toBeUndefined();
    }
  });

  it('rattache chaque module vendable à au moins un écran', () => {
    // Une fonction qu'aucun écran n'ouvre est une porte promise au client et
    // introuvable dans le logiciel.
    const rattachees = new Set(ecrans.map((ecran) => ecran.fonction).filter(Boolean));
    for (const fonction of BOUTIQUE.fonctions as readonly Fonction[]) {
      if (fonction.noyau) continue;
      expect(rattachees, fonction.cle).toContain(fonction.cle);
    }
  });

  it('rattache les paramètres et les rôles au noyau', () => {
    // Sinon un poste dont la licence se restreint ne pourrait plus être
    // administré — ni saisir sa nouvelle clé.
    for (const cle of ['parametres', 'utilisateurs']) {
      expect(ecrans.find((ecran) => ecran.cle === cle)?.fonction, cle).toBeUndefined();
    }
  });

  it('embarque la vraie clé publique de l’éditeur', () => {
    expect(LICENCE_PUBLIC_KEY).toMatch(/^MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE/);
  });
});

/* ─── Plafonds de la licence ───────────────────────────────────────────── */

describe('plafonds', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  /** Contexte muni d'une licence qui accorde ces plafonds. */
  const avecPlafonds = async (quotas: Record<string, number>) => {
    const base = await contextFor(fixture.db, fixture.adminId);
    return {
      ...base,
      licence: {
        state: 'valide' as const,
        daysLeft: 300,
        graceLeft: null,
        payload: {
          v: 2,
          p: 'boutique',
          c: '',
          n: 'ARINA',
          s: 'standard',
          f: fonctionsDe(BOUTIQUE),
          q: quotas,
          i: '2026-01-01',
          e: '2027-01-01',
        },
      },
    };
  };

  it('refuse une boutique de plus quand le plafond est atteint', async () => {
    // Le jeu de départ en compte déjà deux.
    const contexte = await avecPlafonds({ boutiques: 2 });
    await expect(
      new ShopService(contexte).create({ code: 'TMV', name: 'Tamatave' }),
    ).rejects.toThrow(/autorise 2 boutique/);
  });

  it('accepte tant que le plafond n’est pas atteint', async () => {
    const contexte = await avecPlafonds({ boutiques: 5 });
    await expect(
      new ShopService(contexte).create({ code: 'TMV', name: 'Tamatave' }),
    ).resolves.toBeTruthy();
  });

  it('laisse MODIFIER une boutique même au plafond', async () => {
    // Éditer le nom et l'adresse de sa propre boutique n'est pas une option
    // vendable : c'est ce qui s'imprime sur les tickets.
    const contexte = await avecPlafonds({ boutiques: 1 });
    await expect(
      new ShopService(contexte).update(fixture.shopA, {
        code: 'CENT',
        name: 'Boutique Centre-Ville',
        address: 'Analakely',
      }),
    ).resolves.not.toThrow();
  });

  it('refuse un compte de plus quand le plafond est atteint', async () => {
    const contexte = await avecPlafonds({ utilisateurs: 2 });
    const roles = await new RoleRepository(fixture.db).byCode('SELLER');
    await expect(
      new UserService(contexte).create(
        { shopId: fixture.shopA, fullName: 'Nouveau', login: 'nouveau', roleId: roles!.id },
        'MotDePasse-2026',
      ),
    ).rejects.toThrow(/autorise 2 compte/);
  });

  it('n’applique aucun plafond sans licence connue', async () => {
    // Installation initiale et épreuves : un contexte sans licence est celui
    // d'un poste en essai, où tout est ouvert.
    const contexte = await contextFor(fixture.db, fixture.adminId);
    expect(contexte.licence).toBeUndefined();
    await expect(
      new ShopService(contexte).create({ code: 'TMV', name: 'Tamatave' }),
    ).resolves.toBeTruthy();
  });

  it('lit un plafond absent comme « un seul »', async () => {
    // Le silence d'une clé se lit toujours dans le sens le plus prudent.
    const contexte = await avecPlafonds({});
    await expect(
      new ShopService(contexte).create({ code: 'TMV', name: 'Tamatave' }),
    ).rejects.toThrow(/autorise 1 boutique/);
  });
});

/* ─── Réglages du poste ────────────────────────────────────────────────── */

describe('réglages du poste', () => {
  /**
   * La clé primaire de `setting` est `(key, shop_id)`, et SQLite considère
   * deux NULL comme DISTINCTS : pour un réglage du poste, `ON CONFLICT` ne se
   * déclenchait jamais et chaque écriture ajoutait une ligne. On relisait la
   * première — donc la plus ancienne.
   *
   * Ce n'était pas cosmétique. Le cliquet d'horloge, réécrit à chaque
   * vérification de licence, n'avançait JAMAIS : reculer la date du poste
   * aurait prolongé indéfiniment une licence échue.
   */
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it('remplace la valeur au lieu d’en empiler une seconde', async () => {
    const reglages = new SettingRepository(fixture.db);
    await reglages.set(POSTE_KEYS.dateRatchet, '1000', null);
    await reglages.set(POSTE_KEYS.dateRatchet, '2000', null);
    await reglages.set(POSTE_KEYS.dateRatchet, '3000', null);

    expect(await reglages.raw(POSTE_KEYS.dateRatchet)).toBe('3000');
    const lignes = await fixture.db.select<{ total: number }>(
      'SELECT COUNT(*) AS total FROM setting WHERE key = ? AND shop_id = ?',
      [POSTE_KEYS.dateRatchet, POSTE],
    );
    expect(lignes[0]?.total).toBe(1);
  });

  it('fait avancer le cliquet d’horloge', async () => {
    const licences = new LicenceService(fixture.db);
    await licences.status(new Date().toISOString());
    const premier = Number(await new SettingRepository(fixture.db).raw(POSTE_KEYS.dateRatchet));
    expect(premier).toBeGreaterThan(0);

    await licences.status(new Date().toISOString());
    const second = Number(await new SettingRepository(fixture.db).raw(POSTE_KEYS.dateRatchet));
    expect(second).toBeGreaterThanOrEqual(premier);
  });

  it('efface vraiment une clé de licence', async () => {
    const licences = new LicenceService(fixture.db);
    await new SettingRepository(fixture.db).set(POSTE_KEYS.licenceKey, 'CLE-QUELCONQUE', null);
    await licences.clear();
    expect(await new SettingRepository(fixture.db).raw(POSTE_KEYS.licenceKey)).toBe('');
  });

  it('ne touche pas aux réglages d’une boutique', async () => {
    const reglages = new SettingRepository(fixture.db);
    await reglages.set('commerce.currency', { code: 'MGA' }, fixture.shopA);
    await reglages.set(POSTE_KEYS.dateRatchet, '1234', null);

    const boutique = await fixture.db.select<{ total: number }>(
      'SELECT COUNT(*) AS total FROM setting WHERE shop_id = ?',
      [fixture.shopA],
    );
    expect(boutique[0]?.total).toBe(1);
  });
});

describe('poste rattaché à une licence existante', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  /**
   * LE BESOIN : un commerçant licencié sur son ordinateur installe
   * l'application sur une tablette. C'est une installation neuve — sa propre
   * base, son propre code — mais il ne doit pas racheter une licence : le
   * produit déclare un quota « postes rattachés ».
   */
  /**
   * `emiseLe` recule la date d'émission plutôt que d'accepter une durée
   * négative : c'est ainsi qu'on obtient une clé réellement périmée, comme
   * celle d'un client qui n'a pas renouvelé.
   */
  const cleDe = async (
    code: string,
    emiseLe = new Date(),
    produit: Produit = BOUTIQUE,
    formule = 'standard',
  ) => {
    const { privee, publique } = await editeurDeTest();
    const emission = await emitLicence(
      produit,
      { code, nom: 'ARINA', formule, mois: 12 },
      privee,
      emiseLe,
    );
    return { cle: emission.cle, publique };
  };

  it('accepte la clé de l’ordinateur après rattachement', async () => {
    const codeOrdinateur = installationCode('ordinateur-du-client');
    const { cle, publique } = await cleDe(codeOrdinateur);
    const tablette = new LicenceService(fixture.db, publique);

    // Sans rattachement, la clé vise une autre installation.
    expect((await tablette.activate(cle)).state).toBe('autre-entreprise');
    expect(await tablette.rattachement()).toBeNull();

    // Le rattachement se fait en présentant la CLÉ, pas le code seul.
    expect((await tablette.rattacher(cle)).state).toBe('valide');
    expect(await tablette.rattachement()).toBe(codeOrdinateur);

    // Et il tient d'un démarrage à l'autre.
    const auDemarrage = new LicenceService(fixture.db, publique);
    expect((await auDemarrage.status(null)).state).toBe('valide');
  });

  it('rattache avec une clé périmée, et la montre périmée', async () => {
    // MÊME RÈGLE QUE SUR L'ORDINATEUR : une clé échue est une VRAIE licence,
    // et `activate` la conserve déjà pour que son échéance reste lisible. La
    // refuser ici laisserait le commerçant devant un rejet sans explication,
    // alors que ce qu'il doit lire, c'est « expirée le … ».
    const ilYaDeuxAns = new Date(Date.now() - 730 * 86_400_000);
    const { cle, publique } = await cleDe(installationCode('ordinateur-du-client'), ilYaDeuxAns);
    const tablette = new LicenceService(fixture.db, publique);

    const statut = await tablette.rattacher(cle);
    expect(statut.state).not.toBe('valide');
    expect(['expiree', 'grace']).toContain(statut.state);
    expect(await tablette.rattachement()).toBe(installationCode('ordinateur-du-client'));
  });

  it('ne rattache rien avec une clé d’un autre logiciel', async () => {
    const { cle, publique } = await cleDe(
      installationCode('x'),
      new Date(),
      CAISSE,
      'quincaillerie',
    );
    const tablette = new LicenceService(fixture.db, publique);

    expect((await tablette.rattacher(cle)).state).toBe('autre-produit');
    expect(await tablette.rattachement()).toBeNull();
  });

  it('ne rattache rien avec une clé trafiquée', async () => {
    const { cle, publique } = await cleDe(installationCode('ordinateur-du-client'));
    const tablette = new LicenceService(fixture.db, publique);

    expect((await tablette.rattacher(`${cle.slice(0, -4)}AAAA`)).state).toBe('invalide');
    expect(await tablette.rattachement()).toBeNull();
  });

  it('ne rattache rien avec une clé illisible', async () => {
    const tablette = new LicenceService(fixture.db, '');
    expect((await tablette.rattacher('ceci-n-est-pas-une-cle')).state).toBe('invalide');
    expect(await tablette.rattachement()).toBeNull();
  });

  it('revient à son propre code quand on le détache', async () => {
    const { cle, publique } = await cleDe(installationCode('ordinateur-du-client'));
    const tablette = new LicenceService(fixture.db, publique);
    await tablette.rattacher(cle);

    await tablette.detacher();
    expect(await tablette.rattachement()).toBeNull();
    // La clé part avec le rattachement : elle ne vaut plus pour ce poste, et
    // la garder ferait afficher un refus à chaque démarrage.
    expect((await tablette.status(null)).state).toBe('absente');
  });

  it('le rattachement ne voyage pas avec l’archive de portabilité', async () => {
    const { POSTE_KEYS: clefs } = await import('@/core/db/repositories/setting.repository');
    const { TABLES_EXPORTEES } = await import('@/core/services/portabilite.service');

    // `setting` est exporté, mais les réglages du POSTE en sont retirés un par
    // un : sans cela, copier une archive sur cinq machines les activerait
    // toutes les cinq.
    expect(TABLES_EXPORTEES as readonly string[]).toContain('setting');
    expect(Object.values(clefs)).toContain('licence.rattachement');
  });
});
