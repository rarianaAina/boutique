import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { can, newId, type Permission, type SessionUser } from '@boutique/shared';
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
import { SetupService } from '@/core/services/setup.service';
import { BackupService } from '@/core/services/backup.service';
import type { AppContext } from '@/core/services/context';

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
  connecter: (login: string, motDePasse: string) => Promise<void>;
  deconnecter: () => Promise<void>;
  installer: (entree: Parameters<SetupService['run']>[0]) => Promise<void>;
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
          setEtat({ phase: 'installation' });
          return;
        }

        const boutique = await new ShopRepository(executeur).local();
        if (!boutique) {
          setEtat({ phase: 'installation' });
          return;
        }
        setShop({ id: boutique.id, code: boutique.code, name: boutique.name });
        setSettings(await new SettingRepository(executeur).load(boutique.id));
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

  const rechargerParametres = useCallback(async () => {
    if (!db || shop.id === '') return;
    setSettings(await new SettingRepository(db).load(shop.id));
  }, [db, shop.id]);

  const connecter = useCallback(
    async (login: string, motDePasse: string) => {
      if (!db) throw new Error('Base indisponible.');
      const { session: connectee } = await new AuthService(db).login(login, motDePasse);
      setSession(connectee);
      setShop({ id: connectee.shopId, code: connectee.shopCode, name: connectee.shopName });
      const chargees = await new SettingRepository(db).load(connectee.shopId);
      setSettings(chargees);
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
    [db],
  );

  const deconnecter = useCallback(async () => {
    if (db && session) await new AuthService(db).logout(session);
    setSession(null);
    setEtat({ phase: 'connexion' });
  }, [db, session]);

  const installer = useCallback(
    async (entree: Parameters<SetupService['run']>[0]) => {
      if (!db) throw new Error('Base indisponible.');
      await new SetupService(db).run(entree);
      const boutique = await new ShopRepository(db).local();
      if (boutique) {
        setShop({ id: boutique.id, code: boutique.code, name: boutique.name });
        setSettings(await new SettingRepository(db).load(boutique.id));
      }
      setEtat({ phase: 'connexion' });
    },
    [db],
  );

  const contexte = useMemo<AppContext | null>(
    () => (db && session ? { db, session, shopId: shop.id, shopCode: shop.code, settings } : null),
    [db, session, shop.id, shop.code, settings],
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
      rechargerParametres,
      incidents,
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
