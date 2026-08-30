import { useEffect, useMemo, useState } from 'react';
import { Icone } from '@/components/ui/Icone';
import { Bouton } from '@/components/ui/Bouton';
import { Avertissement } from '@/components/ui/Page';
import { NAVIGATION, type CleEcran } from './routes';
import { useNavigation } from './navigation';
import { useSession } from './session';
import { RechercheGlobale } from './RechercheGlobale';
import { EcranCourant } from '@/features/EcranCourant';

/**
 * Ossature de l'application : rail de navigation, barre supérieure, contenu.
 *
 * DEUX PARTIS PRIS.
 *
 * Le rail est TOUJOURS visible et ne se replie pas : une boutique travaille sur
 * un écran de bureau, et un menu qui apparaît au survol coûte un geste à chaque
 * changement d'écran, cinquante fois par jour.
 *
 * Les entrées auxquelles l'utilisateur n'a pas droit ne sont pas grisées, elles
 * sont ABSENTES : un vendeur n'a pas à voir la liste de ce qu'il ne peut pas
 * faire.
 */
export function Shell() {
  const { session, shopName, shopCode, deconnecter, peut, incidents } = useSession();
  const { ecran, aller } = useNavigation();
  const [incidentsMasques, setIncidentsMasques] = useState(false);

  const groupes = useMemo(
    () =>
      NAVIGATION.map((groupe) => ({
        ...groupe,
        ecrans: groupe.ecrans.filter((entree) => !entree.permission || peut(entree.permission)),
      })).filter((groupe) => groupe.ecrans.length > 0),
    [peut],
  );

  /* Raccourcis Alt+chiffre : le comptoir bascule au clavier entre la caisse,
     les tickets et le stock sans jamais lâcher le scanner. */
  useEffect(() => {
    const surTouche = (evenement: KeyboardEvent) => {
      if (!evenement.altKey || evenement.ctrlKey || evenement.metaKey) return;
      const cible = groupes
        .flatMap((groupe) => groupe.ecrans)
        .find((entree) => entree.raccourci === evenement.key);
      if (cible) {
        evenement.preventDefault();
        aller(cible.cle);
      }
    };
    window.addEventListener('keydown', surTouche);
    return () => window.removeEventListener('keydown', surTouche);
  }, [groupes, aller]);

  return (
    <div className="flex h-full overflow-hidden bg-encre-100">
      <nav className="flex w-56 shrink-0 flex-col border-r border-encre-200 bg-white">
        <div className="flex items-center gap-2.5 border-b border-encre-200 px-4 py-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-marque-700 text-white">
            <Icone nom="boite" taille={17} />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-encre-900">
              {shopName || 'Boutique'}
            </p>
            <p className="truncate text-xs text-encre-500">{shopCode}</p>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {groupes.map((groupe) => (
            <div key={groupe.titre || 'principal'} className="mb-2">
              {groupe.titre ? (
                <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-encre-400">
                  {groupe.titre}
                </p>
              ) : null}
              <ul className="space-y-0.5">
                {groupe.ecrans.map((entree) => (
                  <li key={entree.cle}>
                    <BoutonNavigation
                      actif={ecran === entree.cle}
                      onClick={() => aller(entree.cle)}
                      icone={entree.icone}
                      titre={entree.titre}
                      raccourci={entree.raccourci}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="border-t border-encre-200 px-3 py-2.5">
          <p className="truncate text-sm font-medium text-encre-800">{session?.fullName}</p>
          <p className="truncate text-xs text-encre-500">{session?.roleName}</p>
          <Bouton
            taille="petit"
            variante="discret"
            className="mt-1.5 w-full justify-start"
            onClick={() => void deconnecter()}
          >
            Se déconnecter
          </Bouton>
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-4 border-b border-encre-200 bg-white px-5 py-2.5">
          <RechercheGlobale />
          <div className="ml-auto text-xs text-encre-400">v{__APP_VERSION__}</div>
        </header>

        {incidents.length > 0 && !incidentsMasques ? (
          <div className="border-b border-alerte-200 px-5 py-2">
            <Avertissement>
              <div className="flex items-start justify-between gap-3">
                <ul className="list-disc space-y-0.5 pl-4">
                  {incidents.map((incident) => (
                    <li key={incident}>{incident}</li>
                  ))}
                </ul>
                <Bouton taille="petit" variante="discret" onClick={() => setIncidentsMasques(true)}>
                  Masquer
                </Bouton>
              </div>
            </Avertissement>
          </div>
        ) : null}

        <main className="min-h-0 flex-1 overflow-auto p-5">
          <EcranCourant cle={ecran as CleEcran} />
        </main>
      </div>
    </div>
  );
}

function BoutonNavigation({
  actif,
  onClick,
  icone,
  titre,
  raccourci,
}: {
  actif: boolean;
  onClick: () => void;
  icone: Parameters<typeof Icone>[0]['nom'];
  titre: string;
  raccourci?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={actif ? 'page' : undefined}
      className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
        actif
          ? 'bg-marque-50 font-medium text-marque-800'
          : 'text-encre-700 hover:bg-encre-100 hover:text-encre-900'
      }`}
    >
      <span className={actif ? 'text-marque-600' : 'text-encre-400'}>
        <Icone nom={icone} taille={17} />
      </span>
      <span className="min-w-0 flex-1 truncate">{titre}</span>
      {raccourci ? (
        <kbd className="shrink-0 text-[10px] font-medium text-encre-400">Alt{raccourci}</kbd>
      ) : null}
    </button>
  );
}
