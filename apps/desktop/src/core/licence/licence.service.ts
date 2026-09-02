import {
  BOUTIQUE,
  LICENCE_PUBLIC_KEY,
  type LicenceStatus,
  decodeLicence,
  judgeClock,
  newId,
  trialStatus,
  verifyLicence,
} from '@boutique/shared';
import type { SqlExecutor } from '../db/client';
import { POSTE_KEYS, SettingRepository } from '../db/repositories/setting.repository';

/**
 * Activation du poste (§35).
 *
 * Tout se joue LOCALEMENT : la clé est vérifiée par signature, l'échéance
 * comparée à une date protégée d'un cliquet. Aucun appel réseau, jamais — une
 * boutique sans Internet doit ouvrir comme les autres, et c'est la promesse du
 * logiciel entier.
 *
 * Ce service ne DÉCIDE de rien : il rapporte un état. C'est l'interface qui
 * choisit d'avertir ou de fermer, et ce partage compte — il n'existe qu'un seul
 * endroit où l'on bloque, et il est visible.
 */
export class LicenceService {
  private readonly settings: SettingRepository;

  /**
   * `publicKeySpki` n'est fourni QUE par les épreuves.
   *
   * La vraie clé publique de l'éditeur reste la valeur par défaut : aucun
   * appelant de l'application n'en passe une autre, et le jour où quelqu'un
   * s'y essaierait, cela se verrait à la relecture. Sans cette ouverture, les
   * refus les plus importants — clé d'un autre logiciel, clé d'une autre
   * installation — ne seraient éprouvables qu'avec la clé privée de l'éditeur,
   * qui ne se trouve dans aucun dépôt.
   */
  constructor(
    db: SqlExecutor,
    private readonly publicKeySpki: string = LICENCE_PUBLIC_KEY,
  ) {
    this.settings = new SettingRepository(db);
  }

  /**
   * Identifiant d'installation de ce poste.
   *
   * Tiré au premier démarrage et jamais retouché : c'est de lui que dérive le
   * code que le commerçant dicte au téléphone, et chaque clé émise porte ce
   * code. Le régénérer invaliderait la licence d'un client parfaitement en
   * règle.
   *
   * Il n'est PAS l'identifiant de la boutique locale, bien que ce fût tentant :
   * une boutique se supprime, se renomme, cède sa place à une autre quand le
   * commerce déménage. Le poste, lui, reste le poste.
   */
  async installation(): Promise<string> {
    const existant = await this.settings.raw(POSTE_KEYS.installation);
    if (existant && existant.trim() !== '') return existant;

    const neuf = newId();
    await this.settings.set(POSTE_KEYS.installation, neuf, null);
    // On rend la valeur écrite plutôt que de la relire : les écritures sont
    // différées, une relecture immédiate ne verrait rien.
    return neuf;
  }

  /**
   * État de l'activation de ce poste.
   *
   * L'ordre est délibéré : une clé saisie l'emporte toujours sur la période
   * d'essai, y compris si elle est expirée. Sinon un commerçant dont la clé a
   * expiré retomberait dans un essai qu'il a déjà consommé, et le blocage
   * n'arriverait jamais.
   */
  async status(installedAt: string | null): Promise<LicenceStatus> {
    const now = await this.trustedNow();
    const cle = await this.settings.raw(POSTE_KEYS.licenceKey);

    if (cle && cle.trim() !== '') {
      return verifyLicence(cle, {
        publicKeySpki: this.publicKeySpki,
        produit: BOUTIQUE,
        companyId: await this.installation(),
        codeInstallation: (await this.rattachement()) ?? undefined,
        now,
      });
    }
    if (installedAt) return trialStatus(installedAt, BOUTIQUE, now);

    // Ni clé ni date d'installation : le poste n'est pas encore installé, il
    // n'y a rien à activer.
    return { state: 'absente', payload: null, daysLeft: null, graceLeft: null };
  }

  /**
   * Enregistre une clé après l'avoir vérifiée.
   *
   * Une clé refusée n'est PAS conservée : garder une clé invalide ferait
   * afficher son motif de refus à chaque démarrage, sans que personne puisse
   * s'en défaire. Une clé ÉCHUE, en revanche, est conservée — c'est une vraie
   * licence, et son échéance doit rester lisible pour la renouveler.
   */
  async activate(cle: string): Promise<LicenceStatus> {
    const now = await this.trustedNow();
    const statut = await verifyLicence(cle, {
      publicKeySpki: this.publicKeySpki,
      produit: BOUTIQUE,
      companyId: await this.installation(),
      codeInstallation: (await this.rattachement()) ?? undefined,
      now,
    });

    if (
      statut.state === 'invalide' ||
      statut.state === 'autre-entreprise' ||
      statut.state === 'autre-produit'
    ) {
      return statut;
    }

    await this.settings.set(POSTE_KEYS.licenceKey, cle.replace(/\s+/g, ''), null);
    return statut;
  }

  /**
   * Code d'installation auquel ce poste est rattaché, s'il l'est.
   *
   * `null` dans le cas ordinaire : le poste vit sur sa propre licence.
   */
  async rattachement(): Promise<string | null> {
    const brut = await this.settings.raw(POSTE_KEYS.licenceAdoptee);
    return brut && brut.trim() !== '' ? brut.trim() : null;
  }

  /**
   * Rattache ce poste à la licence d'un autre, en présentant cette licence.
   *
   * CE QU'IL FAUT POSSÉDER, C'EST LA CLÉ. Le code d'installation, lui,
   * s'affiche en clair sur l'écran d'activation et se dicte au téléphone : le
   * demander seul reviendrait à distribuer des licences à qui a entendu douze
   * signes. La clé est signée, et seul le client la détient.
   *
   * On ne rattache donc pas d'abord pour vérifier ensuite : on vérifie la clé
   * telle qu'elle est, en se présentant sous le code QU'ELLE NOMME. Une clé
   * illisible, trafiquée ou émise pour un autre logiciel ne rattache rien.
   *
   * Une clé ÉCHUE, en revanche, rattache — et s'affiche comme échue. C'est la
   * règle que suit déjà `activate` sur l'ordinateur : une clé expirée est une
   * vraie licence, et la refuser laisserait le commerçant devant un rejet sans
   * explication, alors que ce qu'il doit lire est « expirée le … ».
   */
  async rattacher(cle: string): Promise<LicenceStatus> {
    const charge = decodeLicence(cle.replace(/\s+/g, ''));
    if (!charge) {
      return {
        state: 'invalide',
        payload: null,
        daysLeft: null,
        graceLeft: null,
        reason: 'Clé illisible : vérifiez qu’elle a été copiée en entier.',
      };
    }

    const statut = await verifyLicence(cle, {
      publicKeySpki: this.publicKeySpki,
      produit: BOUTIQUE,
      companyId: await this.installation(),
      codeInstallation: charge.payload.c,
      now: await this.trustedNow(),
    });

    if (
      statut.state === 'invalide' ||
      statut.state === 'autre-entreprise' ||
      statut.state === 'autre-produit'
    ) {
      return statut;
    }

    await this.settings.set(POSTE_KEYS.licenceAdoptee, charge.payload.c, null);
    await this.settings.set(POSTE_KEYS.licenceKey, cle.replace(/\s+/g, ''), null);
    return statut;
  }

  /** Détache ce poste : il revient à son propre code d'installation. */
  async detacher(): Promise<void> {
    await this.settings.set(POSTE_KEYS.licenceAdoptee, '', null);
    await this.settings.set(POSTE_KEYS.licenceKey, '', null);
  }

  async clear(): Promise<void> {
    await this.settings.set(POSTE_KEYS.licenceKey, '', null);
  }

  /**
   * Date de référence, à l'abri d'une horloge trafiquée — dans les deux sens.
   *
   * Le cliquet est relu et réécrit à chaque interrogation : reculer l'horloge
   * ne prolonge rien, et un bond invraisemblable vers l'avant n'empoisonne pas
   * la valeur retenue. Le second cas est le plus dangereux : une pile morte
   * bloquerait définitivement un commerçant en règle, même après réparation.
   */
  private async trustedNow(): Promise<number> {
    const brut = await this.settings.raw(POSTE_KEYS.dateRatchet);
    const cliquet = brut === null || brut === '' ? null : Number(brut);
    const verdict = judgeClock(Date.now(), cliquet);

    if (verdict.ratchet !== cliquet) {
      await this.settings.set(POSTE_KEYS.dateRatchet, String(verdict.ratchet), null);
    }
    return verdict.effective;
  }

  /** Vrai si l'horloge du poste paraît fausse : à signaler, sans rien bloquer. */
  async clockLooksWrong(): Promise<boolean> {
    const brut = await this.settings.raw(POSTE_KEYS.dateRatchet);
    if (brut === null || brut === '') return false;
    return judgeClock(Date.now(), Number(brut)).suspect;
  }
}
