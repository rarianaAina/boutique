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
  const {
    session,
    shopName,
    shopCode,
    deconnecter,
    peut,
    ouvre,
    licence,
    licenceEvaluee,
    incidents,
  } = useSession();
  const { ecran, aller } = useNavigation();
  const [incidentsMasques, setIncidentsMasques] = useState(false);
  /** Tiroir de navigation, sur les écrans trop étroits pour un rail fixe. */
  const [tiroir, setTiroir] = useState(false);

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
   * `licenceEvaluee` n'est pas une précaution superflue : sans elle, on
   * bloquait sur l'état de DÉPART — « absente » — c'est-à-dire avant d'avoir
   * seulement regardé. Un poste tout juste installé s'ouvrait donc sur son
   * propre écran de blocage, sans même le code à dicter.
   *
   * On ne laisse pas entrer « en lecture seule » : une caisse qu'on peut
   * encore consulter est une caisse qu'on continue d'utiliser, et l'échéance
   * ne serait jamais réglée. Les données, elles, restent intactes — l'écran le
   * dit, parce que c'est la première inquiétude du commerçant.
   */
  if (licenceEvaluee && licenceBlocks(licence)) return <Licence pleinEcran />;

  return (
    <div className="flex h-full overflow-hidden bg-encre-100">
      {/*
        LE RAIL DE NAVIGATION SUR UN TÉLÉPHONE.
        
        Il mesure 224 points. Sur un écran de 390, il ne laissait que 166
        points à l'application : chaque mot du tableau de bord se coupait en
        deux, et aucune mesure de débordement ne l'aurait signalé — la mise en
        page s'écrase, elle ne déborde pas. Il fallait la regarder.
        
        En dessous de `lg`, il devient donc un tiroir qu'on ouvre, posé
        PAR-DESSUS le contenu, et le contenu retrouve la largeur entière.
      */}
      {tiroir ? (
        <button
          type="button"
          aria-label="Fermer le menu"
          className="fixed inset-0 z-30 bg-encre-900/40 lg:hidden"
          onClick={() => setTiroir(false)}
        />
      ) : null}

      <nav
        className={`z-40 flex w-56 shrink-0 flex-col border-r border-encre-200 bg-white max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:transition-transform ${
          tiroir ? 'max-lg:translate-x-0' : 'max-lg:-translate-x-full'
        }`}
      >
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
                      onClick={() => {
                        aller(entree.cle);
                        // Le tiroir se referme derrière soi : sur un
                        // téléphone, le laisser ouvert masquerait l'écran
                        // qu'on vient de demander.
                        setTiroir(false);
                      }}
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
        <header className="flex shrink-0 items-center gap-3 border-b border-encre-200 bg-white px-3 py-2.5 lg:gap-4 lg:px-5">
          {/* Le seul moyen d'atteindre la navigation quand le rail est caché. */}
          <button
            type="button"
            aria-label="Ouvrir le menu"
            className="-ml-1 rounded-md p-2 text-encre-700 hover:bg-encre-100 lg:hidden"
            onClick={() => setTiroir(true)}
          >
            <Icone nom="menu" taille={20} />
          </button>
          <RechercheGlobale />
          <div className="ml-auto hidden text-xs text-encre-400 lg:block">v{__APP_VERSION__}</div>
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
