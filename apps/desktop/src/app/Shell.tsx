import { useEffect, useMemo, useState } from 'react';
import { Icone } from '@/components/ui/Icone';
import embleme from '@/assets/embleme.png';
import { Bouton } from '@/components/ui/Bouton';
import { Avertissement } from '@/components/ui/Page';
import { licenceBlocks } from '@boutique/shared';
import { Licence } from '@/features/gestion/Licence';
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
 * faire. Il en va autrement des modules NON ACHETÉS : ceux-là restent visibles,
 * marqués, parce qu'ils se vendent — les cacher reviendrait à cacher au client
 * ce qu'on a à lui proposer, et à lui faire croire que le logiciel ne sait pas
 * le faire.
 */
export function Shell() {
  const { session, shopName, shopCode, deconnecter, peut, ouvre, licence, incidents } =
    useSession();
  const { ecran, aller } = useNavigation();
  const [incidentsMasques, setIncidentsMasques] = useState(false);

  const groupes = useMemo(
    () =>
      NAVIGATION.map((groupe) => ({
        ...groupe,
        // Une entrée interdite est ABSENTE, pas grisée : un vendeur n'a pas à
        // voir la liste de ce qu'il ne peut pas faire.
        ecrans: groupe.ecrans
          .filter((entree) => peut(entree.permission))
          .map((entree) => ({
            ...entree,
            // Sans fonction déclarée, l'écran relève du noyau : toujours ouvert.
            vendu: entree.fonction === undefined || ouvre(entree.fonction),
          })),
      })).filter((groupe) => groupe.ecrans.length > 0),
    [peut, ouvre],
  );

  /* Raccourcis Alt+chiffre : le comptoir bascule au clavier entre la caisse,
     les tickets et le stock sans jamais lâcher le scanner. */
  useEffect(() => {
    const surTouche = (evenement: KeyboardEvent) => {
      if (!evenement.altKey || evenement.ctrlKey || evenement.metaKey) return;
      const cible = groupes
        .flatMap((groupe) => groupe.ecrans)
        .find((entree) => entree.raccourci === evenement.key && entree.vendu);
      if (cible) {
        evenement.preventDefault();
        aller(cible.cle);
      }
    };
    window.addEventListener('keydown', surTouche);
    return () => window.removeEventListener('keydown', surTouche);
  }, [groupes, aller]);

  /*
   * Poste bloqué : plus rien d'autre que l'écran d'activation.
   *
   * On ne laisse pas entrer « en lecture seule » : une caisse qu'on peut
   * encore consulter est une caisse qu'on continue d'utiliser, et l'échéance
   * ne serait jamais réglée. Les données, elles, restent intactes — l'écran le
   * dit, parce que c'est la première inquiétude du commerçant.
   */
  if (licenceBlocks(licence)) return <Licence pleinEcran />;

  return (
    <div className="flex h-full overflow-hidden bg-encre-100">
      <nav className="flex w-56 shrink-0 flex-col border-r border-encre-200 bg-white">
        <div className="flex items-center gap-2.5 border-b border-encre-200 px-4 py-3">
          {/* L'emblème seul, sans le nom de marque : le rail est étroit, et
              c'est le nom de LA BOUTIQUE qui doit y être lisible — c'est lui
              qui change d'un poste à l'autre. */}
          <img src={embleme} alt="" className="h-8 w-8 shrink-0 object-contain" />
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
                      vendu={entree.vendu}
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

        {licence.state === 'grace' ? (
          <div className="border-b border-alerte-200 px-5 py-2">
            <Avertissement>
              Licence échue le {licence.payload?.e ?? ''}. Tout fonctionne encore pendant{' '}
              {licence.graceLeft ?? 0} jour
              {(licence.graceLeft ?? 0) > 1 ? 's' : ''}, puis le poste se fermera. Rendez-vous dans
              « Paramètres » pour saisir la nouvelle clé.
            </Avertissement>
          </div>
        ) : null}

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
  vendu,
}: {
  actif: boolean;
  onClick: () => void;
  icone: Parameters<typeof Icone>[0]['nom'];
  titre: string;
  raccourci?: string;
  /** Le module est-il compris dans la licence du poste ? */
  vendu: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={actif ? 'page' : undefined}
      title={vendu ? undefined : `${titre} n’est pas compris dans votre licence.`}
      className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
        actif
          ? 'bg-marque-50 font-medium text-marque-800'
          : vendu
            ? 'text-encre-700 hover:bg-encre-100 hover:text-encre-900'
            : 'text-encre-400 hover:bg-encre-100'
      }`}
    >
      <span className={actif ? 'text-marque-600' : 'text-encre-400'}>
        <Icone nom={icone} taille={17} />
      </span>
      <span className="min-w-0 flex-1 truncate">{titre}</span>
      {/* Un module non acheté reste CLIQUABLE : l'écran expliquera ce qu'il
          fait et comment l'obtenir. Un bouton mort n'apprend rien à personne. */}
      {!vendu ? (
        <span className="shrink-0 text-encre-300" aria-label="Non compris dans la licence">
          <Icone nom="reglage" taille={13} />
        </span>
      ) : raccourci ? (
        <kbd className="shrink-0 text-[10px] font-medium text-encre-400">Alt{raccourci}</kbd>
      ) : null}
    </button>
  );
}
