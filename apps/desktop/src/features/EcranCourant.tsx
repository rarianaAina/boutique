import { Suspense, lazy } from 'react';
import { Chargement, Vide } from '@/components/ui/Page';
import { useNavigation } from '@/app/navigation';
import { useSession } from '@/app/session';
import { ecranParCle, type CleEcran } from '@/app/routes';

/**
 * Aiguillage des écrans.
 *
 * Les écrans sont chargés À LA DEMANDE : l'application démarre alors sur la
 * caisse ou le tableau de bord sans avoir compilé les rapports, l'import Excel
 * et l'administration. Sur un poste modeste, la différence se voit au premier
 * lancement de la journée.
 *
 * La permission est revérifiée ICI, et pas seulement dans le menu : une entrée
 * atteinte par un autre chemin — la recherche globale, un lien depuis une
 * fiche — doit être refusée de la même façon.
 */
const TableauDeBord = lazy(() =>
  import('./tableau/TableauDeBord').then((module) => ({ default: module.TableauDeBord })),
);
const Caisse = lazy(() => import('./caisse/Caisse').then((m) => ({ default: m.Caisse })));
const Tickets = lazy(() => import('./ventes/Tickets').then((m) => ({ default: m.Tickets })));
const Factures = lazy(() => import('./ventes/Factures').then((m) => ({ default: m.Factures })));
const Remboursements = lazy(() =>
  import('./ventes/Remboursements').then((m) => ({ default: m.Remboursements })),
);
const Echanges = lazy(() => import('./ventes/Echanges').then((m) => ({ default: m.Echanges })));
const Produits = lazy(() => import('./stock/Produits').then((m) => ({ default: m.Produits })));
const Appareils = lazy(() => import('./stock/Appareils').then((m) => ({ default: m.Appareils })));
const Mouvements = lazy(() =>
  import('./stock/Mouvements').then((m) => ({ default: m.Mouvements })),
);
const Inventaire = lazy(() =>
  import('./stock/Inventaire').then((m) => ({ default: m.Inventaire })),
);
const StockFaible = lazy(() =>
  import('./stock/StockFaible').then((m) => ({ default: m.StockFaible })),
);
const Fournisseurs = lazy(() =>
  import('./achats/Fournisseurs').then((m) => ({ default: m.Fournisseurs })),
);
const Achats = lazy(() => import('./achats/Achats').then((m) => ({ default: m.Achats })));
const Transferts = lazy(() =>
  import('./reseau/Transferts').then((m) => ({ default: m.Transferts })),
);
const Synchronisation = lazy(() =>
  import('./reseau/Synchronisation').then((m) => ({ default: m.Synchronisation })),
);
const Clients = lazy(() => import('./gestion/Clients').then((m) => ({ default: m.Clients })));
const Rapports = lazy(() => import('./gestion/Rapports').then((m) => ({ default: m.Rapports })));
const Import = lazy(() => import('./gestion/Import').then((m) => ({ default: m.Import })));
const Journal = lazy(() => import('./gestion/Journal').then((m) => ({ default: m.Journal })));
const Utilisateurs = lazy(() =>
  import('./gestion/Utilisateurs').then((m) => ({ default: m.Utilisateurs })),
);
const Boutiques = lazy(() => import('./gestion/Boutiques').then((m) => ({ default: m.Boutiques })));
const Prix = lazy(() => import('./gestion/Prix').then((m) => ({ default: m.Prix })));
const Parametres = lazy(() =>
  import('./gestion/Parametres').then((m) => ({ default: m.Parametres })),
);

export function EcranCourant({ cle }: { cle: CleEcran }) {
  const { parametre } = useNavigation();
  const { peut } = useSession();
  const description = ecranParCle(cle);

  // La permission d'ACCÈS est revérifiée ici, et pas seulement dans le menu :
  // un écran atteint par un autre chemin — la recherche globale, un lien depuis
  // une fiche — doit être refusé de la même façon.
  if (description && !peut(description.permission)) {
    return (
      <Vide
        icone="alerte"
        titre="Accès refusé"
        detail="Votre rôle ne donne pas accès à cet écran. Demandez la permission à un administrateur."
      />
    );
  }

  return (
    <Suspense fallback={<Chargement />}>
      <Ecran cle={cle} parametre={parametre ?? null} />
    </Suspense>
  );
}

function Ecran({ cle, parametre }: { cle: CleEcran; parametre: string | null }) {
  switch (cle) {
    case 'tableau':
      return <TableauDeBord />;
    case 'caisse':
      return <Caisse />;
    case 'tickets':
      return <Tickets parametre={parametre} />;
    case 'factures':
      return <Factures parametre={parametre} />;
    case 'remboursements':
      return <Remboursements />;
    case 'echanges':
      return <Echanges />;
    case 'produits':
      return <Produits parametre={parametre} />;
    case 'appareils':
      return <Appareils parametre={parametre} />;
    case 'mouvements':
      return <Mouvements />;
    case 'inventaire':
      return <Inventaire />;
    case 'stock-faible':
      return <StockFaible />;
    case 'fournisseurs':
      return <Fournisseurs parametre={parametre} />;
    case 'achats':
      return <Achats parametre={parametre} />;
    case 'transferts':
      return <Transferts parametre={parametre} />;
    case 'synchronisation':
      return <Synchronisation />;
    case 'clients':
      return <Clients parametre={parametre} />;
    case 'rapports':
      return <Rapports />;
    case 'import':
      return <Import />;
    case 'journal':
      return <Journal />;
    case 'utilisateurs':
      return <Utilisateurs />;
    case 'boutiques':
      return <Boutiques />;
    case 'prix':
      return <Prix />;
    case 'parametres':
      return <Parametres />;
    default:
      return <Vide titre="Écran inconnu" />;
  }
}
