import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  can,
  installationCode,
  licenceAllows,
  newId,
  type FonctionBoutique,
  type LicenceStatus,
  type Permission,
  type SessionUser,
} from '@boutique/shared';
import { getDb, type SqlExecutor } from '@/core/db/client';
import { runStartupMaintenance } from '@/core/db/startup';
import { ShopRepository } from '@/core/db/repositories/shop.repository';
import { META_KEYS, MetaRepository } from '@/core/db/repositories/meta.repository';
import {
  DEFAULT_SETTINGS,
  SettingRepository,
  type ShopSettings,
} from '@/core/db/repositories/setting.repository';
import { AuthService } from '@/core/services/auth.service';
import { SessionGardee } from '@/core/services/session-gardee';
import { SetupService } from '@/core/services/setup.service';
import { BackupService } from '@/core/services/backup.service';
import { LicenceService } from '@/core/licence/licence.service';
import type { AppContext } from '@/core/services/context';

/**
 * État de départ, avant que la base ait pu répondre.
 *
 * « Absente » et non « valide » : tant qu'on ne sait pas, on ne suppose pas que
 * le poste est activé. L'écran de démarrage passe de toute façon avant.
 */
const LICENCE_INCONNUE: LicenceStatus = {
  state: 'absente',
  payload: null,
  daysLeft: null,
  graceLeft: null,
};

/** Refus qui ne doit PAS devenir l'état affiché du poste. */
function refusee(statut: LicenceStatus): boolean {
  return (
    statut.state === 'invalide' ||
    statut.state === 'autre-entreprise' ||
    statut.state === 'autre-produit'
  );
}

/**
 * État global de l'application : base, boutique, session, paramètres.
 *
 * UN SEUL fournisseur, et il produit le `AppContext` que consomment tous les
 * services. Les écrans n'assemblent jamais ce contexte eux-mêmes — c'est ce qui
 * garantit qu'aucun d'eux ne travaille sur une autre boutique que celle du
 * poste, l'erreur la plus coûteuse d'un logiciel multi-sites.
 */

export type EtatDemarrage =
  | { phase: 'chargement' }
  | { phase: 'installation' }
  | { phase: 'connexion' }
  | { phase: 'pret' }
  | { phase: 'panne'; message: string };

interface ValeurSession {
  etat: EtatDemarrage;
  db: SqlExecutor | null;
  session: SessionUser | null;
  settings: ShopSettings;
  shopId: string;
  shopCode: string;
  shopName: string;
  deviceId: string;
  /** Contexte prêt à passer à un service. Null tant que personne n'est connecté. */
  contexte: AppContext | null;
  peut: (permission: Permission) => boolean;
  /** État de l'activation du poste. */
  licence: LicenceStatus;
  /** Code d'installation à dicter pour obtenir une clé. */
  codeInstallation: string;
  /**
   * La licence a-t-elle été JUGÉE ?
   *
   * « Absente » avait deux sens qu'il ne fallait pas confondre : « ce poste
   * n'a pas de clé » et « on ne le sait pas encore ». Bloquer sur le second
   * fermait un poste tout juste installé, avant même d'avoir regardé.
   */
  licenceEvaluee: boolean;
  /**
   * La licence ouvre-t-elle cette fonction ?
   *
   * Distinct de `peut` : un droit se règle chez le client, une fonction
   * s'achète. Les confondre ferait chercher un réglage qui n'existe pas.
   */
  ouvre: (fonction: FonctionBoutique) => boolean;
  activerLicence: (cle: string) => Promise<LicenceStatus>;
  rechargerLicence: () => Promise<void>;
  connecter: (login: string, motDePasse: string) => Promise<void>;
  deconnecter: () => Promise<void>;
  /** Rend la clé de secours, à montrer UNE FOIS : elle n'existera plus après. */
  installer: (entree: Parameters<SetupService['run']>[0]) => Promise<string>;
  terminerInstallation: () => void;
  rechargerParametres: () => Promise<void>;
  /** Incident non bloquant relevé au démarrage (sauvegarde impossible, etc.). */
  incidents: string[];
}

const Contexte = createContext<ValeurSession | null>(null);

export function FournisseurSession({ children }: { children: ReactNode }) {
  const [etat, setEtat] = useState<EtatDemarrage>({ phase: 'chargement' });
  const [db, setDb] = useState<SqlExecutor | null>(null);
  const [session, setSession] = useState<SessionUser | null>(null);
  const [settings, setSettings] = useState<ShopSettings>(DEFAULT_SETTINGS);
  const [shop, setShop] = useState({ id: '', code: '', name: '' });
  const [deviceId, setDeviceId] = useState('');
  const [incidents, setIncidents] = useState<string[]>([]);
  const [licence, setLicence] = useState<LicenceStatus>(LICENCE_INCONNUE);
  const [licenceEvaluee, setLicenceEvaluee] = useState(false);
  const [codeInstallation, setCodeInstallation] = useState('');
  /** Date d'installation du poste, origine de la période d'essai. */
  const [installeLe, setInstalleLe] = useState<string | null>(null);

  /* ─── Démarrage ─────────────────────────────────────────────────────────
     La base est ouverte, l'entretien passe, puis on décide de l'écran : une
     base neuve va à l'installation, une base prête au formulaire de connexion.
     Une panne ici est affichée telle quelle — mieux vaut un message explicite
     qu'un écran blanc devant un client. */
  useEffect(() => {
    let annule = false;

    (async () => {
      try {
        const executeur = await getDb();
        if (annule) return;
        setDb(executeur);

        const rapport = await runStartupMaintenance(executeur);
        if (rapport.problems.length > 0) setIncidents(rapport.problems);

        const meta = new MetaRepository(executeur);
        let poste = await meta.get(META_KEYS.deviceId);
        if (!poste) {
          poste = newId();
          await meta.set(META_KEYS.deviceId, poste);
        }
        if (annule) return;
        setDeviceId(poste);

        if (await new SetupService(executeur).needsSetup()) {
          // Le code d'installation existe AVANT la boutique : c'est celui du
          // poste. Le charger ici évite de le voir manquer sur l'écran
          // d'activation si l'installation tourne court.
          await chargerLicence(executeur, null);
          setEtat({ phase: 'installation' });
          return;
        }

        const boutique = await new ShopRepository(executeur).local();
        if (!boutique) {
          setEtat({ phase: 'installation' });
          return;
        }
        setShop({ id: boutique.id, code: boutique.code, name: boutique.name });
        const reglages = await new SettingRepository(executeur).load(boutique.id);
        setSettings(reglages);

        // La licence est jugée AVANT la connexion : un poste échu doit le dire
        // à qui l'ouvre, pas après que quelqu'un a saisi son mot de passe.
        await chargerLicence(executeur, boutique.createdAt);
        if (annule) return;

        // Session gardée : on ferme et rouvre le logiciel plusieurs fois par
        // jour, et ressaisir un mot de passe devant un client qui attend finit
        // par se régler d'une mauvaise façon. Elle n'est reprise que si elle
        // vaut encore — voir `SessionGardee`, qui refuse dans tous les cas
        // douteux.
        const reprise = await new SessionGardee(executeur).reprendre();
        if (annule) return;
        if (reprise) {
          setSession(reprise);
          setEtat({ phase: 'pret' });
          return;
        }

        setEtat({ phase: 'connexion' });
      } catch (cause) {
        if (annule) return;
        setEtat({
          phase: 'panne',
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    })();

    return () => {
      annule = true;
    };
  }, []);

  /**
   * Charge le code d'installation et l'état de la licence.
   *
   * APPELÉE PAR TOUS LES CHEMINS D'ENTRÉE, et c'est tout l'objet de cette
   * fonction. Elle ne vivait que dans la branche « poste déjà installé » du
   * démarrage : sur un poste NEUF, on passait par l'installation puis par la
   * connexion sans jamais la traverser. L'état restait « absente » — donc
   * bloquant — et le code d'installation restait vide, ce qui affichait des
   * points de suspension à la place des douze signes qu'il faut dicter.
   *
   * Le symptôme était déroutant : le poste s'ouvrait normalement au deuxième
   * lancement, puisque le démarrage prenait alors l'autre branche.
   */
  const chargerLicence = useCallback(async (executeur: SqlExecutor, installeeLe: string | null) => {
    const licences = new LicenceService(executeur);
    // Le code d'abord : il ne dépend ni d'une boutique ni d'une date, et
    // c'est lui qu'on doit pouvoir dicter même quand tout le reste échoue.
    setCodeInstallation(installationCode(await licences.installation()));
    setInstalleLe(installeeLe);
    setLicence(await licences.status(installeeLe));
    setLicenceEvaluee(true);
  }, []);

  const rechargerLicence = useCallback(async () => {
    if (!db) return;
    await chargerLicence(db, installeLe);
  }, [db, installeLe, chargerLicence]);

  const activerLicence = useCallback(
    async (cle: string) => {
      if (!db) throw new Error('Base indisponible.');
      const statut = await new LicenceService(db).activate(cle);
      // On ne retient à l'écran que ce qui a été ENREGISTRÉ : afficher un refus
      // comme s'il était l'état du poste ferait croire à un blocage définitif.
      if (!refusee(statut)) setLicence(statut);
      return statut;
    },
    [db],
  );

  const rechargerParametres = useCallback(async () => {
    if (!db || shop.id === '') return;
    setSettings(await new SettingRepository(db).load(shop.id));
  }, [db, shop.id]);

  const connecter = useCallback(
    async (login: string, motDePasse: string) => {
      if (!db) throw new Error('Base indisponible.');
      const { session: connectee } = await new AuthService(db).login(login, motDePasse);
      setSession(connectee);
      // Relue à chaque connexion : la période d'essai s'écoule, et une clé
      // saisie sur un autre poste de la même boutique change la donne.
      await chargerLicence(
        db,
        installeLe ?? (await new ShopRepository(db).local())?.createdAt ?? null,
      );
      setShop({ id: connectee.shopId, code: connectee.shopCode, name: connectee.shopName });
      const chargees = await new SettingRepository(db).load(connectee.shopId);
      setSettings(chargees);
      // Retenue APRÈS le chargement des réglages : c'est la boutique qui fixe
      // la durée, et zéro jour veut dire « redemander à chaque ouverture ».
      await new SessionGardee(db).retenir(connectee, chargees.sessionDays);
      setEtat({ phase: 'pret' });

      // La sauvegarde quotidienne est déclenchée APRÈS la connexion, une fois
      // les paramètres connus, et n'empêche jamais d'entrer : un disque plein
      // est un incident à signaler, pas une raison de bloquer un comptoir.
      try {
        await new BackupService({
          db,
          session: connectee,
          shopId: connectee.shopId,
          shopCode: connectee.shopCode,
          settings: chargees,
        }).runIfDue();
      } catch (cause) {
        setIncidents((precedent) => [
          ...precedent,
          `Sauvegarde automatique impossible : ${cause instanceof Error ? cause.message : String(cause)}`,
        ]);
      }
    },
    [db, chargerLicence, installeLe],
  );

  const deconnecter = useCallback(async () => {
    // La session gardée est effacée D'ABORD : si la journalisation de la
    // déconnexion échouait, on ne voudrait pas que la session survive à un
    // départ explicite.
    if (db) await new SessionGardee(db).oublier();
    if (db && session) await new AuthService(db).logout(session);
    setSession(null);
    setEtat({ phase: 'connexion' });
  }, [db, session]);

  const installer = useCallback(
    async (entree: Parameters<SetupService['run']>[0]) => {
      if (!db) throw new Error('Base indisponible.');
      const { cleSecours } = await new SetupService(db).run(entree);
      const boutique = await new ShopRepository(db).local();
      if (boutique) {
        setShop({ id: boutique.id, code: boutique.code, name: boutique.name });
        setSettings(await new SettingRepository(db).load(boutique.id));
        // SANS CECI, le poste tout juste installé s'ouvrait sur « poste non
        // activé » : la période d'essai n'avait pas encore été calculée.
        await chargerLicence(db, boutique.createdAt);
      }
      // La bascule vers la connexion est faite par l'écran, APRÈS que la clé
      // de secours a été montrée et reconnue : elle n'existe plus ensuite.
      return cleSecours;
    },
    [db, chargerLicence],
  );

  /** Passe à la connexion, une fois l'installation acquittée. */
  const terminerInstallation = useCallback(() => setEtat({ phase: 'connexion' }), []);

  const contexte = useMemo<AppContext | null>(
    () =>
      db && session
        ? { db, session, shopId: shop.id, shopCode: shop.code, settings, licence }
        : null,
    [db, session, shop.id, shop.code, settings, licence],
  );

  const valeur = useMemo<ValeurSession>(
    () => ({
      etat,
      db,
      session,
      settings,
      shopId: shop.id,
      shopCode: shop.code,
      shopName: shop.name,
      deviceId,
      contexte,
      licence,
      codeInstallation,
      licenceEvaluee,
      ouvre: (fonction: FonctionBoutique) => licenceAllows(licence, fonction),
      activerLicence,
      rechargerLicence,
      peut: (permission: Permission) =>
        can(
          session
            ? {
                userId: session.id,
                shopId: session.shopId,
                roleCode: session.roleCode,
                permissions: session.permissions,
              }
            : null,
          permission,
        ),
      connecter,
      deconnecter,
      installer,
      terminerInstallation,
      rechargerParametres,
      incidents,
    }),
    [
      etat,
      db,
      session,
      settings,
      shop,
      deviceId,
      contexte,
      connecter,
      deconnecter,
      installer,
      terminerInstallation,
      rechargerParametres,
      incidents,
      licence,
      codeInstallation,
      licenceEvaluee,
      activerLicence,
      rechargerLicence,
    ],
  );

  return <Contexte.Provider value={valeur}>{children}</Contexte.Provider>;
}

export function useSession(): ValeurSession {
  const valeur = useContext(Contexte);
  if (!valeur) throw new Error('useSession hors de son fournisseur');
  return valeur;
}

/**
 * Contexte de service, garanti non nul.
 *
 * À n'appeler que dans les écrans rendus une fois la session ouverte — c'est
 * le cas de tous ceux du shell. Cela évite un `contexte!` ou un test de
 * nullité dans chaque écran.
 */
export function useContexte(): AppContext {
  const { contexte } = useSession();
  if (!contexte) throw new Error('Aucune session ouverte');
  return contexte;
}
