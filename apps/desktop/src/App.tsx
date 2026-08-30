import { Chargement, Erreur } from '@/components/ui/Page';
import { FournisseurNotifications } from '@/components/ui/Notifications';
import { FournisseurSession, useSession } from '@/app/session';
import { FournisseurNavigation } from '@/app/navigation';
import { Shell } from '@/app/Shell';
import { Connexion } from '@/features/auth/Connexion';
import { Installation } from '@/features/auth/Installation';

/**
 * Racine de l'application.
 *
 * Quatre états, et un seul écran par état : rien ne s'affiche à moitié. Une
 * panne au démarrage — base illisible, migration impossible — donne un message
 * explicite plutôt qu'un écran blanc : c'est le seul moment où l'utilisateur
 * n'a aucun moyen de deviner ce qui se passe.
 */
export default function App() {
  return (
    <FournisseurNotifications>
      <FournisseurSession>
        <Racine />
      </FournisseurSession>
    </FournisseurNotifications>
  );
}

function Racine() {
  const { etat } = useSession();

  switch (etat.phase) {
    case 'chargement':
      return (
        <div className="flex h-full items-center justify-center">
          <Chargement libelle="Ouverture de la base locale…" />
        </div>
      );
    case 'panne':
      return (
        <div className="flex h-full items-center justify-center p-8">
          <div className="max-w-lg space-y-3">
            <Erreur message={`L'application n'a pas pu démarrer : ${etat.message}`} />
            <p className="text-sm text-encre-600">
              Vérifiez que le dossier de données est accessible en écriture. Si le problème
              persiste, restaurez la dernière sauvegarde depuis le dossier « sauvegardes ».
            </p>
          </div>
        </div>
      );
    case 'installation':
      return <Installation />;
    case 'connexion':
      return <Connexion />;
    case 'pret':
      return (
        <FournisseurNavigation depart="tableau">
          <Shell />
        </FournisseurNavigation>
      );
  }
}
