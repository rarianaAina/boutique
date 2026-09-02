import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ALL_PERMISSIONS } from '@boutique/shared';
import App from '../App';
import '../styles/index.css';
import { setDb } from '@/core/db/client';
import { SetupService } from '@/core/services/setup.service';
import { SeedService } from '@/core/services/seed.service';
import { DEFAULT_SETTINGS, SettingRepository } from '@/core/db/repositories/setting.repository';
import { UserRepository } from '@/core/db/repositories/user.repository';
import { baseDApercu } from './executeur-sqljs';

/**
 * Aperçu de l'application dans un navigateur ordinaire.
 *
 * Sert à REGARDER : les écrans n'ont pas d'épreuves, et cette séance a montré
 * deux fois ce que coûte de les imaginer plutôt que de les voir. Ouvert à la
 * largeur d'un téléphone, cet aperçu dit tout de suite ce qui déborde.
 *
 * Il ne part jamais en production : la compilation ne connaît que
 * `index.html`, et ce fichier n'est atteignable que par `apercu.html`, que
 * seul le serveur de développement sert.
 */

const CODE = 'APER';
const LOGIN = 'apercu';
const MOT_DE_PASSE = 'Apercu!2026';

async function preparer(): Promise<void> {
  const db = await baseDApercu();
  setDb(db);

  await new SetupService(db).run({
    shopCode: CODE,
    shopName: 'Boutique Lovelec',
    address: 'Analamahitsy, Antananarivo',
    phone: '+261 34 12 345 67',
    adminFullName: 'Gérant',
    adminLogin: LOGIN,
    adminPassword: MOT_DE_PASSE,
  });

  const session = await new UserRepository(db).sessionFor(
    (await db.select<{ id: string }>('SELECT id FROM app_user LIMIT 1'))[0]?.id ?? '',
  );
  const boutique = (await db.select<{ id: string; code: string }>('SELECT id, code FROM shop'))[0];
  if (!session || !boutique) throw new Error('installation d’aperçu incomplète');

  // Des données de démonstration : un écran vide ne montre ni un tableau, ni
  // une pagination, ni ce qui déborde d'une colonne.
  await new SeedService({
    db,
    session: { ...session, permissions: [...ALL_PERMISSIONS] },
    shopId: boutique.id,
    shopCode: boutique.code,
    settings: DEFAULT_SETTINGS,
  }).run();

  // De quoi voir la facture complète : identifiants fiscaux, mentions,
  // conditions et signatures.
  const reglages = new SettingRepository(db);
  await db.execute('UPDATE shop SET nif = ?, stat = ? WHERE id = ?', [
    '3000123456',
    '47120 11 2019 0 12345',
    boutique.id,
  ]);
  await reglages.set(
    'facture.mentions',
    [{ libelle: 'RCS', valeur: 'Antananarivo 2019 B 00123' }],
    boutique.id,
  );
  await reglages.set(
    'facture.conditions',
    'Marchandise vendue non reprise après huit jours.',
    boutique.id,
  );
  await reglages.set('facture.afficher_signatures', true, boutique.id);
}

const conteneur = document.getElementById('root');
if (!conteneur) throw new Error('Élément #root introuvable');

void preparer().then(() => {
  createRoot(conteneur).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  // Les identifiants sont affichés plutôt que saisis d'office : l'écran de
  // connexion fait partie de ce qu'on vient regarder.
  // eslint-disable-next-line no-console
  console.info(`Aperçu prêt — identifiant « ${LOGIN} », mot de passe « ${MOT_DE_PASSE} »`);
});
